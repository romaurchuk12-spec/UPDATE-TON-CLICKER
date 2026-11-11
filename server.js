// Запуск: BOT_TOKEN=123:ABC node server.js   (Node 18+, без зависимостей)
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000,BOT_TOKEN=process.env.BOT_TOKEN||"";
const DB=path.join(process.env.DATA_DIR||__dirname,"players.json");
const ONLINE_MS=45000;
const PH=path.join(process.env.DATA_DIR||__dirname,"photos");
try{fs.mkdirSync(PH,{recursive:true})}catch(e){}
// публичный id для ссылки на фото (настоящий id игрока наружу не отдаём)
const pub=id=>crypto.createHash("sha256").update("ph:"+id).digest("hex").slice(0,16);
function who(b){
  if(BOT_TOKEN){const u=verify(b.initData||"");return u?"tg"+u.id:null}
  const id="w"+String(b.id||"").replace(/[^a-z0-9]/gi,"").slice(0,16);return id==="w"?null:id;
}
function setPhoto(b){
  const id=who(b);if(!id||!P[id])return false;
  const me=P[id],f=path.join(PH,pub(id)+".jpg");
  if(b.ph===""){try{fs.unlinkSync(f)}catch(e){}if(REMOTE)rbg(["HDEL",K_PHOTOS,pub(id)]);delete me.pv;dirty=true;return true}
  const m=/^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.ph||""));
  if(!m||m[1].length>120000)return false;
  const buf=Buffer.from(m[1],"base64");
  if(buf.length<4||buf[0]!==0xFF||buf[1]!==0xD8)return false;
  fs.writeFileSync(f,buf);if(REMOTE)rbg(["HSET",K_PHOTOS,pub(id),m[1]]);me.pv=Date.now().toString(36);dirty=true;return true;
}
function readPhoto(id){
  try{return "data:image/jpeg;base64,"+fs.readFileSync(path.join(PH,pub(id)+".jpg")).toString("base64")}catch(e){return null}
}
let P={};try{P=JSON.parse(fs.readFileSync(DB,"utf8"))}catch(e){}
let dirty=false;
setInterval(()=>{if(dirty){dirty=false;fs.writeFile(DB,JSON.stringify(P),()=>{})}},10000);
// ===== ОНЛАЙН МАРКЕТ =====
// Лоты хранятся в market.json. Подарок на время продажи "лежит" на сервере (эскроу).
// Деньги продавцу и подарок покупателю приходят через почтовый ящик (inbox): клиент забирает записи при sync
// и подтверждает их (ack), поэтому ничего не теряется, даже если ответ на запрос потерялся.
const MK_DB=path.join(process.env.DATA_DIR||__dirname,"market.json");
let M={lots:[],inbox:{},used:[]};
try{const o=JSON.parse(fs.readFileSync(MK_DB,"utf8"));if(o&&Array.isArray(o.lots))M=Object.assign(M,o)}catch(e){}
let mdirty=false;
setInterval(()=>{if(mdirty){mdirty=false;fs.writeFile(MK_DB,JSON.stringify(M),()=>{})}},3000);

