/*
 * Family Tree viewer
 *
 * The JSON format is the one produced by gramps_to_json.py:
 * {
 *   "people": [...],
 *   "families": [
 *     {"id":"F1", "father":"I1", "mother":"I2", "children":["I3"]}
 *   ]
 * }
 *
 * The layout is deliberately calculated here instead of delegated to a generic
 * graph layout. That lets us keep partners on the same generation and children
 * directly below their parents.
 */

const S = {
  people: new Map(),
  families: new Map(),
  cy: null,
  focusId: null,
  generationSpan: 3,
  showAll: false,
  treeCatalog: [],
  currentTree: null,
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[c]));

const dates = p => [p.birth, p.death].filter(Boolean).join(" – ");

function birthYear(p) {
  if (!p || !p.birth) return Infinity;
  const m = String(p.birth).match(/-?\d{1,4}/);
  return m ? Number(m[0]) : Infinity;
}

function unique(a) {
  return [...new Set(a.filter(Boolean))];
}

function familyParents(f) {
  return unique([f.father, f.mother, ...(f.parents || [])])
    .filter(id => S.people.has(id));
}

function familyChildren(f) {
  return unique(f.children || []).filter(id => S.people.has(id));
}

function parentFamilies(personId) {
  return [...S.families.values()].filter(f => familyChildren(f).includes(personId));
}

function childFamilies(personId) {
  return [...S.families.values()].filter(f => familyParents(f).includes(personId));
}

function partnersOf(personId) {
  const result = [];
  for (const f of childFamilies(personId)) {
    familyParents(f).forEach(id => { if (id !== personId) result.push(id); });
  }
  return unique(result);
}

function childrenOf(personId) {
  return unique(childFamilies(personId).flatMap(familyChildren));
}

function parentsOf(personId) {
  return unique(parentFamilies(personId).flatMap(familyParents)
    .filter(id => id !== personId));
}

function findDefaultRoot() {
  // Prefer the oldest person who has descendants. This makes the initial view
  // look like a traditional tree rather than centering on an isolated record.
  const candidates = [...S.people.values()].filter(p => childrenOf(p.id).length);
  return (candidates.length ? candidates : [...S.people.values()])
    .sort((a, b) => birthYear(a) - birthYear(b))[0]?.id || null;
}

/*
 * Build a focused genealogy around one person.
 * Negative generations are ancestors, 0 is the focus, positive generations
 * are descendants. Spouses are always pulled into the same generation.
 */
function buildVisibleTree(focusId) {
  const generation = new Map([[focusId, 0]]);
  const queue = [focusId];

  while (queue.length) {
    const id = queue.shift();
    const g = generation.get(id);

    // A family with only one known parent is perfectly valid here.
    for (const parent of parentsOf(id)) {
      if ((S.showAll || Math.abs(g - 1) <= S.generationSpan) && !generation.has(parent)) {
        generation.set(parent, g - 1);
        queue.push(parent);
      }
    }

    for (const child of childrenOf(id)) {
      if ((S.showAll || Math.abs(g + 1) <= S.generationSpan) && !generation.has(child)) {
        generation.set(child, g + 1);
        queue.push(child);
      }
    }

    for (const partner of partnersOf(id)) {
      if ((S.showAll || Math.abs(g) <= S.generationSpan) && !generation.has(partner)) {
        generation.set(partner, g);
        queue.push(partner);
      }
    }
  }

  // Stabilise the graph so relationships reached through a spouse are also
  // visible. This is especially important for spouse -> parents branches.
  for (let pass = 0; pass < 4; pass++) {
    for (const [id, g] of [...generation]) {
      for (const partner of partnersOf(id)) {
        if (!generation.has(partner) && (S.showAll || Math.abs(g) <= S.generationSpan)) {
          generation.set(partner, g);
        }
      }

      for (const child of childrenOf(id)) {
        if (!generation.has(child) && (S.showAll || Math.abs(g + 1) <= S.generationSpan)) {
          generation.set(child, g + 1);
        }
      }

      for (const parent of parentsOf(id)) {
        if (!generation.has(parent) && (S.showAll || Math.abs(g - 1) <= S.generationSpan)) {
          generation.set(parent, g - 1);
        }
      }
    }
  }

  // In Show All mode, include every record in the selected JSON.
  // Normally the view is intentionally focused around one person.
  if (S.showAll) {
    for (const id of S.people.keys()) {
      if (!generation.has(id)) generation.set(id, 0);
    }
  }

  const people = [...generation.keys()];
  const visible = new Set(people);

  // Keep a family when it has a visible parent/child relationship OR when it
  // represents a couple. The latter keeps childless couples visible.
  const families = [...S.families.values()].filter(f => {
    const ps = familyParents(f).filter(id => visible.has(id));
    const cs = familyChildren(f).filter(id => visible.has(id));

    return (
      (ps.length > 0 && cs.length > 0) ||
      ps.length >= 2
    );
  });

  return { generation, people, families };
}

