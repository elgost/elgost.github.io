#!/usr/bin/env python3
import argparse, json, xml.etree.ElementTree as ET
from pathlib import Path

def txt(parent, path):
    n = parent.find(path)
    return n.text.strip() if n is not None and n.text else ""

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("input", help="Gramps .gramps XML export")
    ap.add_argument("-o","--output",default="data/family-tree.json")
    a=ap.parse_args()
    root=ET.parse(a.input)#.getroot()
    people={}
    pl=root.findall(".//person")
    print(f"Found {pl}")
    print(f"Root {root}")
    for p in root.findall(".//person"):
        pid=p.get("id")
        if not pid: continue
        n=p.find("./name")
        first=txt(n,"./first") if n is not None else ""
        last=txt(n,"./surname") if n is not None else ""
        people[pid]={"id":pid,"name":" ".join(x for x in (first,last) if x),
                     "gender":p.get("gender",""),"birth":"","death":""}
        # for er in p.findall("./eventref"):
        #     ev=root.find(".//event[@id='"+str(er.get("hlink"))+"']")
        #     if ev is None: continue
        #     typ=txt(ev,"./type").lower()
        #     d=ev.find("./date")
        #     val=d.get("val","") if d is not None else ""
        #     if typ=="birth": people[pid]["birth"]=val
        #     if typ=="death": people[pid]["death"]=val

    families=[]
    for f in root.findall(".//family"):
        fid=f.get("id")
        if not fid: continue
        fa=f.find("./father"); mo=f.find("./mother")
        families.append({
          "id":fid,
          "father":fa.get("hlink") if fa is not None else None,
          "mother":mo.get("hlink") if mo is not None else None,
          "children":[c.get("hlink") for c in f.findall("./child") if c.get("hlink")]
        })
    out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps({"people":list(people.values()),"families":families},ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Wrote {len(people)} people and {len(families)} families to {out}")

if __name__=="__main__": main()
