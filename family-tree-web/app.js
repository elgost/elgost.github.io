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
      if (Math.abs(g - 1) <= S.generationSpan && !generation.has(parent)) {
        generation.set(parent, g - 1);
        queue.push(parent);
      }
    }

    for (const child of childrenOf(id)) {
      if (Math.abs(g + 1) <= S.generationSpan && !generation.has(child)) {
        generation.set(child, g + 1);
        queue.push(child);
      }
    }

    for (const partner of partnersOf(id)) {
      if (Math.abs(g) <= S.generationSpan && !generation.has(partner)) {
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
        if (!generation.has(partner) && Math.abs(g) <= S.generationSpan) {
          generation.set(partner, g);
        }
      }

      for (const child of childrenOf(id)) {
        if (!generation.has(child) && Math.abs(g + 1) <= S.generationSpan) {
          generation.set(child, g + 1);
        }
      }

      for (const parent of parentsOf(id)) {
        if (!generation.has(parent) && Math.abs(g - 1) <= S.generationSpan) {
          generation.set(parent, g - 1);
        }
      }
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
 * FAMILY-GRAPH LAYOUT
 *
 * The data is not a strict tree. A person may be:
 *
 *   - a child in one family
 *   - a parent in another family
 *   - a spouse in another family
 *
 * and a family may have one or two known parents.
 *
 * Therefore the layout is built around the family graph rather than by
 * recursively walking one branch and fixing positions afterwards.
 *
 * The algorithm has four stages:
 *
 *   1. Build family/person indexes.
 *   2. Calculate the horizontal width required by each branch.
 *   3. Place connected family components from their topmost families down.
 *   4. Run a small constraint pass to align families without destroying
 *      sibling groups.
 */
function calculatePositions(tree) {
  const { generation, people, families } = tree;
  const positions = new Map();

  const NODE_WIDTH = 160;
  const SPOUSE_GAP = 18;
  const SIBLING_GAP = 38;
  const FAMILY_GAP = 70;
  const GAP_Y = 145;

  const visible = new Set(people);

  // ------------------------------------------------------------
  // 1. Normalised family graph
  // ------------------------------------------------------------

  const infos = families.map(f => ({
    id: f.id,
    family: f,
    parents: familyParents(f).filter(id => visible.has(id)),
    children: familyChildren(f).filter(id => visible.has(id)),
  })).filter(f => f.parents.length || f.children.length);

  const familyById = new Map(infos.map(f => [f.id, f]));
  const parentFamilies = new Map(); // person -> families where person is a child
  const childFamilies = new Map();  // person -> families where person is a parent
  const personFamilies = new Map(); // person -> every visible family

  function add(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  for (const f of infos) {
    for (const p of f.parents) {
      add(childFamilies, p, f);
      add(personFamilies, p, f);
    }
    for (const c of f.children) {
      add(parentFamilies, c, f);
      add(personFamilies, c, f);
    }
  }

  // ------------------------------------------------------------
  // 2. Width calculation
  // ------------------------------------------------------------
  //
  // A child gets a horizontal slot large enough for their own family.
  // This keeps siblings together without treating spouses as siblings.

  const personWidthMemo = new Map();
  const familyWidthMemo = new Map();
  const personStack = new Set();
  const familyStack = new Set();

  function coupleWidth(parents) {
    if (!parents.length) return NODE_WIDTH;
    return parents.length * NODE_WIDTH +
      Math.max(0, parents.length - 1) * SPOUSE_GAP;
  }
  function familyWidth(f) {
    if (familyWidthMemo.has(f.id)) return familyWidthMemo.get(f.id);
    if (familyStack.has(f.id)) return coupleWidth(f.parents);

    familyStack.add(f.id);

    let width = coupleWidth(f.parents);

    if (f.children.length) {
      const childWidths = f.children.map(personWidth);
      const childrenWidth = childWidths.reduce((a, b) => a + b, 0) +
        Math.max(0, childWidths.length - 1) * SIBLING_GAP;
      width = Math.max(width, childrenWidth);
    }

    familyStack.delete(f.id);
    familyWidthMemo.set(f.id, width);
    return width;
  }

  function personWidth(id) {
    if (personWidthMemo.has(id)) return personWidthMemo.get(id);
    if (personStack.has(id)) return NODE_WIDTH;

    personStack.add(id);

    let width = NODE_WIDTH;
    const ownFamilies = childFamilies.get(id) || [];

    if (ownFamilies.length) {
      const branchWidths = ownFamilies.map(familyWidth);
      const branchWidth = branchWidths.reduce((a, b) => a + b, 0) +
        Math.max(0, branchWidths.length - 1) * FAMILY_GAP;
      width = Math.max(width, branchWidth);
    }

    personStack.delete(id);
    personWidthMemo.set(id, width);
    return width;
  }

  for (const f of infos) familyWidth(f);

  // ------------------------------------------------------------
  // 3. Family graph helpers
  // ------------------------------------------------------------

  function familyGeneration(f) {
    const pg = f.parents
      .map(id => generation.get(id))
      .filter(g => g !== undefined);

    if (pg.length) return Math.min(...pg);

    const cg = f.children
      .map(id => generation.get(id))
      .filter(g => g !== undefined);

    return cg.length ? Math.min(...cg) - 1 : 0;
  }

  function personY(id) {
    return (generation.get(id) ?? 0) * GAP_Y;
  }

  // Families are connected when they share a person. This is the crucial
  // difference from the previous recursive layout: spouse ancestry belongs
  // to the same connected component as the marriage family.
  const familyAdj = new Map();

  for (const f of infos) familyAdj.set(f.id, new Set());

  for (const [, fs] of personFamilies) {
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        familyAdj.get(fs[i].id).add(fs[j].id);
        familyAdj.get(fs[j].id).add(fs[i].id);
      }
    }
  }

  const components = [];
  const seenFamilies = new Set();

  for (const f of infos) {
    if (seenFamilies.has(f.id)) continue;

    const component = [];
    const queue = [f];
    seenFamilies.add(f.id);

    while (queue.length) {
      const current = queue.shift();
      component.push(current);

      for (const neighbourId of familyAdj.get(current.id) || []) {
        if (!seenFamilies.has(neighbourId)) {
          seenFamilies.add(neighbourId);
          queue.push(familyById.get(neighbourId));
        }
      }
    }

    components.push(component);
  }

  // ------------------------------------------------------------
  // 4. Initial placement of a family component
  // ------------------------------------------------------------

  const placedFamilies = new Set();

  function placeParents(f, desiredCenter) {
    const parents = f.parents;

    if (!parents.length) return desiredCenter;

    const fixed = parents.filter(id => positions.has(id));

    // Complete family has no fixed person yet.
    if (!fixed.length) {
      const total = coupleWidth(parents);
      let x = desiredCenter - total / 2 + NODE_WIDTH / 2;

      for (const id of parents) {
        positions.set(id, {
          x,
          y: personY(id),
        });
        x += NODE_WIDTH + SPOUSE_GAP;
      }

      return desiredCenter;
    }

    // Two-parent family: keep already positioned parents fixed and put the
    // missing spouse next to the known parent.
    if (parents.length === 2) {
      const a = parents[0];
      const b = parents[1];
      const pa = positions.get(a);
      const pb = positions.get(b);

      if (pa && pb) {
        return (pa.x + pb.x) / 2;
      }

      const fixedId = pa ? a : b;
      const missingId = pa ? b : a;
      const fixedX = positions.get(fixedId).x;

      // Alternate sides for multiple spouse families.
      const spouseFamilies = childFamilies.get(fixedId) || [];
      const index = spouseFamilies.indexOf(f);
      const direction = index >= 0 && index % 2 ? -1 : 1;

      const missingX = fixedX + direction * (NODE_WIDTH + SPOUSE_GAP);

      positions.set(missingId, {
        x: missingX,
        y: personY(missingId),
      });

      return (fixedX + missingX) / 2;
    }

    // General case for more than two parents.
    const fixedCenter = fixed.reduce(
      (sum, id) => sum + positions.get(id).x, 0
    ) / fixed.length;

    const missing = parents.filter(id => !positions.has(id));
    let x = fixedCenter -
      ((missing.length - 1) * (NODE_WIDTH + SPOUSE_GAP)) / 2;

    for (const id of missing) {
      positions.set(id, { x, y: personY(id) });
      x += NODE_WIDTH + SPOUSE_GAP;
    }

    return parents.reduce(
      (sum, id) => sum + positions.get(id).x, 0
    ) / parents.length;
  }

  function placeFamily(f, desiredCenter) {
    if (placedFamilies.has(f.id)) return;

    const center = placeParents(f, desiredCenter);
    placedFamilies.add(f.id);

    // Children form ONE sibling block. Each child's slot contains the width
    // of that child's own descendant family graph.
    if (f.children.length) {
      const widths = f.children.map(personWidth);
      const total = widths.reduce((a, b) => a + b, 0) +
        Math.max(0, widths.length - 1) * SIBLING_GAP;

      let x = center - total / 2;

      f.children.forEach((childId, index) => {
        const width = widths[index];
        const desiredX = x + width / 2;

        if (!positions.has(childId)) {
          positions.set(childId, {
            x: desiredX,
            y: personY(childId),
          });
        } else {
          positions.get(childId).y = personY(childId);
        }

        x += width + SIBLING_GAP;
      });
    }
  }

  // ------------------------------------------------------------
  // 5. Choose a sensible root for each connected component
  // ------------------------------------------------------------
  //
  // The family with the smallest generation is the highest family in the
  // component. If several exist, prefer the one closest to the focus.

  function componentRoot(component) {
    return component.slice().sort((a, b) => {
      const ga = familyGeneration(a);
      const gb = familyGeneration(b);

      if (ga !== gb) return ga - gb;

      const da = a.parents.length
        ? Math.min(...a.parents.map(id => Math.abs(generation.get(id) ?? 0)))
        : Infinity;
      const db = b.parents.length
        ? Math.min(...b.parents.map(id => Math.abs(generation.get(id) ?? 0)))
        : Infinity;

      return da - db;
    })[0];
  }

  // Put components next to each other. Connected family components are laid 
    // out as units, so two unrelated branches cannot push individual siblings
  // apart after the fact.
  let componentCursor = 0;

  const orderedComponents = components.sort((a, b) => {
    return familyGeneration(componentRoot(a)) -
      familyGeneration(componentRoot(b));
  });

  for (const component of orderedComponents) {
    const root = componentRoot(component);
    const width = familyWidth(root);
    const center = componentCursor + width / 2;

    placeFamily(root, center);

    componentCursor += width + FAMILY_GAP;
  }

  // ------------------------------------------------------------
  // 6. Grow the connected component in both directions
  // ------------------------------------------------------------
  //
  // Starting with the root family only positions one layer. Now repeatedly
  // visit families whose people have positions. This naturally handles:
  //
  //   A's parents
  //   B's parents
  //   A/B's children
  //   children's spouses
  //   spouses' parents
  //
  // without assuming that one spouse is the root of the branch.

  let changed = true;
  let safety = infos.length * 4 + 10;

  while (changed && safety-- > 0) {
    changed = false;

    for (const f of infos) {
      const parentKnown = f.parents.some(id => positions.has(id));
      const childKnown = f.children.some(id => positions.has(id));

      if (!placedFamilies.has(f.id) && (parentKnown || childKnown)) {
        let anchor = null;

        if (parentKnown) {
          const xs = f.parents
            .filter(id => positions.has(id))
            .map(id => positions.get(id).x);
          anchor = xs.reduce((a, b) => a + b, 0) / xs.length;
        } else {
          const xs = f.children
            .filter(id => positions.has(id))
            .map(id => positions.get(id).x);
          anchor = xs.reduce((a, b) => a + b, 0) / xs.length;
        }

        placeFamily(f, anchor);
        changed = true;
      }
    }
  }

  // ------------------------------------------------------------
  // 7. Constraint pass
  // ------------------------------------------------------------
  //
  // The initial graph placement gives us the structure. This pass makes
  // family centers and child groups line up more naturally while keeping
  // sibling order intact.

  for (let pass = 0; pass < 5; pass++) {
    for (const f of infos) {
      const knownParents = f.parents.filter(id => positions.has(id));
      const knownChildren = f.children.filter(id => positions.has(id));

      if (!knownParents.length || !knownChildren.length) continue;

      const parentCenter = knownParents.reduce(
        (sum, id) => sum + positions.get(id).x, 0
      ) / knownParents.length;

      const childXs = knownChildren.map(
        id => positions.get(id).x
      );

      const childCenter = childXs.reduce(
        (a, b) => a + b, 0
      ) / childXs.length;

      // Only make a modest correction. The family graph structure remains
      // authoritative and we don't want one branch to drag another branch
      // across the whole canvas.
      const correction =
        Math.max(-55, Math.min(55, parentCenter - childCenter));

      // If the family has multiple children, move the entire sibling group
      // together. This is what prevents the old "random generation row"
      // effect.
      for (const child of knownChildren) {
        positions.get(child).x += correction;
      }
    }
  }

  // ------------------------------------------------------------
  // 8. Collision resolution — sibling/family blocks, NOT individual people
  // ------------------------------------------------------------
  //
  // This is intentionally much less aggressive than the old generation-level
  // collision resolver. Spouses and siblings must move as groups.

  const generations = new Map();

  for (const id of people) {
    if (!positions.has(id)) continue;
    const g = generation.get(id) ?? 0;
    if (!generations.has(g)) generations.set(g, []);
    generations.get(g).push(id);
  }

  for (const [g, ids] of generations) {
    ids.sort((a, b) => positions.get(a).x - positions.get(b).x);

    for (let i = 1; i < ids.length; i++) {
      const previous = positions.get(ids[i - 1]);
      const current = positions.get(ids[i]);

      const minimum = NODE_WIDTH + SIBLING_GAP;

      if (current.x - previous.x < minimum) {
        current.x = previous.x + minimum;
      }
    }
  }

  // ------------------------------------------------------------
  // 9. Safety net for isolated people
  // ------------------------------------------------------------

  let isolatedX = componentCursor;

  for (const id of people) {
    if (positions.has(id)) continue;

    positions.set(id, {
      x: isolatedX,
      y: personY(id),
    });

    isolatedX += NODE_WIDTH + SIBLING_GAP;
  }

  // ------------------------------------------------------------
  // 10. Center the complete visible graph
  // ------------------------------------------------------------

  if (positions.size) {
    const xs = [...positions.values()].map(p => p.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const centerX = (minX + maxX) / 2;

    for (const p of positions.values()) {
      p.x -= centerX;
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
  document.getElementById("stats").textContent =
    `${S.people.size} people · ${S.families.size} families · showing ${tree.people.length} people · ${generations} generations`;
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