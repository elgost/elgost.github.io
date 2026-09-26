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
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
}[c]));

const dates = p => [p.birth, p.death].filter(Boolean).join(" â€“ ");

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
    .sort((a, b) => birthYear(a) - birthYear(b))[0]?.id ?? null;
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

    // Parents are one generation above.
    for (const parent of parentsOf(id)) {
      if (Math.abs(g - 1) <= S.generationSpan && !generation.has(parent)) {
        generation.set(parent, g - 1);
        queue.push(parent);
      }
    }

    // Children are one generation below.
    for (const child of childrenOf(id)) {
      if (Math.abs(g + 1) <= S.generationSpan && !generation.has(child)) {
        generation.set(child, g + 1);
        queue.push(child);
      }
    }

    // Partners stay on the same generation.
    for (const partner of partnersOf(id)) {
      if (Math.abs(g) <= S.generationSpan && !generation.has(partner)) {
        generation.set(partner, g);
        queue.push(partner);
      }
    }
  }

  /*
   * Stabilize the visible tree.
   *
   * This is important when a person is:
   *   - the child of one family
   *   - the parent of another family
   *   - the partner of someone else
   *
   * We don't want one pass to leave a connected person out.
   */
  for (let pass = 0; pass < 3; pass++) {
    for (const [id, g] of [...generation]) {

      for (const partner of partnersOf(id)) {
        if (!generation.has(partner)) {
          generation.set(partner, g);
        }
      }

      for (const child of childrenOf(id)) {
        if (
          !generation.has(child) &&
          Math.abs(g + 1) <= S.generationSpan
        ) {
          generation.set(child, g + 1);
        }
      }

      for (const parent of parentsOf(id)) {
        if (
          !generation.has(parent) &&
          Math.abs(g - 1) <= S.generationSpan
        ) {
          generation.set(parent, g - 1);
        }
      }
    }
  }

  const people = [...generation.keys()];
  const visible = new Set(people);

  /*
   * IMPORTANT:
   *
   * Include a family when:
   *
   *   1. it has visible parents AND visible children
   *
   * OR
   *
   *   2. it has at least two visible parents
   *
   * The second case keeps childless couples in the layout.
   */
  const families = [...S.families.values()].filter(f => {
    const ps = familyParents(f).filter(id => visible.has(id));
    const cs = familyChildren(f).filter(id => visible.has(id));

    return (
      (ps.length > 0 && cs.length > 0) ||
      ps.length >= 2
    );
  });

  return {
    generation,
    people,
    families,
  };
}

/*
 * Calculate clean positions.
 *
 * The important trick is to lay out family units instead of individual edges:
 * partners receive adjacent slots, and their children are placed underneath
 * the midpoint of that couple. This produces a recognisable genealogy shape.
 */
/*
 * FAMILY-BASED LAYOUT
 *
 * The important difference from the old layout is that we do NOT:
 *
 *   1. place everyone in a generation
 *   2. move children toward their parents
 *   3. resolve collisions afterwards
 *
 * Instead we build the tree from family blocks.
 *
 * Conceptually:
 *
 *
 *          Parent A ── Parent B
 *                  │
 *              [ FAMILY ]
 *             /     |     \
 *           Child  Child  Child
 *             │      │
 *           Spouse  Spouse
 *             │
 *          grandchildren
 *
 *
 * Every child's horizontal space includes the space required by that
 * child's own family branch.
 *
 * Therefore siblings remain a group.
 */
