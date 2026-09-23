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
    root=ET.parse(a.input).getroot()
    people={}
    #pl=root.findall(".//{http://gramps-project.org/xml/1.7.1/}person")
    #print(f"Found {pl}")
    print(f"Root {root}")
    for p in root.findall(".//{http://gramps-project.org/xml/1.7.1/}person"):
        pid=p.get("handle")
        if not pid: continue
        n=p.find("./{http://gramps-project.org/xml/1.7.1/}name")
        first=txt(n,"./{http://gramps-project.org/xml/1.7.1/}first") if n is not None else ""
        last=txt(n,"./{http://gramps-project.org/xml/1.7.1/}surname") if n is not None else ""
        people[pid]={"id":pid,"name":" ".join(x for x in (first,last) if x),
                     "gender":txt(p,"./{http://gramps-project.org/xml/1.7.1/}gender"),"birth":"","birthplace":"","death":"", "deathplace":""}
        for er in p.findall("./{http://gramps-project.org/xml/1.7.1/}eventref"):
            
            ev=root.find(".//{http://gramps-project.org/xml/1.7.1/}event[@handle='"+str(er.get("hlink"))+"']")
            
            if ev is None: continue
            typ=txt(ev,"./{http://gramps-project.org/xml/1.7.1/}type").lower()
            d=ev.find("./{http://gramps-project.org/xml/1.7.1/}dateval")
            print(typ, d)
            val=d.get("val","") if d is not None else ""

            pla=ev.find("./place")
            placelink = root.find(".//{http://gramps-project.org/xml/1.7.1/}placeobj[@handle='" +str(pla.get("hlink"))+"']")
            placename = txt(placelink,"./{http://gramps-project.org/xml/1.7.1/}name") if placelink is not None else ""
            if typ=="birth": people[pid]["birth"]=val; people[pid]["birthplace"]=placename
            if typ=="death": people[pid]["death"]=val; people[pid]["deathplace"]=placename


    families=[]
    for f in root.findall(".//{http://gramps-project.org/xml/1.7.1/}family"):
        fid=f.get("handle")
        if not fid: continue
        fa=f.find("./{http://gramps-project.org/xml/1.7.1/}father"); mo=f.find("./{http://gramps-project.org/xml/1.7.1/}mother")
        children=[]
        for c in f.findall("./{http://gramps-project.org/xml/1.7.1/}childref"):
            children.append(c.get("hlink"))
        families.append({
          "id":fid,
          "father":fa.get("hlink") if fa is not None else None,
          "mother":mo.get("hlink") if mo is not None else None,
          "children":children
        })
    out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps({"people":list(people.values()),"families":families},ensure_ascii=False,indent=2),encoding="utf-8")
    print(f"Wrote {len(people)} people and {len(families)} families to {out}")

if __name__=="__main__": main()
