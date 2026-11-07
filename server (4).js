// Запуск: BOT_TOKEN=123:ABC node server.js   (Node 18+, без зависимостей)
// Хранение: если заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN — игроки и фото лежат в Upstash
// (переживают любые обновления). Иначе — как раньше, в файлах рядом с кодом.
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000,BOT_TOKEN=process.env.BOT_TOKEN||"";
const DB=path.join(process.env.DATA_DIR||__dirname,"players.json");
const ONLINE_MS=45000;
const PH=path.join(process.env.DATA_DIR||__dirname,"photos");
const UP=(process.env.UPSTASH_REDIS_REST_URL||"").trim().replace(/\/+$/,""),UT=(process.env.UPSTASH_REDIS_REST_TOKEN||"").trim();
const useUp=!!(UP&&UT);
if(!useUp)try{fs.mkdirSync(PH,{recursive:true})}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function up(cmd){
  const r=await fetch(UP,{method:"POST",headers:{Authorization:"Bearer "+UT,"Content-Type":"application/json"},body:JSON.stringify(cmd)});
  const j=await r.json();if(!r.ok||j.error)throw new Error(j.error||("HTTP "+r.status));return j.result;
}
// публичный id для ссылки на фото (настоящий id игрока наружу не отдаём)
const pub=id=>crypto.createHash("sha256").update("ph:"+id).digest("hex").slice(0,16);
function who(b){
  if(BOT_TOKEN){const u=verify(b.initData||"");return u?"tg"+u.id:null}
  const id="w"+String(b.id||"").replace(/[^a-z0-9]/gi,"").slice(0,16);return id==="w"?null:id;
}
// ---- фото ----
const PHC=new Map();
function phCache(k,buf){if(PHC.size>200)PHC.clear();PHC.set(k,buf)}
async function getPhotoBuf(k){
  if(PHC.has(k))return PHC.get(k);
  let buf=null;
  if(useUp){try{const v=await up(["HGET","photos",k]);if(v)buf=Buffer.from(v,"base64")}catch(e){}}
  else{try{buf=fs.readFileSync(path.join(PH,k+".jpg"))}catch(e){}}
  if(buf)phCache(k,buf);return buf;
}
async function setPhoto(b){
  const id=who(b);if(!id||!P[id])return false;
  const me=P[id],k=pub(id);
  if(b.ph===""){
    if(useUp){try{await up(["HDEL","photos",k])}catch(e){return false}}else{try{fs.unlinkSync(path.join(PH,k+".jpg"))}catch(e){}}
    PHC.delete(k);delete me.pv;mark(id);return true;
  }
  const m=/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.ph||""));
  if(!m||m[1].length>120000)return false;
  const buf=Buffer.from(m[1],"base64");
  if(buf.length<4||buf[0]!==0xFF||buf[1]!==0xD8)return false;
  if(useUp){try{await up(["HSET","photos",k,m[1]])}catch(e){return false}}else fs.writeFileSync(path.join(PH,k+".jpg"),buf);
  phCache(k,buf);me.pv=Date.now().toString(36);mark(id);return true;
}
async function readPhoto(id){const buf=await getPhotoBuf(pub(id));return buf?"data:image/jpeg;base64,"+buf.toString("base64"):null}
// ---- игроки ----
let P={};
const dirtyIds=new Set();
const mark=id=>{dirtyIds.add(id)};
let flushing=false;
async function saveDirty(){
  if(flushing||!dirtyIds.size)return;
  flushing=true;const ids=[...dirtyIds];dirtyIds.clear();
  try{
    if(useUp){
      for(let i=0;i<ids.length;i+=30){
        const cmd=["HSET","players"];
        for(const id of ids.slice(i,i+30))if(P[id])cmd.push(id,JSON.stringify(P[id]));
        if(cmd.length>2)await up(cmd);   // одна команда на пачку игроков — экономит лимит Upstash
      }
    }else fs.writeFileSync(DB,JSON.stringify(P));
  }catch(e){ids.forEach(i=>dirtyIds.add(i));console.log("Ошибка сохранения:",e.message)}
  flushing=false;
}
setInterval(saveDirty,useUp?30000:10000);
async function loadAll(){
  if(!useUp){try{P=JSON.parse(fs.readFileSync(DB,"utf8"))}catch(e){}return}
  let cur="0";
  do{
    const r=await up(["HSCAN","players",cur,"COUNT","100"]);cur=String(r[0]);const a=r[1]||[];
    for(let i=0;i<a.length;i+=2){try{P[a[i]]=JSON.parse(a[i+1])}catch(e){}}
  }while(cur!=="0");
}
function verify(init){
  try{
    const p=new URLSearchParams(init),hash=p.get("hash");p.delete("hash");
    if(!hash)return null;
    const s=[...p.entries()].map(([k,v])=>k+"="+v).sort().join("\n");
    const key=crypto.createHmac("sha256","WebAppData").update(BOT_TOKEN).digest();
    if(crypto.createHmac("sha256",key).update(s).digest("hex")!==hash)return null;
    if(Date.now()/1000-Number(p.get("auth_date")||0)>86400*3)return null;
    return JSON.parse(p.get("user"));
  }catch(e){return null}
}
const clean=s=>String(s||"Игрок").replace(/[<>"&]/g,"").slice(0,24)||"Игрок";
function sync(b){
  let id,name=clean(b.name);
  if(BOT_TOKEN){
    const u=verify(b.initData||"");if(!u)return null;
    id="tg"+u.id;if(!b.name||b.name==="Игрок")name=clean(u.first_name);
  }else{
    id="w"+String(b.id||"").replace(/[^a-z0-9]/gi,"").slice(0,16);if(id==="w")return null;
  }
  const now=Date.now();let bal=Number(b.bal);if(!isFinite(bal)||bal<0)bal=0;
  const me=P[id]||(P[id]={bal:0,seen:now});
  if(b.restore){me.seen=now;mark(id)}
  else{
    // простая защита: баланс не может расти быстрее разумного темпа
    const dt=Math.max(1,(now-me.seen)/1000),max=me.bal+dt*30+400;
    me.bal=Math.min(bal,max);me.name=name;me.av=String(b.av||"").slice(0,10);me.seen=now;mark(id);
    // сохраняем полный прогресс игрока, чтобы вернуть его, если у клиента пропал localStorage
    if(b.st&&typeof b.st==="object"&&!Array.isArray(b.st))me.st=Object.assign({},b.st,{bal:me.bal});
  }
  const all=Object.entries(P).sort((a,b)=>b[1].bal-a[1].bal);
  const rank=all.findIndex(x=>x[0]===id)+1;
  return{
    st:b.restore?(me.st||null):undefined,
    _ph:b.restore&&me.pv?id:undefined,
    online:all.filter(x=>now-x[1].seen<ONLINE_MS).length,total:all.length,me:rank,
    top:all.slice(0,50).map(([k,v])=>({name:v.name||"Игрок",bal:v.bal,av:v.av,u:pub(k),pu:v.pv?pub(k):undefined,pv:v.pv,on:now-v.seen<ONLINE_MS,me:k===id}))
  };
}
// публичный профиль игрока: только безопасные поля, всё из клиентского снимка проверяется и ограничивается
let PUBMAP={},PUBN=0;
function byPub(p){
  const keys=Object.keys(P);
  if(PUBN!==keys.length||!PUBMAP[p]||!P[PUBMAP[p]]){PUBMAP={};for(const x of keys)PUBMAP[pub(x)]=x;PUBN=keys.length}
  return PUBMAP[p]||null;
}
function profile(p){
  const k=byPub(p);if(!k)return null;
  const v=P[k],st=v.st&&typeof v.st==="object"?v.st:{},pr=st.prof&&typeof st.prof==="object"?st.prof:{};
  const gid=x=>/^[a-z0-9]{1,16}$/.test(String(x||""))?String(x):"";
  const num=(x,a,b)=>Math.min(b,Math.max(a,Number(x)||0));
  const own=st.own&&typeof st.own==="object"&&!Array.isArray(st.own)?Object.keys(st.own).filter(gid).slice(0,100):[];
  const bg=(Array.isArray(pr.bg)?pr.bg:[]).slice(0,8).map(o=>({id:gid(o&&o.id),x:num(o&&o.x,0,100),y:num(o&&o.y,0,100),r:num(o&&o.r,-180,180)})).filter(o=>o.id);
  const tot=Math.max(0,Number(st.tot)||0);
  return{
    name:v.name||"Игрок",bal:v.bal||0,on:Date.now()-v.seen<ONLINE_MS,
    pu:v.pv?pub(k):undefined,pv:v.pv,av:gid(v.av),
    user:/^[a-z][a-z0-9_]{4,19}$/.test(String(pr.user||""))?pr.user:"",
    num:gid(pr.num),st:gid(pr.st),bg,own,lv:Math.floor(Math.sqrt(tot/3))+1
  };
}
// при остановке сервера (например, при обновлении) дописываем последние изменения
async function stop(){
  for(let i=0;i<40&&flushing;i++)await sleep(250);
  await saveDirty();process.exit(0);
}
process.on("SIGTERM",stop);
process.on("SIGINT",stop);
const server=http.createServer((req,res)=>{
  const h={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"};
  if(req.method==="OPTIONS"){res.writeHead(204,h);return res.end()}
  if(req.method==="POST"&&req.url==="/api/sync"){
    let d="";req.on("data",c=>{d+=c;if(d.length>65536)req.destroy()});
    req.on("end",async()=>{
      let out=null;try{out=sync(JSON.parse(d));if(out&&out._ph){const id=out._ph;out.ph=(await readPhoto(id))||undefined}}catch(e){out=null}
      if(out)delete out._ph;
      res.writeHead(out?200:400,{...h,"Content-Type":"application/json"});res.end(JSON.stringify(out||{error:1}));
    });return;
  }
  if(req.method==="POST"&&req.url==="/api/photo"){
    let d="";req.on("data",c=>{d+=c;if(d.length>150000)req.destroy()});
    req.on("end",async()=>{
      let ok=false;try{ok=await setPhoto(JSON.parse(d))}catch(e){}
      res.writeHead(ok?200:400,{...h,"Content-Type":"application/json"});res.end(JSON.stringify(ok?{ok:1}:{error:1}));
    });return;
  }
  const qm=req.method==="GET"&&/^\/api\/profile\/([a-f0-9]{16})(\?.*)?$/.exec(req.url);
  if(qm){
    const out=profile(qm[1]);
    res.writeHead(out?200:404,{...h,"Content-Type":"application/json","Cache-Control":"no-store"});return res.end(JSON.stringify(out||{error:1}));
  }
  const pm=req.method==="GET"&&/^\/api\/photo\/([a-f0-9]{16})\.jpg(\?.*)?$/.exec(req.url);
  if(pm){
    getPhotoBuf(pm[1]).then(buf=>{
      if(!buf){res.writeHead(404,h);return res.end()}
      res.writeHead(200,{...h,"Content-Type":"image/jpeg","Cache-Control":"public, max-age=31536000, immutable","X-Content-Type-Options":"nosniff"});res.end(buf);
    });return;
  }
  if(req.method==="GET"&&(req.url==="/"||req.url.startsWith("/?"))){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return fs.createReadStream(path.join(__dirname,"index.html")).pipe(res);
  }
  res.writeHead(404);res.end();
});
(async()=>{
  for(let t=1;;t++){
    try{await loadAll();break}
    catch(e){console.log("Не удалось загрузить базу ("+t+"/5):",e.message);if(t>=5)process.exit(1);await sleep(3000)}
  }
  console.log(useUp?"Хранилище: Upstash, игроков: "+Object.keys(P).length:"Хранилище: файлы (Upstash не настроен)");
  server.listen(PORT,()=>console.log("http://localhost:"+PORT));
})();