/*
 * FAMILY-BLOCK / BARYCENTRIC LAYOUT
 *
 * The tree is not laid out as a simple list of people per generation.
 *
 * Instead:
 *
 *   1. Families are treated as the primary layout units.
 *   2. Spouses stay together as one horizontal block.
 *   3. Siblings stay together as one child block.
 *   4. Each family block gets a desired horizontal position based on
 *      the positions of its connected families.
 *   5. Several barycentric/median passes reduce crossings.
 *   6. Blocks are finally packed without breaking spouse/sibling groups.
 *
 * This is deliberately tolerant of incomplete Gramps data:
 *
 *   - one known parent
 *   - two known parents
 *   - childless couples
 *   - spouses with their own parents
 *   - people belonging to several families
 */

function calculatePositions(tree) {
  const { generation, people, families } = tree;

  const positions = new Map();

  const NODE_WIDTH = 200;
    const SPOUSE_GAP = 30;
    const SIBLING_GAP = 30;
    const FAMILY_GAP = 25;
    const GAP_Y = 150;

  const visible = new Set(people);

  // ------------------------------------------------------------
  // 1. Build normalised family records
  // ------------------------------------------------------------

  const infos = families
    .map(f => ({
      id: f.id,
      family: f,

      parents: familyParents(f)
        .filter(id => visible.has(id)),

      children: familyChildren(f)
        .filter(id => visible.has(id)),
    }))
    .filter(f =>
      f.parents.length > 0 ||
      f.children.length > 0
    );

  const familyById = new Map(
    infos.map(f => [f.id, f])
  );

  // ------------------------------------------------------------
  // 2. Person <-> family indexes
  // ------------------------------------------------------------

  const familiesAsParent = new Map();
  const familiesAsChild = new Map();
  const personFamilies = new Map();

  function addTo(map, key, value) {
    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(value);
  }

  for (const f of infos) {
    for (const parent of f.parents) {
      addTo(familiesAsParent, parent, f);
      addTo(personFamilies, parent, f);
    }

    for (const child of f.children) {
      addTo(familiesAsChild, child, f);
      addTo(personFamilies, child, f);
    }
  }

  // ------------------------------------------------------------
  // 3. Generation helpers
  // ------------------------------------------------------------

  function personY(id) {
    const g = generation.get(id) ?? 0;
    return g * GAP_Y;
  }

  function familyGeneration(f) {
    const values = [
      ...f.parents.map(id => generation.get(id)),
      ...f.children.map(id => generation.get(id)),
    ].filter(Number.isFinite);

    if (!values.length) {
      return 0;
    }

    return Math.min(...values);
  }

  // ------------------------------------------------------------
  // 4. Spouse groups
  // ------------------------------------------------------------
  //
  // A person can have several partners.
  //
  // We therefore don't use one global "partnerPair" map. Instead we
  // construct spouse groups for each family. This avoids accidentally
  // replacing one partner when a person appears in several families.

  const spouseGroups = new Map();

  for (const f of infos) {
    if (f.parents.length < 2) {
      continue;
    }

    for (const parent of f.parents) {
      if (!spouseGroups.has(parent)) {
        spouseGroups.set(parent, new Set());
      }

      for (const other of f.parents) {
        if (other !== parent) {
          spouseGroups.get(parent).add(other);
        }
      }
    }
  }

  // ------------------------------------------------------------
  // 5. Build family blocks
  // ------------------------------------------------------------
  //
  // A family block is:
  //
  //       [parent] [parent]
  //              |
  //        child child child
  //
  // The children themselves are treated as slots. Their own descendant
  // family is considered when calculating the width of that slot.
  //

  const personWidthMemo = new Map();
  const familyWidthMemo = new Map();

  const personStack = new Set();
  const familyStack = new Set();

  function coupleWidth(parents) {
    if (!parents.length) {
      return NODE_WIDTH;
    }

    return (
      parents.length * NODE_WIDTH +
      Math.max(0, parents.length - 1) * SPOUSE_GAP
    );
  }

  function personWidth(id) {
  // A person occupies one node slot.
  // Their descendants are handled by their own family rows.
  return NODE_WIDTH;
}


function familyWidth(f) {
  if (familyWidthMemo.has(f.id)) {
    return familyWidthMemo.get(f.id);
  }

  const parentWidth =
    f.parents.length * NODE_WIDTH +
    Math.max(0, f.parents.length - 1) * SPOUSE_GAP;

  let childrenWidth = 0;

  if (f.children.length) {
    childrenWidth =
      f.children.length * NODE_WIDTH +
      Math.max(0, f.children.length - 1) * SIBLING_GAP;
  }

  const width = Math.max(parentWidth, childrenWidth);

  familyWidthMemo.set(f.id, width);

  return width;
}

  // ------------------------------------------------------------
  // 6. Connected family components
  // ------------------------------------------------------------
  //
  // Families are connected when they share a person.
  //
  // This is important because:
  //
  //   parents -> child -> spouse -> spouse's parents
  //
  // must be treated as one structural component.

  const familyNeighbours = new Map();

  for (const f of infos) {
    familyNeighbours.set(f.id, new Set());
  }

  for (const f of infos) {
    const connectedPeople = [
      ...f.parents,
      ...f.children,
    ];

    for (const person of connectedPeople) {
      const related = personFamilies.get(person) || [];

      for (const other of related) {
        if (other.id !== f.id) {
          familyNeighbours
            .get(f.id)
            .add(other.id);
        }
      }
    }
  }

  const components = [];
  const visitedFamilies = new Set();

  for (const f of infos) {
    if (visitedFamilies.has(f.id)) {
      continue;
    }

    const component = [];
    const queue = [f.id];

    visitedFamilies.add(f.id);

    while (queue.length) {
      const id = queue.shift();
      const current = familyById.get(id);

      if (!current) {
        continue;
      }

      component.push(current);

      for (const neighbour of familyNeighbours.get(id) || []) {
        if (!visitedFamilies.has(neighbour)) {
          visitedFamilies.add(neighbour);
          queue.push(neighbour);
        }
      }
    }

    components.push(component);
  }

  // ------------------------------------------------------------
  // 7. Initial family ordering
  // ------------------------------------------------------------
  //
  // Sort families primarily by generation.
  // Within a generation use the birth year of their parents as a
  // deterministic initial ordering.
  //

  function familyBirthKey(f) {
    const years = f.parents
      .map(id => birthYear(S.people.get(id)))
      .filter(Number.isFinite);

    if (!years.length) {
      return Infinity;
    }

    return Math.min(...years);
  }

  for (const component of components) {
    component.sort((a, b) => {
      const ga = familyGeneration(a);
      const gb = familyGeneration(b);

      if (ga !== gb) {
        return ga - gb;
      }

      return familyBirthKey(a) - familyBirthKey(b);
    });
  }

  // ------------------------------------------------------------
  // 8. Create person order per generation
  // ------------------------------------------------------------

  const levels = new Map();

  for (const id of people) {
    const g = generation.get(id) ?? 0;

    if (!levels.has(g)) {
      levels.set(g, []);
    }

    levels.get(g).push(id);
  }

  const sortedGenerations = [...levels.keys()]
    .sort((a, b) => a - b);

  // ------------------------------------------------------------
  // 9. Initial ordering based on family structure
  // ------------------------------------------------------------

  function relatedFamilyScore(id) {
    const related = personFamilies.get(id) || [];

    if (!related.length) {
      return Infinity;
    }

    const values = related.map(f => {
      const childYears = f.children
        .map(c => birthYear(S.people.get(c)))
        .filter(Number.isFinite);

      const parentYears = f.parents
        .map(p => birthYear(S.people.get(p)))
        .filter(Number.isFinite);

      return [
        ...parentYears,
        ...childYears,
      ];
    }).flat();

    return values.length
      ? Math.min(...values)
      : Infinity;
  }

  for (const g of sortedGenerations) {
    const ids = levels.get(g);

    ids.sort((a, b) => {
      const sa = relatedFamilyScore(a);
      const sb = relatedFamilyScore(b);

      if (sa !== sb) {
        return sa - sb;
      }

      return String(
        S.people.get(a)?.name || ""
      ).localeCompare(
        String(S.people.get(b)?.name || "")
      );
    });
  }

  // ------------------------------------------------------------
  // 10. Convert family relationships into ordering constraints
  // ------------------------------------------------------------
  //
  // For each person we calculate the people they should remain near:
  //
  //   - parents
  //   - children
  //   - spouses
  //
  // The barycentric passes below use these relationships to improve
  // horizontal ordering.

  const neighbours = new Map();

  for (const id of people) {
    neighbours.set(id, new Set());
  }

  for (const f of infos) {
    for (const parent of f.parents) {
      for (const child of f.children) {
        neighbours.get(parent)?.add(child);
        neighbours.get(child)?.add(parent);
      }
    }

    for (let i = 0; i < f.parents.length; i++) {
      for (let j = i + 1; j < f.parents.length; j++) {
        neighbours.get(f.parents[i])?.add(f.parents[j]);
        neighbours.get(f.parents[j])?.add(f.parents[i]);
      }
    }
  }

  // ------------------------------------------------------------
  // 11. Barycentric ordering
  // ------------------------------------------------------------
  //
  // Repeatedly reorder each generation according to the median position
  // of connected people in neighbouring generations.
  //
  // Median rather than average is intentional: one very large branch
  // should not pull an entire family across the tree.

  function currentIndex(id, g) {
    const level = levels.get(g) || [];
    return level.indexOf(id);
  }

  function neighbourIndices(id, g) {
    const result = [];

    for (const neighbour of neighbours.get(id) || []) {
      if (generation.get(neighbour) !== g) {
        continue;
      }

      const index = currentIndex(
        neighbour,
        g
      );

      if (index >= 0) {
        result.push(index);
      }
    }

    return result;
  }

  function median(values) {
    if (!values.length) {
      return Infinity;
    }

    const sorted = [...values].sort(
      (a, b) => a - b
    );

    const middle = Math.floor(
      sorted.length / 2
    );

    if (sorted.length % 2) {
      return sorted[middle];
    }

    return (
      sorted[middle - 1] +
      sorted[middle]
    ) / 2;
  }

  function barycentricKey(id, direction) {
    const g = generation.get(id) ?? 0;
    const targetGeneration =
      direction === "up"
        ? g - 1
        : g + 1;

    const values = [];

    for (const neighbour of neighbours.get(id) || []) {
      if (
        generation.get(neighbour) ===
        targetGeneration
      ) {
        const index = currentIndex(
          neighbour,
          targetGeneration
        );

        if (index >= 0) {
          values.push(index);
        }
      }
    }

    return median(values);
  }

  // ------------------------------------------------------------
  // 12. Keep spouses together during ordering
  // ------------------------------------------------------------

  function buildSpouseBlocks(ids, g) {
    const remaining = new Set(ids);
    const blocks = [];

    while (remaining.size) {
      const first = remaining.values().next().value;
      remaining.delete(first);

      const block = [first];

      const relatedSpouses =
        spouseGroups.get(first) || new Set();

      for (const spouse of relatedSpouses) {
        if (
          remaining.has(spouse) &&
          generation.get(spouse) === g
        ) {
          block.push(spouse);
          remaining.delete(spouse);
        }
      }

      blocks.push(block);
    }

    return blocks;
  }

  function blockBarycenter(block, direction) {
    const values = [];

    for (const id of block) {
      const value =
        barycentricKey(id, direction);

      if (Number.isFinite(value)) {
        values.push(value);
      }
    }

    return values.length
      ? median(values)
      : Infinity;
  }

  // ------------------------------------------------------------
  // 13. Repeated median sweeps
  // ------------------------------------------------------------

  for (let pass = 0; pass < 8; pass++) {

    // Top -> bottom
    for (const g of sortedGenerations) {
      if (g === sortedGenerations[0]) {
        continue;
      }

      const ids = levels.get(g);

      const blocks = buildSpouseBlocks(
        ids,
        g
      );

      blocks.sort((a, b) => {
        const ka =
          blockBarycenter(a, "up");

        const kb =
          blockBarycenter(b, "up");

        if (ka !== kb) {
          return ka - kb;
        }

        return ids.indexOf(a[0]) -
          ids.indexOf(b[0]);
      });

      levels.set(
        g,
        blocks.flat()
      );
    }

    // Bottom -> top
    for (
      let i = sortedGenerations.length - 1;
      i >= 0;
      i--
    ) {
      const g = sortedGenerations[i];

      if (
        i ===
        sortedGenerations.length - 1
      ) {
        continue;
      }

      const ids = levels.get(g);

      const blocks = buildSpouseBlocks(
        ids,
        g
      );

      blocks.sort((a, b) => {
        const ka =
          blockBarycenter(a, "down");

        const kb =
          blockBarycenter(b, "down");

        if (ka !== kb) {
          return ka - kb;
        }

        return ids.indexOf(a[0]) -
          ids.indexOf(b[0]);
      });

      levels.set(
        g,
        blocks.flat()
      );
    }
  }

  // ------------------------------------------------------------
  // 14. Build family blocks from the final generation ordering
  // ------------------------------------------------------------

  const familyOrder = new Map();

  for (const f of infos) {
    const indices = [];

    for (const parent of f.parents) {
      const g = generation.get(parent);

      if (g === undefined) {
        continue;
      }

      const index = currentIndex(
        parent,
        g
      );

      if (index >= 0) {
        indices.push(index);
      }
    }

    for (const child of f.children) {
      const g = generation.get(child);

      if (g === undefined) {
        continue;
      }

      const index = currentIndex(
        child,
        g
      );

      if (index >= 0) {
        indices.push(index);
      }
    }

    familyOrder.set(
      f.id,
      indices.length
        ? median(indices)
        : Infinity
    );
  }

  // ------------------------------------------------------------
  // 15. Determine horizontal positions
  // ------------------------------------------------------------

  const levelX = new Map();

  for (const g of sortedGenerations) {
    const ids = levels.get(g);

    let cursor = 0;

    for (const id of ids) {
      const width = personWidth(id);

      levelX.set(id, {
        left: cursor,
        center: cursor + width / 2,
        width,
      });

      cursor += width + SIBLING_GAP;
    }
  }

  // ------------------------------------------------------------
  // 16. Calculate initial person positions
  // ------------------------------------------------------------

  for (const g of sortedGenerations) {
    const ids = levels.get(g);

    for (const id of ids) {
      const info = levelX.get(id);

      if (!info) {
        continue;
      }

      positions.set(id, {
        x: info.center,
        y: personY(id),
      });
    }
  }

    // ------------------------------------------------------------
  // 17. FAMILY UNITS
  // ------------------------------------------------------------
  //
  // A family unit is a person together with their spouse(s)
  // on the same generation.
  //
  // Example:
  //
  //   [Orm][Maike]   <- one unit
  //   [Astrid]       <- one unit
  //   [Lars][Anna]   <- one unit
  //
  // These units are never split when centering or resolving
  // collisions.
  // ------------------------------------------------------------

  function getSpouseIds(id, g) {
    const result = [];

    const spouses =
      spouseGroups.get(id) ||
      new Set();

    for (const spouse of spouses) {
      if (
        spouse !== id &&
        positions.has(spouse) &&
        generation.get(spouse) === g
      ) {
        result.push(spouse);
      }
    }

    return result;
  }

  function makePersonUnit(id, g) {
    const ids = [id];

    for (const spouse of getSpouseIds(id, g)) {
      if (!ids.includes(spouse)) {
        ids.push(spouse);
      }
    }

    // Keep deterministic ordering.
    ids.sort((a, b) => {
      if (a === id) return -1;
      if (b === id) return 1;
      return String(a).localeCompare(String(b));
    });

    return ids;
  }

  function unitWidth(unit) {
    if (!unit.length) {
      return 0;
    }

    return (
      unit.length * NODE_WIDTH +
      (unit.length - 1) * SPOUSE_GAP
    );
  }

  function unitCenter(unit) {
    const valid = unit.filter(
      id => positions.has(id)
    );

    if (!valid.length) {
      return null;
    }

    return (
      valid.reduce(
        (sum, id) =>
          sum + positions.get(id).x,
        0
      ) / valid.length
    );
  }

  function unitBounds(unit) {
    const valid = unit.filter(
      id => positions.has(id)
    );

    if (!valid.length) {
      return {
        left: 0,
        right: 0,
        center: 0,
        width: 0
      };
    }

    const xs = valid.map(
      id => positions.get(id).x
    );

    return {
      left:
        Math.min(...xs) -
        NODE_WIDTH / 2,

      right:
        Math.max(...xs) +
        NODE_WIDTH / 2,

      center:
        (
          Math.min(...xs) +
          Math.max(...xs)
        ) / 2,

      width:
        Math.max(...xs) -
        Math.min(...xs) +
        NODE_WIDTH
    };
  }

  function moveUnit(unit, delta) {
    for (const id of unit) {
      if (!positions.has(id)) {
        continue;
      }

      positions.get(id).x += delta;
    }
  }


  // ------------------------------------------------------------
  // 18. Build family child units
  // ------------------------------------------------------------

  function childUnits(f, g) {
    const result = [];
    const seen = new Set();

    for (const child of f.children) {
      if (
        !positions.has(child) ||
        generation.get(child) !== g ||
        seen.has(child)
      ) {
        continue;
      }

      const unit = makePersonUnit(child, g);

      for (const id of unit) {
        seen.add(id);
      }

      result.push(unit);
    }

    return result;
  }


  // ------------------------------------------------------------
  // 19. Place spouse units internally
  // ------------------------------------------------------------
  //
  // This replaces the old "place spouses next to each other"
  // code.
  //
  // We do NOT reposition individual parents anymore.
  // Instead every couple is treated as one horizontal unit.
  // ------------------------------------------------------------

  for (const g of sortedGenerations) {
    const ids = levels.get(g) || [];
    const processed = new Set();

    for (const id of ids) {
      if (processed.has(id)) {
        continue;
      }

      const unit =
        makePersonUnit(id, g);

      if (!unit.length) {
        continue;
      }

      for (const member of unit) {
        processed.add(member);
      }

      const existingCenter =
        unitCenter(unit);

      if (existingCenter === null) {
        continue;
      }

      const width =
        unitWidth(unit);

      let x =
        existingCenter -
        width / 2;

      for (const member of unit) {
        positions.get(member).x =
          x + NODE_WIDTH / 2;

        x +=
          NODE_WIDTH +
          SPOUSE_GAP;
      }
    }
  }


  // ------------------------------------------------------------
  // 20. Center children underneath their parents
  // ------------------------------------------------------------
  //
  // IMPORTANT:
  //
  // We center the COMPLETE CHILD ROW, not each child.
  //
  // This means:
  //
  //        Parent A ─ Parent B
  //                 │
  //        [child+spouse] [child] [child+spouse]
  //
  // is centered as one group.
  // ------------------------------------------------------------

  function familyParentCenter(f) {
    const parents =
      f.parents.filter(
        id => positions.has(id)
      );

    if (!parents.length) {
      return null;
    }

    const xs =
      parents.map(
        id => positions.get(id).x
      );

    return (
      Math.min(...xs) +
      Math.max(...xs)
    ) / 2;
  }

  function centerFamilyChildren(f) {
    const parents =
      f.parents.filter(
        id => positions.has(id)
      );

    if (!parents.length) {
      return;
    }

    const g =
      generation.get(
        f.children.find(
          id => positions.has(id)
        )
      );

    if (g === undefined) {
      return;
    }

    const units =
      childUnits(f, g);

    if (!units.length) {
      return;
    }

    const parentCenter =
      familyParentCenter(f);

    if (parentCenter === null) {
      return;
    }

    // Sort according to their current position.
    units.sort(
      (a, b) =>
        unitCenter(a) -
        unitCenter(b)
    );

    let totalWidth = 0;

    for (let i = 0; i < units.length; i++) {
      totalWidth +=
        unitWidth(units[i]);

      if (i < units.length - 1) {
        totalWidth += SIBLING_GAP;
      }
    }

    let cursor =
      parentCenter -
      totalWidth / 2;

    for (const unit of units) {
      const width =
        unitWidth(unit);

      const center =
        cursor + width / 2;

      const current =
        unitCenter(unit);

      if (current !== null) {
        moveUnit(
          unit,
          center - current
        );
      }

      cursor +=
        width +
        SIBLING_GAP;
    }
  }


  // Multiple passes allow changes higher in the tree to
  // propagate down into later generations.
  for (let pass = 0; pass < 20; pass++) {
    for (const f of infos) {
      centerFamilyChildren(f);
    }
  }


  // ------------------------------------------------------------
  // 21. Collision resolution
  // ------------------------------------------------------------
  //
  // Build independent spouse units for each generation.
  //
  // We deliberately do NOT merge all siblings into one block.
  // Each child family-unit can move independently while the
  // family row remains centered.
  // ------------------------------------------------------------

  function generationUnits(g) {
    const ids =
      levels.get(g) || [];

    const units = [];
    const used = new Set();

    for (const id of ids) {
      if (used.has(id)) {
        continue;
      }

      const unit =
        makePersonUnit(id, g);

      for (const member of unit) {
        used.add(member);
      }

      units.push(unit);
    }

    units.sort(
      (a, b) =>
        unitBounds(a).center -
        unitBounds(b).center
    );

    return units;
  }


  function resolveGenerationCollisions(g) {
    const units =
      generationUnits(g);

    for (let i = 1; i < units.length; i++) {
      const previous =
        unitBounds(units[i - 1]);

      const current =
        unitBounds(units[i]);

      const requiredGap =
        SIBLING_GAP;

      const overlap =
        previous.right +
        requiredGap -
        current.left;

      if (overlap > 0) {
        moveUnit(
          units[i],
          overlap
        );
      }
    }
  }


  // Resolve collisions several times because moving one
  // family can affect the relationship with another family.
  for (let pass = 0; pass < 6; pass++) {
    for (const g of sortedGenerations) {
      resolveGenerationCollisions(g);
    }
  }


  // ------------------------------------------------------------
  // 22. Re-center family rows after collision handling
  // ------------------------------------------------------------
  //
  // Collision handling may have moved a child family sideways.
  // Pull the complete child row back toward its parents.
  //
  // We use a limited correction so that neighboring families
  // don't immediately collide again.
  // ------------------------------------------------------------

  for (let pass = 0; pass < 3; pass++) {
    for (const f of infos) {
      const parents =
        f.parents.filter(
          id => positions.has(id)
        );

      if (!parents.length) {
        continue;
      }

      const g =
        generation.get(
          f.children.find(
            id => positions.has(id)
          )
        );

      if (g === undefined) {
        continue;
      }

      const units =
        childUnits(f, g);

      if (!units.length) {
        continue;
      }

      const parentCenter =
        familyParentCenter(f);

      if (parentCenter === null) {
        continue;
      }

      const left =
        Math.min(
          ...units.map(
            u => unitBounds(u).left
          )
        );

      const right =
        Math.max(
          ...units.map(
            u => unitBounds(u).right
          )
        );

      const childrenCenter =
        (left + right) / 2;

      let delta =
        parentCenter -
        childrenCenter;

      // Small corrections only.
      delta =
        Math.max(
          -25,
          Math.min(25, delta)
        );

      for (const unit of units) {
        moveUnit(
          unit,
          delta
        );
      }
    }

    // Make sure the correction didn't create collisions.
    for (const g of sortedGenerations) {
      resolveGenerationCollisions(g);
    }
  }


  // ------------------------------------------------------------
  // 23. Unconnected people
  // ------------------------------------------------------------

  let fallbackX = 0;

  for (const id of people) {
    if (positions.has(id)) {
      continue;
    }

    positions.set(id, {
      x: fallbackX,
      y: personY(id)
    });

    fallbackX +=
      NODE_WIDTH +
      SIBLING_GAP;
  }


  // ------------------------------------------------------------
  // 24. Final global centering
  // ------------------------------------------------------------
  //
  // Use actual node edges, not just node centres.
  // ------------------------------------------------------------

  if (positions.size) {
    let minX = Infinity;
    let maxX = -Infinity;

    for (const position of positions.values()) {
      minX = Math.min(
        minX,
        position.x -
          NODE_WIDTH / 2
      );

      maxX = Math.max(
        maxX,
        position.x +
          NODE_WIDTH / 2
      );
    }

    const centerX =
      (minX + maxX) / 2;

    for (const position of positions.values()) {
      position.x -= centerX;
    }
  }

  return positions;
}