function calculatePositions(tree) {
  const {
    generation,
    people,
    families,
  } = tree;

  const positions = new Map();

  /*
   * Layout constants.
   *
   * These describe the visual geometry, not the Cytoscape node style.
   */
  const NODE_WIDTH = 160;
  const SPOUSE_GAP = 18;
  const SIBLING_GAP = 45;
  const FAMILY_GAP = 80;
  const GAP_Y = 145;

  const visible = new Set(people);

  /*
   * ------------------------------------------------------------
   * 1. Build indexes
   * ------------------------------------------------------------
   *
   * We deliberately keep family-specific relationships.
   *
   * We do NOT create a global:
   *
   *     person -> partner
   *
   * mapping.
   *
   * That would break as soon as somebody has more than one family.
   */

  const familyInfos = [];

  for (const f of families) {
    const parents = familyParents(f)
      .filter(id => visible.has(id));

    const children = familyChildren(f)
      .filter(id => visible.has(id));

    if (!parents.length && !children.length) {
      continue;
    }

    familyInfos.push({
      family: f,
      id: f.id,
      parents,
      children,
    });
  }

  /*
   * Families where a person is a child.
   *
   * personId -> [family, family, ...]
   */
  const parentFamiliesByPerson = new Map();

  /*
   * Families where a person is a parent.
   *
   * personId -> [family, family, ...]
   */
  const childFamiliesByPerson = new Map();

  /*
   * All families involving a person.
   *
   * personId -> [family, family, ...]
   */
  const familiesByPerson = new Map();

  function addToMap(map, key, value) {
    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key).push(value);
  }

  for (const info of familyInfos) {
    for (const parent of info.parents) {
      addToMap(childFamiliesByPerson, parent, info);
      addToMap(familiesByPerson, parent, info);
    }

    for (const child of info.children) {
      addToMap(parentFamiliesByPerson, child, info);
      addToMap(familiesByPerson, child, info);
    }
  }

  /*
   * ------------------------------------------------------------
   * 2. Family / person width calculation
   * ------------------------------------------------------------
   *
   * Before placing anything we calculate how much horizontal space
   * every branch needs.
   *
   * Example:
   *
   *        Henrik ─ Bjørg
   *             |
   *       +-----+-----+
   *       |     |     |
   *     Child Child Child
   *
   * If the middle child is married and has children of their own,
   * their slot becomes wider.
   *
   * This is what prevents the other siblings from being pushed
   * randomly across the generation.
   */

  const personWidthMemo = new Map();
  const familyWidthMemo = new Map();

  const personWidthStack = new Set();
  const familyWidthStack = new Set();

  function parentGroupWidth(parents) {
    if (!parents.length) {
      return NODE_WIDTH;
    }

    return (
      parents.length * NODE_WIDTH +
      Math.max(0, parents.length - 1) * SPOUSE_GAP
    );
  }

  function personSubtreeWidth(personId) {
    if (personWidthMemo.has(personId)) {
      return personWidthMemo.get(personId);
    }

    /*
     * Protect against malformed/cyclic family data.
     */
    if (personWidthStack.has(personId)) {
      return NODE_WIDTH;
    }

    personWidthStack.add(personId);

    let width = NODE_WIDTH;

    const childFamilies =
      childFamiliesByPerson.get(personId) || [];

    /*
     * A person can have multiple families.
     *
     * Their branches are placed next to each other.
     */
    if (childFamilies.length) {
      const familyWidths = childFamilies.map(
        familySubtreeWidth
      );

      const total =
        familyWidths.reduce((sum, value) => sum + value, 0) +
        Math.max(0, familyWidths.length - 1) * FAMILY_GAP;

      width = Math.max(width, total);
    }

    personWidthStack.delete(personId);

    personWidthMemo.set(personId, width);

    return width;
  }

  function familySubtreeWidth(info) {
    if (familyWidthMemo.has(info.id)) {
      return familyWidthMemo.get(info.id);
    }

    /*
     * Protect against malformed/cyclic family data.
     */
    if (familyWidthStack.has(info.id)) {
      return parentGroupWidth(info.parents);
    }

    familyWidthStack.add(info.id);

    /*
     * Width occupied by the parent couple.
     */
    let width = parentGroupWidth(info.parents);

    /*
     * Width occupied by all children.
     */
    if (info.children.length) {
      const childWidths = info.children.map(
        personSubtreeWidth
      );

      const childrenWidth =
        childWidths.reduce(
          (sum, value) => sum + value,
          0
        ) +
        Math.max(0, childWidths.length - 1) *
          SIBLING_GAP;

      width = Math.max(width, childrenWidth);
    }

    familyWidthStack.delete(info.id);

    familyWidthMemo.set(info.id, width);

    return width;
  }

  /*
   * Force all widths to be calculated.
   */
  for (const info of familyInfos) {
    familySubtreeWidth(info);
  }

  /*
   * ------------------------------------------------------------
   * 3. Family generation helper
   * ------------------------------------------------------------
   */

  function familyGeneration(info) {
    const parentGenerations = info.parents
      .map(id => generation.get(id))
      .filter(g => g !== undefined);

    if (parentGenerations.length) {
      return Math.min(...parentGenerations);
    }

    const childGenerations = info.children
      .map(id => generation.get(id))
      .filter(g => g !== undefined);

    if (childGenerations.length) {
      return Math.min(...childGenerations) - 1;
    }

    return 0;
  }

  /*
   * ------------------------------------------------------------
   * 4. Placement helpers
   * ------------------------------------------------------------
   */

  const placedFamilies = new Set();
  const placingFamilies = new Set();

  /*
   * Keep track of where a family couple is centered.
   */
  const familyCenters = new Map();

  function personY(personId) {
    const g = generation.get(personId);

    if (g === undefined) {
      return 0;
    }

    return g * GAP_Y;
  }

  function familyY(info) {
    return familyGeneration(info) * GAP_Y;
  }

  /*
   * Put a set of parents around a center.
   *
   * For the normal husband/wife case:
   *
   *       parent ---- parent
   *          ^        ^
   *       -89px     +89px
   *
   * If one parent is already positioned because they are also
   * a child in another family, we keep that position and put
   * the spouse beside them.
   */
  function placeParents(info, desiredCenterX) {
    const parents = info.parents;

    if (!parents.length) {
      return desiredCenterX;
    }

    const fixed = parents.filter(id => positions.has(id));

    /*
     * No parent has a position yet.
     *
     * Place the whole parent group around desiredCenterX.
     */
    if (!fixed.length) {
      const totalWidth = parentGroupWidth(parents);

      let x =
        desiredCenterX -
        totalWidth / 2 +
        NODE_WIDTH / 2;

      parents.forEach(parent => {
        positions.set(parent, {
          x,
          y: personY(parent),
        });

        x += NODE_WIDTH + SPOUSE_GAP;
      });

      return desiredCenterX;
    }

    /*
     * All or some parents already have positions.
     */
    if (parents.length === 2) {
      const a = parents[0];
      const b = parents[1];

      const aPosition = positions.get(a);
      const bPosition = positions.get(b);

      /*
       * Both already positioned.
       *
       * Never move either one. The family center is simply the
       * midpoint between them.
       */
      if (aPosition && bPosition) {
        return (aPosition.x + bPosition.x) / 2;
      }

      /*
       * One parent already positioned.
       *
       * Place the spouse directly beside them.
       */
      const fixedParent = aPosition ? a : b;
      const missingParent = aPosition ? b : a;

      const fixedX = positions.get(fixedParent).x;

      /*
       * If this person has several spouse families, alternate
       * the side used by each spouse.
       *
       * First spouse  -> right
       * Second spouse -> left
       * Third spouse  -> right
       * ...
       */
      const spouseFamilies =
        childFamiliesByPerson.get(fixedParent) || [];

      const familyIndex = spouseFamilies.indexOf(info);

      const direction =
        familyIndex >= 0 && familyIndex % 2 === 1
          ? -1
          : 1;

      const missingX =
        fixedX +
        direction *
          (NODE_WIDTH + SPOUSE_GAP);

      positions.set(missingParent, {
        x: missingX,
        y: personY(missingParent),
      });

      return (fixedX + missingX) / 2;
    }

    /*
     * More than two parents.
     *
     * This is uncommon, but we still keep the group together.
     */
    const existingX =
      fixed.reduce(
        (sum, id) => sum + positions.get(id).x,
        0
      ) / fixed.length;

    const missing = parents.filter(
      id => !positions.has(id)
    );

    let startX =
      existingX -
      ((missing.length - 1) *
        (NODE_WIDTH + SPOUSE_GAP)) /
        2;

    for (const parent of missing) {
      positions.set(parent, {
        x: startX,
        y: personY(parent),
      });

      startX += NODE_WIDTH + SPOUSE_GAP;
    }

    const xs = parents.map(
      id => positions.get(id).x
    );

    return xs.reduce((a, b) => a + b, 0) / xs.length;
  }

  /*
   * ------------------------------------------------------------
   * 5. Place one family
   * ------------------------------------------------------------
   *
   * This is the heart of the algorithm.
   *
   * Given:
   *
   *       Henrik ---- Bjørg
   *
   * we calculate:
   *
   *       Henrik ---- Bjørg
   *             |
   *       +-----+-----+
   *       |     |     |
   *      A      B      C
   *
   * And B's own family is then placed directly underneath B.
   */
  function placeFamily(info, desiredCenterX) {
    if (placedFamilies.has(info.id)) {
      return familyCenters.get(
        info.id
      ) ?? desiredCenterX;
    }

    /*
     * Prevent recursive cycles.
     */
    if (placingFamilies.has(info.id)) {
      return desiredCenterX;
    }

    placingFamilies.add(info.id);

    /*
     * First place the parent couple.
     */
    const centerX = placeParents(
      info,
      desiredCenterX
    );

    familyCenters.set(
      info.id,
      centerX
    );

    /*
     * Mark as placed BEFORE recursively entering child
     * families. This prevents circular family data from
     * causing infinite recursion.
     */
    placedFamilies.add(info.id);

    /*
     * ----------------------------------------------------------
     * Place children as one sibling block.
     * ----------------------------------------------------------
     */

    if (info.children.length) {
      const childWidths =
        info.children.map(
          personSubtreeWidth
        );

      const totalWidth =
        childWidths.reduce(
          (sum, value) => sum + value,
          0
        ) +
        Math.max(
          0,
          childWidths.length - 1
        ) *
          SIBLING_GAP;

      let x =
        centerX -
        totalWidth / 2;

      info.children.forEach(
        (childId, index) => {
          const width =
            childWidths[index];

          /*
           * The child occupies the center of their own
           * reserved branch.
           */
          const desiredChildX =
            x + width / 2;

          let childX =
            desiredChildX;

          /*
           * If this child was already positioned by another
           * family, don't move them.
           *
           * This allows a person to belong to multiple
           * family records without creating duplicate nodes.
           */
          if (positions.has(childId)) {
            childX =
              positions.get(childId).x;
          } else {
            positions.set(childId, {
              x: childX,
              y: personY(childId),
            });
          }

          /*
           * Make sure the generation is always correct.
           */
          positions.get(childId).y =
            personY(childId);

          /*
           * A person may now become a parent themselves.
           *
           * Their own family is centered on the child position.
           *
           * Example:
           *
           * Henrik ─ Bjørg
           *       |
           *     Frank ─ Maike
           *           |
           *         child
           */
          const childFamilies =
            childFamiliesByPerson.get(
              childId
            ) || [];

          for (const childFamily of childFamilies) {
            placeFamily(
              childFamily,
              childX
            );
          }

          x += width + SIBLING_GAP;
        }
      );
    }

    /*
     * ----------------------------------------------------------
     * Make sure parent ancestors are also reached.
     * ----------------------------------------------------------
     *
     * Example:
     *
     *        Grandfather ─ Grandmother
     *                   |
     *             Henrik ─ Bjørg
     *                     |
     *                   Frank
     *
     * If Henrik already has an x position because he is a
     * parent in this family, we can walk back to Henrik's
     * own parent family without moving Henrik.
     */
    for (const parentId of info.parents) {
      const ancestorFamilies =
        parentFamiliesByPerson.get(
          parentId
        ) || [];

      for (const ancestorFamily of ancestorFamilies) {
        if (!placedFamilies.has(ancestorFamily.id)) {
          const parentX =
            positions.get(parentId)?.x ??
            centerX;

          placeFamily(
            ancestorFamily,
            parentX
          );
        }
      }
    }

    placingFamilies.delete(info.id);

    return centerX;
  }

  /*
   * ------------------------------------------------------------
   * 6. Find root families
   * ------------------------------------------------------------
   *
   * A root family is one whose parents are not themselves
   * children of another visible family.
   */
  const rootFamilies = familyInfos
    .filter(info => {
      return !info.parents.some(
        parentId =>
          parentFamiliesByPerson.has(
            parentId
          )
      );
    })
    .sort((a, b) => {
      const ga = familyGeneration(a);
      const gb = familyGeneration(b);

      if (ga !== gb) {
        return ga - gb;
      }

      const ay =
        a.parents.length
          ? Math.min(
              ...a.parents.map(
                id =>
                  birthYear(
                    S.people.get(id)
                  )
              )
            )
          : Infinity;

      const by =
        b.parents.length
          ? Math.min(
              ...b.parents.map(
                id =>
                  birthYear(
                    S.people.get(id)
                  )
              )
            )
          : Infinity;

      return ay - by;
    });

  /*
   * ------------------------------------------------------------
   * 7. Lay out each root family
   * ------------------------------------------------------------
   */

  let cursorX = 0;

  for (const info of rootFamilies) {
    if (placedFamilies.has(info.id)) {
      continue;
    }

    const width =
      familySubtreeWidth(info);

    const center =
      cursorX + width / 2;

    placeFamily(
      info,
      center
    );

    cursorX +=
      width + FAMILY_GAP;
  }

  /*
   * ------------------------------------------------------------
   * 8. Handle any remaining families
   * ------------------------------------------------------------
   *
   * Normally everything should already have been reached through
   * the family graph.
   *
   * This is a safety net for unusual / disconnected Gramps data.
   */
  for (const info of familyInfos) {
    if (placedFamilies.has(info.id)) {
      continue;
    }

    const width =
      familySubtreeWidth(info);

    /*
     * If one of the parents already has a position, use that
     * position as the anchor.
     */
    const existingParent =
      info.parents.find(
        id => positions.has(id)
      );

    const center =
      existingParent
        ? positions.get(existingParent).x
        : cursorX + width / 2;

    placeFamily(
      info,
      center
    );

    if (!existingParent) {
      cursorX +=
        width + FAMILY_GAP;
    }
  }

  /*
   * ------------------------------------------------------------
   * 9. Place people that aren't part of any visible family.
   * ------------------------------------------------------------
   *
   * They shouldn't disappear just because they are isolated.
   */
  const unplaced = people.filter(
    id => !positions.has(id)
  );

  if (unplaced.length) {
    const byGeneration =
      new Map();

    for (const id of unplaced) {
      const g =
        generation.get(id) ?? 0;

      if (!byGeneration.has(g)) {
        byGeneration.set(g, []);
      }

      byGeneration.get(g).push(id);
    }

    for (const [g, ids] of byGeneration) {
      let x = cursorX;

      for (const id of ids) {
        positions.set(id, {
          x,
          y: g * GAP_Y,
        });

        x +=
          NODE_WIDTH +
          SIBLING_GAP;
      }

      cursorX = x + FAMILY_GAP;
    }
  }

  /*
   * ------------------------------------------------------------
   * 10. Center the complete tree.
   * ------------------------------------------------------------
   *
   * We use the bounding box rather than the average position.
   * This keeps a large family branch visually centered.
   */
  if (positions.size) {
    const xs = [
      ...positions.values()
    ].map(p => p.x);

    const minX =
      Math.min(...xs);

    const maxX =
      Math.max(...xs);

    const centerX =
      (minX + maxX) / 2;

    for (const position of positions.values()) {
      position.x -= centerX;
    }
  }

  return positions;
}


