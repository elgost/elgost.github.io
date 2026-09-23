const S={people:new Map(),families:new Map(),cy:null};

const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
const dates=p=>[p.birth,p.death].filter(Boolean).join(" – ");

async function start(){
  const data=await (await fetch("data/family-tree.json")).json();
  data.people.forEach(p=>S.people.set(p.id,p));
  data.families.forEach(f=>S.families.set(f.id,f));

  const el=[];
  data.people.forEach(p=>el.push({data:{id:p.id,type:"person",label:p.name+(dates(p)?"\n"+dates(p):"")}}));
  data.families.forEach(f=>{
    el.push({data:{id:f.id,type:"family"}});
    [...[f.father,f.mother],...(f.parents||[])].filter(Boolean).forEach(p=>{
      if(S.people.has(p)) el.push({data:{id:f.id+"-"+p,source:p,target:f.id,type:"rel"}});
    });
    (f.children||[]).forEach(c=>{
      if(S.people.has(c)) el.push({data:{id:f.id+"-"+c,source:f.id,target:c,type:"rel"}});
    });
  });

  S.cy=cytoscape({
    container:document.getElementById("cy"),elements:el,minZoom:.06,maxZoom:4,wheelSensitivity:.15,
    style:[
      {selector:'node[type="person"]',style:{shape:"round-rectangle","background-color":"#fff","border-width":1,"border-color":"#8d98a5",label:"data(label)","text-wrap":"wrap","text-max-width":150,"font-size":12,color:"#20252a","text-valign":"center","text-halign":"center",width:150,height:48,padding:6}},
      {selector:'node[type="family"]',style:{shape:"ellipse","background-color":"#6b7280",width:10,height:10}},
      {selector:"edge",style:{width:1.5,"line-color":"#98a2ad","target-arrow-color":"#98a2ad","target-arrow-shape":"triangle","curve-style":"bezier"}},
      {selector:".dim",style:{opacity:.15}}, {selector:".match",style:{"border-width":4,"border-color":"#2563eb"}}, {selector:".selected",style:{"border-width":4,"border-color":"#16a34a"}}
    ],
    layout:{name:"breadthfirst",directed:true,padding:60,spacingFactor:1.1,avoidOverlap:true,animate:false}
  });
  document.getElementById("stats").textContent=`${data.people.length} people · ${data.families.length} families`;
  S.cy.on("tap",'node[type="person"]',e=>show(e.target.id));
  document.getElementById("fit").onclick=()=>S.cy.fit(undefined,50);
  document.getElementById("reset").onclick=()=>{S.cy.elements().removeClass("dim match selected");S.cy.fit(undefined,50)};
  document.getElementById("zin").onclick=()=>zoom(1.25);
  document.getElementById("zout").onclick=()=>zoom(.8);
  document.getElementById("close").onclick=()=>document.getElementById("details").classList.add("hidden");
  document.getElementById("clear").onclick=()=>{document.getElementById("search").value="";search("")};
  document.getElementById("search").oninput=e=>search(e.target.value.trim());
  setTimeout(()=>S.cy.fit(undefined,50),100);
}

function zoom(f){S.cy.zoom({level:S.cy.zoom()*f,renderedPosition:{x:S.cy.width()/2,y:S.cy.height()/2}})}

function show(id){
  const p=S.people.get(id); if(!p)return;
  S.cy.elements().removeClass("selected");S.cy.getElementById(id).addClass("selected");
  const parents=[],partners=[],children=[];
  for(const f of S.families.values()){
    const ps=[f.father,f.mother,...(f.parents||[])].filter(Boolean),cs=f.children||[];
    if(ps.includes(id)){cs.forEach(x=>children.push(x));ps.filter(x=>x!==id).forEach(x=>partners.push(x))}
    if(cs.includes(id))ps.forEach(x=>parents.push(x));
  }
  const uniq=a=>[...new Set(a)];
  const list=a=>uniq(a).map(x=>S.people.get(x)).filter(Boolean).map(x=>`<span class="link" data-id="${esc(x.id)}">${esc(x.name)}</span>`).join("");
  document.getElementById("detailsContent").innerHTML=`<h2>${esc(p.name)}</h2><div>${esc(dates(p))}</div>${p.gender?`<div>Gender: ${esc(p.gender)}</div>`:""}${list(parents)?`<h3>Parents</h3>${list(parents)}`:""}${list(partners)?`<h3>Partners</h3>${list(partners)}`:""}${list(children)?`<h3>Children</h3>${list(children)}`:""}`;
  document.querySelectorAll(".link").forEach(x=>x.onclick=()=>show(x.dataset.id));
  document.getElementById("details").classList.remove("hidden");
}

function search(q){
  S.cy.elements().removeClass("dim match");
  const box=document.getElementById("results");
  if(!q){box.classList.add("hidden");return}
  const m=[...S.people.values()].filter(p=>[p.name,p.givenName,p.surname,p.birth,p.death].filter(Boolean).some(v=>String(v).toLowerCase().includes(q.toLowerCase()))).slice(0,50);
  S.cy.nodes('[type="person"]').addClass("dim");
  m.forEach(p=>S.cy.getElementById(p.id).removeClass("dim").addClass("match"));
  box.innerHTML=m.length?m.map(p=>`<div class="result" data-id="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(dates(p))}</small></div>`).join(""):"<div class=result>No people found</div>";
  box.classList.remove("hidden");box.querySelectorAll("[data-id]").forEach(x=>x.onclick=()=>{show(x.dataset.id);box.classList.add("hidden")});
}
start().catch(e=>{document.getElementById("stats").textContent="Error loading data";document.getElementById("cy").innerHTML="<div style='padding:30px'>Could not load data/family-tree.json. Run a local web server; do not open index.html directly.</div>"});