function makeElements(tree, positions) {
  const elements = [];
  const visible = new Set(tree.people);

  for (const id of tree.people) {
    const p = S.people.get(id);
    elements.push({
      data: {
        id,
        type: "person",
        label: p.name + (dates(p) ? `\n${dates(p)}` : ""),
      },
      position: positions.get(id),
    });
  }

  // Tiny family junctions make connector routing predictable without exposing
  // a distracting "family" box to the user.
  for (const f of tree.families) {
    const ps = familyParents(f).filter(id => visible.has(id));
    const cs = familyChildren(f).filter(id => visible.has(id));
    if (!ps.length || !cs.length) continue;

    const pX = ps.reduce((sum, id) => sum + positions.get(id).x, 0) / ps.length;
    const pY = ps.reduce((sum, id) => sum + positions.get(id).y, 0) / ps.length;
    const cY = Math.min(...cs.map(id => positions.get(id).y));
    const familyY = pY + (cY - pY) * 0.48;

    elements.push({
      data: { id: `family-${f.id}`, type: "family" },
      position: { x: pX, y: familyY },
    });

    ps.forEach(parent => {
      elements.push({
        data: {
          id: `parent-${f.id}-${parent}`,
          source: parent,
          target: `family-${f.id}`,
          type: "family-edge",
        },
      });
    });

    cs.forEach(child => {
      elements.push({
        data: {
          id: `child-${f.id}-${child}`,
          source: `family-${f.id}`,
          target: child,
          type: "family-edge",
        },
      });
    });
  }

  // Partner connectors are separate from parent/child connectors and stay
  // horizontal between spouses.
  const seenPairs = new Set();
  for (const f of tree.families) {
    const ps = familyParents(f).filter(id => visible.has(id));
    if (ps.length < 2) continue;
    const pairKey = [...ps].sort().join("|");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    for (let i = 0; i < ps.length - 1; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        elements.push({
          data: {
            id: `partner-${pairKey}-${i}-${j}`,
            source: ps[i],
            target: ps[j],
            type: "partner-edge",
          },
        });
      }
    }
  }

  return elements;
}