// ===== ВНЕШНЕЕ ХРАНИЛИЩЕ (Upstash Redis, REST) =====
// На бесплатном Render диск временный: файлы стираются при каждом рестарте/деплое/засыпании.
// Если заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN, игроки, маркет и фото дополнительно сохраняются в Upstash
// и при старте загружаются оттуда. Без этих переменных сервер работает как раньше (только файлы).
const RURL=(process.env.UPSTASH_REDIS_REST_URL||"").replace(/\/+$/,""),RTOK=process.env.UPSTASH_REDIS_REST_TOKEN||"";
const REMOTE=!!(RURL&&RTOK);
// префикс ключей: чтобы данные игры не пересекались с другими данными в той же базе Upstash
const RP=(process.env.UPSTASH_PREFIX||"tonclk:");
const K_PLAYERS=RP+"players",K_MARKET=RP+"market",K_PHOTOS=RP+"photos";
const SAVE_EVERY=Math.max(10,Number(process.env.SAVE_EVERY_SEC)||60)*1000; // как часто сохранять изменения игроков
async function rpost(p,body){
  const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),20000);
  try{
    const r=await fetch(RURL+p,{method:"POST",headers:{Authorization:"Bearer "+RTOK,"Content-Type":"application/json"},body:JSON.stringify(body),signal:ctl.signal});
    const j=await r.json().catch(()=>null);
    if(!r.ok)throw new Error("HTTP "+r.status+(j&&j.error?" "+j.error:""));
    return j;
  }finally{clearTimeout(t)}
}
async function rcmd(a){const j=await rpost("",a);if(j&&j.error)throw new Error(j.error);return j?j.result:null}
async function rtx(list){ // несколько команд атомарно (MULTI/EXEC)
  const j=await rpost("/multi-exec",list);
  if(!Array.isArray(j))throw new Error("bad reply");
  const e=j.find(x=>x&&x.error);if(e)throw new Error(e.error);
  return j.map(x=>x&&x.result);
}
const rpairs=v=>{const o={};if(Array.isArray(v)){for(let i=0;i+1<v.length;i+=2)o[v[i]]=v[i+1]}else if(v&&typeof v==="object")Object.assign(o,v);return o};
let lastSaved={},lastM=null,lastPSave=0,saving=null,ready=!REMOTE;
async function loadRemote(){
  const pl=rpairs(await rcmd(["HGETALL",K_PLAYERS])),mk=await rcmd(["GET",K_MARKET]);
  const np={};let bad=0;
  for(const [k,v] of Object.entries(pl)){try{const o=JSON.parse(v);if(o&&typeof o==="object"){np[k]=o;lastSaved[k]=v}}catch(e){bad++}}
  if(Object.keys(np).length){P=np;console.log("Игроков загружено из Upstash:",Object.keys(np).length+(bad?" (битых пропущено: "+bad+")":""))}
  else console.log("В Upstash игроков пока нет"+(Object.keys(P).length?", отправим локальные данные":""));
  if(mk){try{const o=JSON.parse(mk);if(o&&Array.isArray(o.lots)){M=Object.assign({lots:[],inbox:{},used:[]},o);lastM=mk;console.log("Маркет загружен из Upstash, лотов:",M.lots.length)}}catch(e){console.error("market parse:",e.message)}}
  else console.log("В Upstash маркета пока нет");
}
// сохраняем только изменившихся игроков (одна команда HSET) и маркет; ничего не теряется при сбое: повторим на следующем тике
function persist(force){
  if(!REMOTE||!ready)return Promise.resolve();
  if(saving)return saving;
  saving=(async()=>{
    const now=Date.now(),mj=JSON.stringify(M),mCh=mj!==lastM,dueP=force||mCh||now-lastPSave>=SAVE_EVERY;
    if(!dueP)return;
    const cmds=[],ch={};
    const arr=[];for(const id of Object.keys(P)){const j=JSON.stringify(P[id]);if(lastSaved[id]!==j){ch[id]=j;arr.push(id,j)}}
    if(arr.length)cmds.push(["HSET",K_PLAYERS,...arr]);
    if(mCh)cmds.push(["SET",K_MARKET,mj]);
    if(!cmds.length){lastPSave=now;return}
    try{await rtx(cmds);Object.assign(lastSaved,ch);if(mCh)lastM=mj;lastPSave=now}
    catch(e){console.error("Upstash: не удалось сохранить, повторим:",e.message)}
  })().finally(()=>{saving=null});
  return saving;
}
setInterval(()=>{persist(false)},3000);
// фото: небольшие фоновые записи с повтором
async function rbg(cmd,n=3){for(let i=0;i<n;i++){try{await rcmd(cmd);return}catch(e){if(i===n-1)console.error("Upstash фото:",e.message);else await new Promise(r=>setTimeout(r,1500*(i+1)))}}}
async function remotePhoto(pubId){
  if(!REMOTE||!ready)return null;
  try{
    const v=await rcmd(["HGET",K_PHOTOS,pubId]);if(typeof v!=="string")return null;
    const buf=Buffer.from(v,"base64");if(buf.length<4||buf[0]!==0xFF||buf[1]!==0xD8)return null;
    try{fs.writeFileSync(path.join(PH,pubId+".jpg"),buf)}catch(e){}
    return buf;
  }catch(e){return null}
}
const MAX_LOTS=20,MAX_PRICE=1e7;
const gidOk=x=>/^[a-z0-9]{1,16}$/.test(String(x||""));
const r2=v=>Math.round(v*100)/100;
const boxOf=id=>(M.inbox[id]||[]).slice(0,50);
function boxPush(id,e){(M.inbox[id]||(M.inbox[id]=[])).push(e);mdirty=true}
// клиент подтверждает полученные записи: они удаляются, а деньги от продаж попадают в учтённый баланс
function ackBox(id,me,ack){
  const box=M.inbox[id];if(!box||!Array.isArray(ack)||!ack.length)return;
  const set=new Set(ack.slice(0,200).map(String));
  const left=box.filter(e=>{if(!set.has(e.k))return true;if(e.t==="sold"||e.t==="promo"||e.t==="wwin")me.bal+=e.amt;return false});
  if(left.length)M.inbox[id]=left;else delete M.inbox[id];
  mdirty=dirty=true;
}
// тот же ограничитель роста баланса, что и в sync
function clampBal(me,bal,now){
  if(!isFinite(bal)||bal<0)bal=0;
  const dt=Math.max(1,(now-me.seen)/1000),max=me.bal+dt*30+400;
  me.bal=Math.min(bal,max);me.seen=now;
}
function stRemove(me,g,sn){
  const st=me.st;if(!st||typeof st!=="object")return;
  if(st.cp&&Array.isArray(st.cp[g])){
    st.cp[g]=st.cp[g].filter(v=>Number(v)!==sn);
    if(!st.cp[g].length){delete st.cp[g];if(st.own)delete st.own[g]}else if(st.own)st.own[g]=st.cp[g][0];
  }else if(st.own&&Number(st.own[g])===sn)delete st.own[g];
}
function mAuth(b){const id=who(b);if(!id||!P[id])return null;ackBox(id,P[id],b.ack);return id}
function mLots(b){
  const id=mAuth(b);if(!id)return null;
  return{ok:1,inbox:boxOf(id),lots:M.lots.slice(-300).reverse().map(l=>{
    const v=P[l.s]||{};
    return{k:l.k,g:l.g,sn:l.sn,price:l.price,t:l.t,mine:l.s===id,name:v.name||"Игрок",u:pub(l.s),pu:v.pv?pub(l.s):undefined,pv:v.pv}
  })};
}
function mList(b){
  const id=mAuth(b);if(!id)return null;const me=P[id];
  const g=String(b.g||""),sn=Number(b.sn),price=r2(Number(b.price)),k=String(b.k||"").replace(/[^a-z0-9]/gi,"").slice(0,24);
  if(!gidOk(g)||!Number.isInteger(sn)||sn<1||sn>1e7||!k)return{ok:0,err:"bad"};
  if(M.used.includes(k)||M.lots.some(l=>l.k===k))return{ok:1,dup:1,inbox:boxOf(id)}; // повтор того же запроса
  if(!(price>=0.01&&price<=MAX_PRICE))return{ok:0,err:"price"};
  if(M.lots.filter(l=>l.s===id).length>=MAX_LOTS)return{ok:0,err:"limit"};
  if(M.lots.some(l=>l.s===id&&l.g===g&&l.sn===sn))return{ok:0,err:"dup"};
  // владение проверяем по свежему снимку прогресса игрока (клиент делает sync перед выставлением)
  const st=me.st&&typeof me.st==="object"?me.st:{};
  const arr=st.cp&&Array.isArray(st.cp[g])?st.cp[g]:(st.own&&st.own[g]?[st.own[g]]:[]);
  if(!arr.map(Number).includes(sn))return{ok:0,err:"own"};
  stRemove(me,g,sn);
  M.lots.push({k,s:id,g,sn,price,t:Date.now()});
  M.used.push(k);if(M.used.length>5000)M.used.splice(0,1000);
  mdirty=dirty=true;
  return{ok:1,inbox:boxOf(id)};
}
function mBuy(b){
  const id=mAuth(b);if(!id)return null;const me=P[id];
  const i=M.lots.findIndex(l=>l.k===String(b.lot||""));
  if(i<0)return{ok:0,err:"gone"};
  const l=M.lots[i];
  if(l.s===id)return{ok:0,err:"mine"};
  clampBal(me,Number(b.bal),Date.now());
  if(me.bal<l.price)return{ok:0,err:"bal"};
  me.bal-=l.price;
  M.lots.splice(i,1);
  boxPush(id,{k:"b"+l.k,t:"buy",g:l.g,sn:l.sn,cost:l.price});
  boxPush(l.s,{k:"s"+l.k,t:"sold",g:l.g,sn:l.sn,amt:l.price});
  mdirty=dirty=true;
  return{ok:1,inbox:boxOf(id)};
}
function mCancel(b){
  const id=mAuth(b);if(!id)return null;
  const i=M.lots.findIndex(l=>l.k===String(b.lot||"")&&l.s===id);
  if(i<0)return{ok:0,err:"gone"};
  const l=M.lots.splice(i,1)[0];
  boxPush(id,{k:"r"+l.k,t:"ret",g:l.g,sn:l.sn});
  mdirty=true;
  return{ok:1,inbox:boxOf(id)};
}
// ===== ПРОМОКОДЫ =====
// код (в нижнем регистре) -> сколько TON даёт. Каждый код одноразовый для каждого игрока. Чтобы добавить новый, допишите строку.
const PROMOS={
  click:50,
};
function mPromo(b){
  const id=mAuth(b);if(!id)return null;const me=P[id];
  const c=String(b.code||"").trim().toLowerCase().slice(0,40);
  if(!Object.prototype.hasOwnProperty.call(PROMOS,c))return{ok:0,err:"bad"};
  if(!Array.isArray(me.promos))me.promos=[];
  if(me.promos.includes(c))return{ok:0,err:"used"};
  me.promos.push(c);
  boxPush(id,{k:"p_"+c,t:"promo",amt:PROMOS[c]});
  mdirty=dirty=true;
  return{ok:1,amt:PROMOS[c],inbox:boxOf(id)};
}
// ===== ОНЛАЙН КОЛЕСО =====
// Одна общая комната. Первая ставка запускает таймер WAIT мс, потом колесо крутится SPIN мс. Победитель случайный (шанс пропорционален ставке) и забирает весь банк.
// Ставка списывается сразу, выигрыш приходит через почтовый ящик (inbox) после окончания вращения. Состояние хранится в M.wheel (сохраняется в Upstash вместе с маркетом).
const W_WAIT=15000,W_SPIN=7000,W_SHOW=6000,W_MAX=5,W_MIN=1;
function wGet(){if(!M.wheel||typeof M.wheel!=="object"||!Array.isArray(M.wheel.bets)){M.wheel={n:(M.wheel&&M.wheel.n)|0||1,ph:"idle",bets:[],q:0,hist:[]}}if(!Array.isArray(M.wheel.hist))M.wheel.hist=[];return M.wheel}
function wReset(R){R.n++;R.ph="idle";R.bets=[];R.q=0;delete R.t0;delete R.se;delete R.th;delete R.win;mdirty=true}
function wStep(now){
  const R=wGet();
  if(R.ph==="wait"&&now>=R.t0){
    const pot=R.bets.reduce((a,b)=>a+b.amt,0),th=crypto.randomInt(0,3600000)/10000;
    let c=0,win=R.bets.length-1;
    for(let i=0;i<R.bets.length;i++){c+=R.bets[i].amt/pot*360;if(th<c){win=i;break}}
    R.ph="spin";R.th=th;R.win=win;R.se=now+W_SPIN;mdirty=true;
  }
  if(R.ph==="spin"&&now>=R.se){
    const pot=R.bets.reduce((a,b)=>a+b.amt,0),w=R.bets[R.win];
    boxPush(w.id,{k:"ww"+R.n,t:"wwin",amt:pot/100});
    R.hist.push({name:w.name,amt:pot/100,n:R.bets.length});if(R.hist.length>10)R.hist.splice(0,R.hist.length-10);
    R.ph="done";mdirty=dirty=true;
  }
  if(R.ph==="done"&&now>=R.se+W_SHOW)wReset(R);
}
setInterval(()=>{if(ready)try{wStep(Date.now())}catch(e){console.error("wheel:",e.message)}},300);
function wView(id,now){
  const R=wGet(),spun=R.ph==="spin"||R.ph==="done";
  return{n:R.n,ph:R.ph,tl:R.ph==="wait"?Math.max(0,R.t0-now):0,sl:R.ph==="spin"?Math.max(0,R.se-now):0,
    th:spun?R.th:undefined,win:spun?R.win:undefined,max:W_MAX,min:W_MIN,wait:W_WAIT/1000,
    bets:R.bets.map(b=>({name:b.name,amt:b.amt/100,me:b.id===id})),
    hist:R.hist.slice(-6).reverse().map(h=>({name:h.name,amt:h.amt,n:h.n}))};
}
function wState(b){
  const id=mAuth(b);if(!id)return null;
  const now=Date.now();wStep(now);
  return{ok:1,inbox:boxOf(id),w:wView(id,now)};
}
function wBet(b){
  const id=mAuth(b);if(!id)return null;const me=P[id],now=Date.now();
  wStep(now);let R=wGet();
  if(R.ph==="done"){wReset(R)}
  if(R.ph==="spin")return{ok:0,err:"spin",inbox:boxOf(id),w:wView(id,now)};
  const cents=Math.floor(Number(b.amt)*100+1e-6);
  if(!(cents>=W_MIN*100&&cents<=1e9))return{ok:0,err:"amt",inbox:boxOf(id),w:wView(id,now)};
  let mine=R.bets.find(x=>x.id===id);
  if(!mine&&R.bets.length>=W_MAX)return{ok:0,err:"full",inbox:boxOf(id),w:wView(id,now)};
  clampBal(me,Number(b.bal),now);
  if(me.bal*100<cents-1e-6)return{ok:0,err:"bal",inbox:boxOf(id),w:wView(id,now)};
  me.bal-=cents/100;
  if(mine){mine.amt+=cents;mine.name=clean(me.name)}else R.bets.push({id,name:clean(me.name),amt:cents});
  if(R.ph==="idle"){R.ph="wait";R.t0=now+W_WAIT}
  boxPush(id,{k:"wb"+R.n+"_"+(++R.q),t:"wbet",cost:cents/100});
  mdirty=dirty=true;
  return{ok:1,inbox:boxOf(id),w:wView(id,now)};
}
const MROUTES={"/api/promo":mPromo,"/api/market/lots":mLots,"/api/market/list":mList,"/api/market/buy":mBuy,"/api/market/cancel":mCancel,"/api/wheel/state":wState,"/api/wheel/bet":wBet};
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
  ackBox(id,me,b.ack);
  if(b.restore){me.seen=now;dirty=true}
  else{
    // простая защита: баланс не может расти быстрее разумного темпа
    const dt=Math.max(1,(now-me.seen)/1000),max=me.bal+dt*30+400;
    me.bal=Math.min(bal,max);me.name=name;me.av=String(b.av||"").slice(0,10);me.seen=now;dirty=true;
    // сохраняем полный прогресс игрока, чтобы вернуть его, если у клиента пропал localStorage
    if(b.st&&typeof b.st==="object"&&!Array.isArray(b.st))me.st=Object.assign({},b.st,{bal:me.bal});
  }
  const all=Object.entries(P).sort((a,b)=>b[1].bal-a[1].bal);
  const rank=all.findIndex(x=>x[0]===id)+1;
  return{
    inbox:boxOf(id),
    st:b.restore?(me.st||null):undefined,
    ph:b.restore&&me.pv?readPhoto(id):undefined,
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
  // номера всех копий каждого подарка (до 10 на подарок), чтобы в чужом профиле были видны одинаковые NFT
  const cp={};
  for(const id of own){
    let a=st.cp&&typeof st.cp==="object"&&Array.isArray(st.cp[id])?st.cp[id]:[st.own[id]];
    a=a.map(Number).filter(v=>Number.isInteger(v)&&v>=1&&v<=1e7).slice(0,10);
    if(!a.length)a=[Math.max(1,Math.min(1e7,Math.floor(Number(st.own[id])||1)))];
    cp[id]=a;
  }
  const bg=(Array.isArray(pr.bg)?pr.bg:[]).slice(0,8).map(o=>({id:gid(o&&o.id),x:num(o&&o.x,0,100),y:num(o&&o.y,0,100),r:num(o&&o.r,-180,180)})).filter(o=>o.id);
  const tot=Math.max(0,Number(st.tot)||0);
  return{
    name:v.name||"Игрок",bal:v.bal||0,on:Date.now()-v.seen<ONLINE_MS,
    pu:v.pv?pub(k):undefined,pv:v.pv,av:gid(v.av),
    user:/^[a-z][a-z0-9_]{4,19}$/.test(String(pr.user||""))?pr.user:"",
    num:gid(pr.num),st:gid(pr.st),col:/^[a-z]{3,10}$/.test(String(pr.col||""))?pr.col:"",bg,own,cp,lv:Math.floor(Math.sqrt(tot/3))+1
  };
}
// сохранить базу при остановке сервера, чтобы не терять последние секунды прогресса
function flush(){try{fs.writeFileSync(DB,JSON.stringify(P))}catch(e){}try{fs.writeFileSync(MK_DB,JSON.stringify(M))}catch(e){}}
async function shutdown(){
  flush();
  if(REMOTE&&ready){try{await Promise.race([(async()=>{if(saving)await saving;await persist(true)})(),new Promise(r=>setTimeout(r,8000))])}catch(e){}}
  process.exit(0);
}
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);
const server=http.createServer((req,res)=>{
  const h={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type"};
  if(req.method==="GET"&&req.url==="/healthz"){res.writeHead(200,{...h,"Content-Type":"application/json","Cache-Control":"no-store"});return res.end(JSON.stringify({ok:1,storage:REMOTE?"upstash":"disk",players:Object.keys(P).length,lots:M.lots.length}))}
  if(req.method==="OPTIONS"){res.writeHead(204,h);return res.end()}
  if(req.method==="POST"&&req.url==="/api/sync"){
    let d="";req.on("data",c=>{d+=c;if(d.length>65536)req.destroy()});
    req.on("end",async()=>{
      let out=null;
      try{
        const body=JSON.parse(d);out=sync(body);
        if(out&&out.ph===null&&REMOTE){const pid=who(body);const bf=pid?await remotePhoto(pub(pid)):null;if(bf)out.ph="data:image/jpeg;base64,"+bf.toString("base64")}
      }catch(e){}
      res.writeHead(out?200:400,{...h,"Content-Type":"application/json"});res.end(JSON.stringify(out||{error:1}));
    });return;
  }
  if(req.method==="POST"&&req.url==="/api/photo"){
    let d="";req.on("data",c=>{d+=c;if(d.length>150000)req.destroy()});
    req.on("end",()=>{
      let ok=false;try{ok=setPhoto(JSON.parse(d))}catch(e){}
      res.writeHead(ok?200:400,{...h,"Content-Type":"application/json"});res.end(JSON.stringify(ok?{ok:1}:{error:1}));
    });return;
  }
  if(req.method==="POST"&&MROUTES[req.url]){
    const fn=MROUTES[req.url];let d="";req.on("data",c=>{d+=c;if(d.length>65536)req.destroy()});
    req.on("end",()=>{
      let out=null;try{out=fn(JSON.parse(d))}catch(e){}
      res.writeHead(out?200:400,{...h,"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(out||{error:1}));
    });return;
  }
  const qm=req.method==="GET"&&/^\/api\/profile\/([a-f0-9]{16})(\?.*)?$/.exec(req.url);
  if(qm){
    const out=profile(qm[1]);
    res.writeHead(out?200:404,{...h,"Content-Type":"application/json","Cache-Control":"no-store"});return res.end(JSON.stringify(out||{error:1}));
  }
  const pm=req.method==="GET"&&/^\/api\/photo\/([a-f0-9]{16})\.jpg(\?.*)?$/.exec(req.url);
  if(pm){
    const send=buf=>{res.writeHead(200,{...h,"Content-Type":"image/jpeg","Cache-Control":"public, max-age=31536000, immutable","X-Content-Type-Options":"nosniff"});res.end(buf)};
    fs.readFile(path.join(PH,pm[1]+".jpg"),async(e,buf)=>{
      if(!e)return send(buf);
      const rb=await remotePhoto(pm[1]);
      if(rb)return send(rb);
      res.writeHead(404,h);res.end();
    });return;
  }
  if(req.method==="GET"&&(req.url==="/"||req.url.startsWith("/?"))){
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});return fs.createReadStream(path.join(__dirname,"index.html")).pipe(res);
  }
  res.writeHead(404);res.end();
});
// Важно: с Upstash сервер начинает работать только после успешной загрузки данных. Иначе пустая база могла бы затереть сохранённую.
(async()=>{
  if(REMOTE){
    for(let i=1;;i++){
      try{await loadRemote();break}
      catch(e){
        console.error("Upstash: не удалось загрузить данные ("+i+"/5):",e.message);
        if(i>=5){console.error("Останавливаюсь, чтобы не затереть данные пустой базой. Проверьте UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN.");process.exit(1)}
        await new Promise(r=>setTimeout(r,2000*i));
      }
    }
    ready=true;
  }
  server.listen(PORT,()=>console.log("http://localhost:"+PORT+(REMOTE?"  (хранилище: Upstash)":"  (хранилище: файлы)")));
})();
