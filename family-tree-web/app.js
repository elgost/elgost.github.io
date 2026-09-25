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
    const generation = new Map([
        [focusId, 0]
    ]);
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

        // Partners stay on exactly the same level.
        for (const partner of partnersOf(id)) {
            if (Math.abs(g) <= S.generationSpan && !generation.has(partner)) {
                generation.set(partner, g);
                queue.push(partner);
            }
        }
    }

    // A partner may reveal children whose other parent was already discovered.
    // Run a few stabilization passes so a marriage never leaves one partner out.
    for (let pass = 0; pass < 3; pass++) {
        for (const [id, g] of[...generation]) {
            for (const partner of partnersOf(id)) {
                if (!generation.has(partner)) generation.set(partner, g);
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

    const families = [...S.families.values()].filter(f => {
        const ps = familyParents(f).filter(id => visible.has(id));
        const cs = familyChildren(f).filter(id => visible.has(id));

        // Keep:
        // 1. normal parent -> child families
        // 2. couples, even when they have no children
        return (
            (ps.length > 0 && cs.length > 0) ||
            ps.length >= 2
        );
    });

    return { generation, people, families };
}

/*
 * Calculate clean positions.
 *
 * The important trick is to lay out family units instead of individual edges:
 * partners receive adjacent slots, and their children are placed underneath
 * the midpoint of that couple. This produces a recognisable genealogy shape.
 */
function calculatePositions(tree) {
    const { generation, people, families } = tree;

    const positions = new Map();

    const NODE_WIDTH = 160;

    // Horizontal distance between the centres of normal sibling slots.
    const SIBLING_GAP = 185;

    // Distance between spouses.
    const SPOUSE_GAP = 20;

    // Vertical distance between generations.
    const GENERATION_GAP = 145;

    // ------------------------------------------------------------
    // Build family information
    // ------------------------------------------------------------

    const visible = new Set(people);

    const familyInfo = families.map(f => ({
        id: f.id,

        parents: familyParents(f)
            .filter(id => visible.has(id)),

        children: familyChildren(f)
            .filter(id => visible.has(id))
    }));

    // ------------------------------------------------------------
    // Find the family that contains each child
    // ------------------------------------------------------------

    const parentFamilyOf = new Map();

    for (const family of familyInfo) {
        for (const child of family.children) {
            if (!parentFamilyOf.has(child)) {
                parentFamilyOf.set(child, family);
            }
        }
    }

    // ------------------------------------------------------------
    // Find spouse relationships
    //
    // IMPORTANT:
    // We do NOT create one global "partner map".
    // A person can have multiple spouses.
    // ------------------------------------------------------------

    const spouses = new Map();

    function addSpouse(a, b) {
        if (!a || !b || a === b) return;

        if (!spouses.has(a)) {
            spouses.set(a, new Set());
        }

        spouses.get(a).add(b);
    }

    for (const family of familyInfo) {
        if (family.parents.length < 2) continue;

        for (let i = 0; i < family.parents.length; i++) {
            for (let j = i + 1; j < family.parents.length; j++) {
                addSpouse(family.parents[i], family.parents[j]);
                addSpouse(family.parents[j], family.parents[i]);
            }
        }
    }

    // ------------------------------------------------------------
    // Generation levels
    // ------------------------------------------------------------

    const levels = new Map();

    for (const id of people) {
        const g = generation.get(id);

        if (g == null) continue;

        if (!levels.has(g)) {
            levels.set(g, []);
        }

        levels.get(g).push(id);
    }

    const sortedGenerations =
        [...levels.keys()].sort((a, b) => a - b);

    // ------------------------------------------------------------
    // Determine which people are "child anchors".
    //
    // A child anchor is positioned according to the family they
    // came from. Their spouse is then positioned beside them.
    // ------------------------------------------------------------

    function spouseList(id) {
        return [...(spouses.get(id) || [])]
            .filter(x => visible.has(x));
    }

    // ------------------------------------------------------------
    // Step 1:
    // Create a stable ordering for each generation.
    //
    // The key difference from the previous algorithm is that
    // siblings ONLY come from the same family.children array.
    // ------------------------------------------------------------

    const orderedLevels = new Map();

    for (const g of sortedGenerations) {

        const ids = [...levels.get(g)];
        const used = new Set();
        const ordered = [];

        // First place people according to their parent family.
        //
        // This means:
        //
        // Henrik/Bjørg
        //       |
        //   [Kristine, Synnøve, Frank]
        //
        // rather than treating everybody at generation g as one
        // giant sibling group.

        const familiesAtLevel = familyInfo
            .filter(f =>
                f.children.some(child =>
                    ids.includes(child)
                )
            );

        for (const family of familiesAtLevel) {

            for (const child of family.children) {

                if (!ids.includes(child)) continue;
                if (used.has(child)) continue;

                ordered.push(child);
                used.add(child);
            }
        }

        // Add people who weren't children of a visible family.
        //
        // This handles spouses, isolated people and other edge
        // cases without losing them.

        const remaining = ids
            .filter(id => !used.has(id))
            .sort((a, b) => {
                const pa = S.people.get(a);
                const pb = S.people.get(b);

                return birthYear(pa) - birthYear(pb);
            });

        ordered.push(...remaining);

        orderedLevels.set(g, ordered);
    }

    // ------------------------------------------------------------
    // Step 2:
    // Give each person an initial position.
    //
    // At this point spouses are NOT used to determine the child
    // order.
    // ------------------------------------------------------------

    for (const g of sortedGenerations) {

        const ids = orderedLevels.get(g);

        if (!ids.length) continue;

        const totalWidth =
            (ids.length - 1) * SIBLING_GAP;

        const startX =
            -totalWidth / 2;

        ids.forEach((id, index) => {

            positions.set(id, {
                x: startX + index * SIBLING_GAP,
                y: g * GENERATION_GAP
            });

        });
    }

    // ------------------------------------------------------------
    // Step 3:
    // Align children with their parents.
    //
    // We only move CHILDREN here.
    //
    // We deliberately do NOT move their spouses.
    // Their spouses will be positioned afterwards.
    // ------------------------------------------------------------

    for (let pass = 0; pass < 5; pass++) {

        for (const family of familyInfo) {

            if (!family.children.length) continue;
            if (!family.parents.length) continue;

            const parentPositions =
                family.parents
                    .filter(id => positions.has(id))
                    .map(id => positions.get(id));

            if (!parentPositions.length) continue;

            const parentCenter =
                parentPositions.reduce(
                    (sum, p) => sum + p.x,
                    0
                ) / parentPositions.length;

            const children =
                family.children
                    .filter(id => positions.has(id));

            if (!children.length) continue;

            const childCenter =
                children.reduce(
                    (sum, id) =>
                        sum + positions.get(id).x,
                    0
                ) / children.length;

            const shift =
                (parentCenter - childCenter) * 0.65;

            children.forEach(id => {
                positions.get(id).x += shift;
            });
        }

        // Resolve sibling collisions after each pass.
        resolveGenerationCollisions(
            orderedLevels,
            positions,
            SIBLING_GAP
        );
    }

    // ------------------------------------------------------------
    // Step 4:
    // Position spouses.
    //
    // This happens AFTER the child hierarchy has been established.
    //
    // Therefore:
    //
    //       Parent
    //         |
    //       Frank --- Maike
    //
    // instead of allowing Maike to influence Frank's child slot.
    // ------------------------------------------------------------

    const positionedSpouses = new Set();

    for (const g of sortedGenerations) {

        const ids = orderedLevels.get(g);

        for (const id of ids) {

            if (!positions.has(id)) continue;

            const partners =
                spouseList(id);

            if (!partners.length) continue;

            const base = positions.get(id);

            const visiblePartners =
                partners.filter(partner =>
                    positions.has(partner)
                );

            if (!visiblePartners.length) continue;

            // Only position partners that are not already handled.
            for (const partner of visiblePartners) {

                const partnerPos =
                    positions.get(partner);

                // If the partner is already immediately adjacent,
                // leave it alone.
                if (
                    Math.abs(
                        partnerPos.x -
                        base.x
                    ) <= NODE_WIDTH + SPOUSE_GAP + 5
                ) {
                    positionedSpouses.add(partner);
                    continue;
                }

                // Put spouse to the right of the person.
                partnerPos.x =
                    base.x +
                    NODE_WIDTH +
                    SPOUSE_GAP;

                partnerPos.y =
                    base.y;

                positionedSpouses.add(partner);
            }
        }
    }

    // ------------------------------------------------------------
    // Step 5:
    // Resolve collisions again.
    //
    // Spouses are treated as part of the same local couple block,
    // but we do NOT allow them to influence sibling relationships.
    // ------------------------------------------------------------

    for (const g of sortedGenerations) {

        const ids = orderedLevels.get(g);

        if (!ids.length) continue;

        const blocks = [];

        const processed = new Set();

        for (const id of ids) {

            if (processed.has(id)) continue;

            const p = positions.get(id);
            if (!p) continue;

            const partners =
                spouseList(id)
                    .filter(x => positions.has(x));

            const members = [id];

            for (const partner of partners) {

                if (!members.includes(partner)) {
                    members.push(partner);
                }
            }

            members.forEach(x => processed.add(x));

            const xs =
                members.map(x => positions.get(x).x);

            blocks.push({
                members,
                left: Math.min(...xs),
                right: Math.max(...xs),
                center:
                    xs.reduce((a, b) => a + b, 0) /
                    xs.length
            });
        }

        blocks.sort((a, b) =>
            a.center - b.center
        );

        for (let i = 1; i < blocks.length; i++) {

            const previous = blocks[i - 1];
            const current = blocks[i];

            const required =
                previous.right +
                SIBLING_GAP -
                current.left;

            if (required <= 0) continue;

            current.members.forEach(id => {
                positions.get(id).x += required;
            });

            current.left += required;
            current.right += required;
            current.center += required;
        }
    }

    // ------------------------------------------------------------
    // Step 6:
    // Re-center each generation.
    // ------------------------------------------------------------

    for (const g of sortedGenerations) {

        const ids =
            [...levels.get(g)]
                .filter(id => positions.has(id));

        if (!ids.length) continue;

        const xs =
            ids.map(id => positions.get(id).x);

        const center =
            xs.reduce((a, b) => a + b, 0) /
            xs.length;

        ids.forEach(id => {
            positions.get(id).x -= center;
        });
    }

    return positions;
}


// ------------------------------------------------------------
// Keep people in a generation from overlapping.
//
// This function only moves people horizontally.
// ------------------------------------------------------------

function resolveGenerationCollisions(
    orderedLevels,
    positions,
    minimumGap
) {
    for (const ids of orderedLevels.values()) {

        const ordered =
            ids
                .filter(id => positions.has(id))
                .slice()
                .sort(
                    (a, b) =>
                        positions.get(a).x -
                        positions.get(b).x
                );

        for (let i = 1; i < ordered.length; i++) {

            const previous =
                positions.get(ordered[i - 1]);

            const current =
                positions.get(ordered[i]);

            const required =
                previous.x +
                minimumGap -
                current.x;

            if (required > 0) {
                current.x += required;
            }
        }
    }
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