function renderTree(focusId, fit = true) {
  if (!S.people.has(focusId)) return;
  S.focusId = focusId;

  const tree = buildVisibleTree(focusId);
  const positions = calculatePositions(tree);
  const elements = makeElements(tree, positions);

  if (S.cy) S.cy.destroy();

  S.cy = cytoscape({
    container: document.getElementById("cy"),
    elements,
    minZoom: 0.08,
    maxZoom: 4,
    wheelSensitivity: 0.15,
    layout: { name: "preset", fit: false },
    style: [
      {
        selector: 'node[type="person"]',
        style: {
          shape: "round-rectangle",
          "background-color": "#fff",
          "border-width": 1,
          "border-color": "#8d98a5",
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": 155,
          "font-size": 12,
          color: "#20252a",
          "text-valign": "center",
          "text-halign": "center",
          width: 160,
          height: 54,
          padding: 6,
        },
      },
      {
        selector: 'node[type="family"]',
        style: {
          shape: "ellipse",
          "background-color": "#7b8794",
          width: 5,
          height: 5,
          opacity: 0.01,
          events: "no-events",
        },
      },
      {
        selector: 'edge[type="family-edge"]',
        style: {
          width: 1.5,
          "line-color": "#98a2ad",
          "target-arrow-shape": "none",
          "curve-style": "taxi",
          "taxi-direction": "vertical",
          "taxi-turn": "50%",
          "taxi-turn-min-distance": 15,
        },
      },
      {
        selector: 'edge[type="partner-edge"]',
        style: {
          width: 2,
          "line-color": "#66717d",
          "target-arrow-shape": "none",
          "curve-style": "straight",
        },
      },
      { selector: ".dim", style: { opacity: 0.15 } },
      { selector: ".match", style: { "border-width": 4, "border-color": "#2563eb" } },
      { selector: ".selected", style: { "border-width": 4, "border-color": "#16a34a" } },
    ],
  });

  S.cy.on("tap", 'node[type="person"]', e => focusPerson(e.target.id));

  const focus = S.cy.getElementById(focusId);
  focus.addClass("selected");

  if (fit) {
    setTimeout(() => S.cy.fit(S.cy.nodes('[type="person"]'), 70), 20);
  }

  updateStats(tree);
  show(focusId, false);
}

