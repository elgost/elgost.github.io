# Family Tree Web App

This is the first working version of a Gramps-friendly family-tree viewer.

Features:
- large zoomable/pannable canvas
- person and family nodes
- click a person for parents, partners and children
- name/date search
- JSON data source
- no backend required

## Run

From this directory:

```bash
python -m http.server 8000
```

Open `http://localhost:8000/`.

Do not open `index.html` directly with `file://`, because the browser blocks the JSON `fetch()`.

The example uses Cytoscape.js from its public CDN.

## Data

Replace `data/family-tree.json` with your genealogy data. The expected shape is:

```json
{
  "people": [
    {"id":"P1","name":"John Smith","birth":"1890","death":"1960","gender":"M"}
  ],
  "families": [
    {"id":"F1","father":"P1","mother":"P2","children":["P3"]}
  ]
}
```

The next development step is to make a proper Gramps `.gramps` XML importer and map more Gramps data such as places, sources, notes, media and event types.