// ------------------------------------------------------------
// Keep sibling blocks separate
//
// This function moves complete blocks, never individual children.
// ------------------------------------------------------------

function resolveBlockCollisions(
    blocks,
    positions,
    minimumGap,
    familyGap
) {
    const geometry = blocks
        .map(block => {
            const xs = block.members
                .filter(id => positions.has(id))
                .map(id => positions.get(id).x);

            if (!xs.length) return null;

            return {
                block,

                left:
                    Math.min(...xs) - 80,

                right:
                    Math.max(...xs) + 80,

                center:
                    xs.reduce((a, b) => a + b, 0) /
                    xs.length
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.center - b.center);

    for (let i = 1; i < geometry.length; i++) {
        const previous = geometry[i - 1];
        const current = geometry[i];

        const required =
            previous.right +
            familyGap -
            current.left;

        if (required <= 0) continue;

        for (const id of current.block.members) {
            if (positions.has(id)) {
                positions.get(id).x += required;
            }
        }

        current.left += required;
        current.right += required;
        current.center += required;
    }
}


// ------------------------------------------------------------
// Center a generation while preserving sibling blocks
// ------------------------------------------------------------

function centerGenerationBlocks(blocks, positions) {
    const ids = blocks
        .flatMap(block => block.members)
        .filter(id => positions.has(id));

    if (!ids.length) return;

    const center =
        ids.reduce(
            (sum, id) =>
                sum + positions.get(id).x,
            0
        ) / ids.length;

    ids.forEach(id => {
        positions.get(id).x -= center;
    });
}


function makeElements(tree, positions) {
    const elements = [];
    const visible = new Set(tree.people);

    // ------------------------------------------------------------
    // Person nodes
    // ------------------------------------------------------------

    for (const id of tree.people) {
        const p = S.people.get(id);

        if (!p || !positions.has(id)) continue;

        elements.push({
            data: {
                id,
                type: "person",
                label: p.name + (dates(p) ? `\n${dates(p)}` : ""),
            },
            position: positions.get(id),
        });
    }

    // ------------------------------------------------------------
    // Family connectors
    //
    // Each family gets one invisible junction point.
    //
    //        Father ---- Mother
    //               |
    //               |
    //          family junction
    //             /   \
    //           child child
    //
    // A family junction is only needed when there are children.
    // ------------------------------------------------------------

    for (const f of tree.families) {
        const ps = familyParents(f)
            .filter(id => visible.has(id) && positions.has(id));

        const cs = familyChildren(f)
            .filter(id => visible.has(id) && positions.has(id));

        if (!ps.length || !cs.length) continue;

        // The family center is the center of the parents.
        const parentXs = ps.map(id => positions.get(id).x);

        const familyX =
            parentXs.reduce((sum, x) => sum + x, 0) /
            parentXs.length;

        const parentY =
            Math.max(...ps.map(id => positions.get(id).y));

        const childY =
            Math.min(...cs.map(id => positions.get(id).y));

        // Put the family junction halfway between generations.
        const familyY =
            parentY + (childY - parentY) / 2;

        const familyId = `family-${f.id}`;

        elements.push({
            data: {
                id: familyId,
                type: "family",
            },
            position: {
                x: familyX,
                y: familyY,
            },
        });

        // Parent -> family junction
        for (const parent of ps) {
            elements.push({
                data: {
                    id: `parent-${f.id}-${parent}`,
                    source: parent,
                    target: familyId,
                    type: "family-edge",
                },
            });
        }

        // Family junction -> child
        for (const child of cs) {
            elements.push({
                data: {
                    id: `child-${f.id}-${child}`,
                    source: familyId,
                    target: child,
                    type: "family-edge",
                },
            });
        }
    }

    // ------------------------------------------------------------
    // Spouse connectors
    //
    // IMPORTANT:
    // These are generated independently of children.
    //
    // Therefore a childless couple still gets:
    //
    //       Father -------- Mother
    //
    // ------------------------------------------------------------

    const seenPairs = new Set();

    for (const f of tree.families) {
        const ps = familyParents(f)
            .filter(id => visible.has(id) && positions.has(id));

        if (ps.length < 2) continue;

        for (let i = 0; i < ps.length; i++) {
            for (let j = i + 1; j < ps.length; j++) {

                const a = ps[i];
                const b = ps[j];

                const pairKey = [a, b].sort().join("|");

                if (seenPairs.has(pairKey)) continue;

                seenPairs.add(pairKey);

                elements.push({
                    data: {
                        id: `partner-${pairKey}`,
                        source: a,
                        target: b,
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
        style: [{
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
    document.getElementById("stats").textContent =
        `${S.people.size} people Â· ${S.families.size} families Â· showing ${tree.people.length} people Â· ${generations} generations`;
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
function calculatePositions(tree) {
    const { generation, people, families } = tree;

    const positions = new Map();

    const GAP_X = 190;
    const GAP_Y = 145;
    const COUPLE_GAP = 50;
    const FAMILY_GAP = 120;

    // ------------------------------------------------------------
    // 1. Determine generations
    // ------------------------------------------------------------

    const levels = new Map();

    for (const id of people) {
        const g = generation.get(id);

        if (!levels.has(g)) {
            levels.set(g, []);
        }

        levels.get(g).push(id);
    }

    const sortedLevels = [...levels.keys()]
        .sort((a, b) => a - b);

    // ------------------------------------------------------------
    // 2. Build a map of the family relationships
    // ------------------------------------------------------------

    const familyInfo = families.map(f => ({
        family: f,

        parents: familyParents(f)
            .filter(id => generation.has(id)),

        children: familyChildren(f)
            .filter(id => generation.has(id))
    }));

    // ------------------------------------------------------------
    // 3. Determine partners
    // ------------------------------------------------------------

    const partnerMap = new Map();

    for (const info of familyInfo) {

        if (info.parents.length < 2) {
            continue;
        }

        for (let i = 0; i < info.parents.length; i++) {
            for (let j = i + 1; j < info.parents.length; j++) {

                const a = info.parents[i];
                const b = info.parents[j];

                if (!partnerMap.has(a)) {
                    partnerMap.set(a, new Set());
                }

                if (!partnerMap.has(b)) {
                    partnerMap.set(b, new Set());
                }

                partnerMap.get(a).add(b);
                partnerMap.get(b).add(a);
            }
        }
    }
    // ------------------------------------------------------------
    // 4. Create couple units
    //
    // A couple is treated as one horizontal object.
    // ------------------------------------------------------------

    const coupleUnits = new Map();
    const usedCouples = new Set();

    for (const id of people) {

        if (usedCouples.has(id)) {
            continue;
        }

        const partner = partnerMap.get(id);

        if (
            partner &&
            generation.has(partner) &&
            generation.get(partner) === generation.get(id)
        ) {
            const couple = [id, partner];

            couple.sort((a, b) => {
                const pa = S.people.get(a);
                const pb = S.people.get(b);

                return (birthYear(pa) ?? 9999) -
                       (birthYear(pb) ?? 9999);
            });

            const key = couple.join("|");

            coupleUnits.set(key, couple);

            usedCouples.add(id);
            usedCouples.add(partner);

        } else {

            const key = id;

            coupleUnits.set(key, [id]);

            usedCouples.add(id);
        }
    }

    // ------------------------------------------------------------
    // 5. Find the unit containing a person
    // ------------------------------------------------------------

    const unitOf = new Map();

    for (const [key, members] of coupleUnits) {
        for (const id of members) {
            unitOf.set(id, key);
        }
    }

    // ------------------------------------------------------------
    // 6. Build family branch information
    // ------------------------------------------------------------

    const familyBranches = [];

    for (const info of familyInfo) {

        const parentUnits = unique(
            info.parents
                .map(id => unitOf.get(id))
                .filter(Boolean)
        );

        const childUnits = unique(
            info.children
                .map(id => unitOf.get(id))
                .filter(Boolean)
        );

        // A family with children creates a parent -> child branch.
        if (parentUnits.length && childUnits.length) {
            familyBranches.push({
                parents: parentUnits,
                children: childUnits
            });
        }
    }

    // ------------------------------------------------------------
    // 7. Initial positions
    //
    // Couples are positioned together.
    // ------------------------------------------------------------

    for (const g of sortedLevels) {

        const units = [];

        for (const [key, members] of coupleUnits) {

            if (!members.length) {
                continue;
            }

            if (generation.get(members[0]) !== g) {
                continue;
            }

            units.push({
                key,
                members
            });
        }

        // Stable ordering
        units.sort((a, b) => {

            const pa = S.people.get(a.members[0]);
            const pb = S.people.get(b.members[0]);

            const ya = birthYear(pa) ?? 9999;
            const yb = birthYear(pb) ?? 9999;

            return ya - yb;
        });

        let x = 0;

        for (const unit of units) {

            const width =
                unit.members.length === 2
                    ? GAP_X + COUPLE_GAP
                    : GAP_X;

            const center = x;

            if (unit.members.length === 2) {

                positions.set(
                    unit.members[0],
                    {
                        x: center - COUPLE_GAP / 2,
                        y: g * GAP_Y
                    }
                );

                positions.set(
                    unit.members[1],
                    {
                        x: center + COUPLE_GAP / 2,
                        y: g * GAP_Y
                    }
                );

            } else {

                positions.set(
                    unit.members[0],
                    {
                        x: center,
                        y: g * GAP_Y
                    }
                );
            }

            x += width;
            x += FAMILY_GAP;
        }

        // Center this generation around zero
        const generationIds =
            [...positions.entries()]
                .filter(([id]) =>
                    generation.get(id) === g
                );

        if (generationIds.length) {

            const center =
                generationIds.reduce(
                    (sum, [, pos]) => sum + pos.x,
                    0
                ) / generationIds.length;

            generationIds.forEach(([, pos]) => {
                pos.x -= center;
            });
        }
    }

    // ------------------------------------------------------------
    // 8. Align children underneath their parents
    //
    // IMPORTANT:
    // We move the entire child UNIT, not individual people.
    // Therefore spouses cannot be separated.
    // ------------------------------------------------------------

    for (let pass = 0; pass < 5; pass++) {

        for (const branch of familyBranches) {

            const parentPositions = [];

            for (const unitKey of branch.parents) {

                const members = coupleUnits.get(unitKey);

                if (!members) {
                    continue;
                }

                for (const id of members) {
                    if (positions.has(id)) {
                        parentPositions.push(
                            positions.get(id).x
                        );
                    }
                }
            }

            if (!parentPositions.length) {
                continue;
            }

            const parentCenter =
                parentPositions.reduce(
                    (a, b) => a + b,
                    0
                ) / parentPositions.length;

            // Find all children in this family
            const childPositions = [];

            for (const unitKey of branch.children) {

                const members =
                    coupleUnits.get(unitKey);

                if (!members) {
                    continue;
                }

                for (const id of members) {
                    if (positions.has(id)) {
                        childPositions.push(
                            positions.get(id).x
                        );
                    }
                }
            }

            if (!childPositions.length) {
                continue;
            }

            const childCenter =
                childPositions.reduce(
                    (a, b) => a + b,
                    0
                ) / childPositions.length;

            const shift =
                parentCenter - childCenter;

            // Move complete child units.
            for (const unitKey of branch.children) {

                const members =
                    coupleUnits.get(unitKey);

                if (!members) {
                    continue;
                }

                members.forEach(id => {

                    if (positions.has(id)) {
                        positions.get(id).x += shift;
                    }

                });
            }
        }
    }

    // ------------------------------------------------------------
    // 9. Resolve collisions while keeping couples together
    // ------------------------------------------------------------

    for (const g of sortedLevels) {

        const units = [];

        for (const [key, members] of coupleUnits) {

            if (!members.length) {
                continue;
            }

            if (generation.get(members[0]) !== g) {
                continue;
            }

            const xs = members
                .filter(id => positions.has(id))
                .map(id => positions.get(id).x);

            if (!xs.length) {
                continue;
            }

            units.push({
                key,
                members,
                left: Math.min(...xs),
                right: Math.max(...xs),
                center:
                    xs.reduce((a, b) => a + b, 0) /
                    xs.length
            });
        }

        units.sort((a, b) => a.center - b.center);

        for (let i = 1; i < units.length; i++) {

            const previous = units[i - 1];
            const current = units[i];

            const required =
                previous.right +
                GAP_X -
                current.left;

            if (required > 0) {

                current.members.forEach(id => {

                    if (positions.has(id)) {
                        positions.get(id).x += required;
                    }

                });

                current.left += required;
                current.right += required;
                current.center += required;
            }
        }

        // Re-center generation
        if (units.length) {

            const center =
                units.reduce(
                    (sum, unit) =>
                        sum + unit.center,
                    0
                ) / units.length;

            units.forEach(unit => {

                unit.members.forEach(id => {

                    if (positions.has(id)) {
                        positions.get(id).x -= center;
                    }

                });
            });
        }
    }

    return positions;
}
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

async function start() {
  const response = await fetch("data/family-tree.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();

  data.people.forEach(p => S.people.set(p.id, p));
  data.families.forEach(f => S.families.set(f.id, f));

  document.getElementById("fit").onclick = () => {
    if (S.cy) S.cy.fit(S.cy.nodes('[type="person"]'), 70);
  };

  document.getElementById("reset").onclick = () => {
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

  const root = findDefaultRoot();
  if (!root) throw new Error("No people found in family-tree.json");

  renderTree(root, true);
}

start().catch(e => {
  console.error(e);
  document.getElementById("stats").textContent = "Error loading data";
  document.getElementById("cy").innerHTML =
    "<div style='padding:30px'>Could not load data/family-tree.json. Run a local web server; do not open index.html directly.</div>";
});