function updateStats(tree) {
  const generations = new Set(tree.people.map(id => tree.generation.get(id))).size;
  const treeName = S.currentTree?.name ? ` · ${S.currentTree.name}` : "";
  const mode = S.showAll ? " · all generations" : "";
  document.getElementById("stats").textContent =
    `${S.people.size} people · ${S.families.size} families · showing ${tree.people.length} people · ${generations} generations${mode}${treeName}`;
}

function focusPerson(id) {
  if (!S.people.has(id)) return;
  renderTree(id, true);
}

function zoom(f) {
  if (!S.cy) return;
  S.cy.zoom({
    level: S.cy.zoom() * f,
    renderedPosition: { x: S.cy.width() / 2, y: S.cy.height() / 2 },
  });
}

function relationList(ids) {
  return unique(ids)
    .map(id => S.people.get(id))
    .filter(Boolean)
    .sort((a, b) => birthYear(a) - birthYear(b))
    .map(p => `<span class="link" data-id="${esc(p.id)}">${esc(p.name)}</span>`)
    .join("");
}

function show(id, open = true) {
  const p = S.people.get(id);
  if (!p) return;

  if (S.cy) {
    S.cy.elements().removeClass("selected");
    const node = S.cy.getElementById(id);
    if (node.length) node.addClass("selected");
  }

  const parents = parentsOf(id);
  const partners = partnersOf(id);
  const children = childrenOf(id);

  const places = [];
  if (p.birthPlace) places.push(`<div>Born: ${esc(p.birthPlace)}</div>`);
  if (p.deathPlace) places.push(`<div>Died: ${esc(p.deathPlace)}</div>`);

  document.getElementById("detailsContent").innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div>${esc(dates(p))}</div>
    ${p.gender ? `<div>Gender: ${esc(p.gender)}</div>` : ""}
    ${places.join("")}
    ${relationList(parents) ? `<h3>Parents</h3>${relationList(parents)}` : ""}
    ${relationList(partners) ? `<h3>Partners</h3>${relationList(partners)}` : ""}
    ${relationList(children) ? `<h3>Children</h3>${relationList(children)}` : ""}
    <div class="focus-actions">
      <button type="button" id="focusHere">Center on this person</button>
    </div>
  `;

  document.querySelectorAll(".link").forEach(x => {
    x.onclick = () => focusPerson(x.dataset.id);
  });

  const focusButton = document.getElementById("focusHere");
  if (focusButton) focusButton.onclick = () => focusPerson(id);

  if (open) document.getElementById("details").classList.remove("hidden");
}

function search(q) {
  if (!S.cy) return;
  S.cy.elements().removeClass("dim match");

  const box = document.getElementById("results");
  if (!q) {
    box.classList.add("hidden");
    return;
  }

  const lower = q.toLowerCase();
  const matches = [...S.people.values()]
    .filter(p => [p.name, p.givenName, p.surname, p.birth, p.death]
      .filter(Boolean)
      .some(v => String(v).toLowerCase().includes(lower)))
    .sort((a, b) => birthYear(a) - birthYear(b))
    .slice(0, 50);

  S.cy.nodes('[type="person"]').addClass("dim");

  matches.forEach(p => {
    const node = S.cy.getElementById(p.id);
    if (node.length) node.removeClass("dim").addClass("match");
  });

  box.innerHTML = matches.length
    ? matches.map(p => `<div class="result" data-id="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(dates(p))}</small></div>`).join("")
    : "<div class='result'>No people in the current view. Try another name.</div>";

  box.classList.remove("hidden");
  box.querySelectorAll("[data-id]").forEach(x => {
    x.onclick = () => {
      focusPerson(x.dataset.id);
      box.classList.add("hidden");
    };
  });
}

async function loadTree(treeConfig) {
  const response = await fetch(treeConfig.file);
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${treeConfig.file}`);
  const data = await response.json();

  if (!Array.isArray(data.people) || !Array.isArray(data.families)) {
    throw new Error(`${treeConfig.file} is not a valid family-tree JSON file`);
  }

  if (S.cy) {
    S.cy.destroy();
    S.cy = null;
  }

  S.people.clear();
  S.families.clear();
  S.focusId = null;
  S.showAll = false;
  S.currentTree = treeConfig;

  data.people.forEach(p => S.people.set(p.id, p));
  data.families.forEach(f => S.families.set(f.id, f));

  const select = document.getElementById("treeSelect");
  if (select) select.value = treeConfig.id;

  const showAllButton = document.getElementById("showAll");
  if (showAllButton) {
    showAllButton.classList.remove("active");
    showAllButton.textContent = "Show all";
  }

  const root = findDefaultRoot();
  if (!root) throw new Error(`No people found in ${treeConfig.file}`);

  renderTree(root, true);
}

async function start() {
  const catalogResponse = await fetch("data/trees.json");
  if (!catalogResponse.ok) throw new Error(`HTTP ${catalogResponse.status} while loading data/trees.json`);

  const catalog = await catalogResponse.json();
  if (!Array.isArray(catalog) || !catalog.length) {
    throw new Error("data/trees.json must contain at least one tree");
  }

  S.treeCatalog = catalog;

  const select = document.getElementById("treeSelect");
  if (!select) throw new Error("Missing #treeSelect in index.html");

  select.innerHTML = "";
  catalog.forEach(tree => {
    const option = document.createElement("option");
    option.value = tree.id;
    option.textContent = tree.name;
    select.appendChild(option);
  });

  select.onchange = async () => {
    const tree = S.treeCatalog.find(t => t.id === select.value);
    if (!tree) return;

    try {
      await loadTree(tree);
    } catch (e) {
      console.error(e);
      document.getElementById("stats").textContent = "Error loading selected tree";
    }
  };

  document.getElementById("showAll").onclick = () => {
    if (!S.people.size) return;

    S.showAll = !S.showAll;
    const button = document.getElementById("showAll");
    button.classList.toggle("active", S.showAll);
    button.textContent = S.showAll ? "Focused view" : "Show all";

    const root = S.focusId || findDefaultRoot();
    if (root) renderTree(root, true);
  };

  document.getElementById("fit").onclick = () => {
    if (S.cy) S.cy.fit(S.cy.nodes('[type="person"]'), 70);
  };

  document.getElementById("reset").onclick = () => {
    S.showAll = false;
    const button = document.getElementById("showAll");
    button.classList.remove("active");
    button.textContent = "Show all";
    const root = findDefaultRoot();
    if (root) renderTree(root, true);
  };

  document.getElementById("zin").onclick = () => zoom(1.25);
  document.getElementById("zout").onclick = () => zoom(0.8);
  document.getElementById("close").onclick = () => document.getElementById("details").classList.add("hidden");
  document.getElementById("clear").onclick = () => {
    document.getElementById("search").value = "";
    search("");
  };
  document.getElementById("search").oninput = e => search(e.target.value.trim());

  await loadTree(catalog[0]);
}
start().catch(e => {
  console.error(e);
  document.getElementById("stats").textContent = "Error loading data";
  document.getElementById("cy").innerHTML =
    "<div style='padding:30px'>Could not load data/family-tree.json. Run a local web server; do not open index.html directly.</div>";
});
