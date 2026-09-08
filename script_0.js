
// Все запросы к cs2.sh идут через этот же Render-сервер.
// API-ключ никогда не попадает в браузер.
const API={
  catalog:'/api/cs2/catalog'
};
let USD_RUB_RATE=80;
const PRICE_CACHE_KEY='zeno_cs2sh_prices_v5';
let PRICE_MAP={};
let CATALOG_ITEMS=[],CASES_DATA=[];
let currentUser=null,currentTab='inventory';
let activeCase=null,isCaseSpinning=false,currentWonItem=null,currentWonItemsList=[];
let selectedItemIndex=null,targetWeapon=null,isSpinning=false,currentRotation=0,activeQuickChance=null;
let quickChances=[10,20,30,40,50,70],MAX_CHANCE=70,isFastSpinActive=false;
let selectedOpenCount=1;
const canvas=document.getElementById('wheelCanvas'),ctx=canvas.getContext('2d'),track=document.getElementById('rouletteTrack');

// Звуковой движок (Web Audio API)
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTickSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(430, now + 0.055);
    gain.gain.setValueAtTime(0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.06);
  } catch(e) {}
}

function playUpgradeSpinSound() {
  try {
    const ctx = getAudioContext(), now = ctx.currentTime;
    // Быстрые металлические "клики" как у монет/жетонов во время прокрутки.
    for(let i=0;i<12;i++){
      const t=now+i*0.075;
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='square';
      o.frequency.setValueAtTime(1050+(i%3)*180,t);
      o.frequency.exponentialRampToValueAtTime(520,t+0.035);
      g.gain.setValueAtTime(0.035,t);
      g.gain.exponentialRampToValueAtTime(0.001,t+0.045);
      o.connect(g);g.connect(ctx.destination);
      o.start(t);o.stop(t+0.05);
    }
  } catch(e) {}
}

function playUpgradeFailSound() {
  try {
    const ctx = getAudioContext(), now = ctx.currentTime;
    // Падение нескольких монет: короткие металлические звуки с понижением тона.
    [980,760,560,390].forEach((f,i)=>{
      const t=now+i*0.09;
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='triangle';
      o.frequency.setValueAtTime(f,t);
      o.frequency.exponentialRampToValueAtTime(f*0.62,t+0.075);
      g.gain.setValueAtTime(0.075,t);
      g.gain.exponentialRampToValueAtTime(0.001,t+0.09);
      o.connect(g);g.connect(ctx.destination);
      o.start(t);o.stop(t+0.095);
    });
  } catch(e) {}
}

function playCaseResultSound(value, price) {
  try {
    if (value >= price * 1.5) {
      const ctx = getAudioContext(), now = ctx.currentTime;
      [392, 523.25, 659.25, 783.99].forEach((f,i)=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.type='sine'; o.frequency.setValueAtTime(f,now+i*.07);
        g.gain.setValueAtTime(.08,now+i*.07);
        g.gain.exponentialRampToValueAtTime(.001,now+i*.07+.28);
        o.connect(g);g.connect(ctx.destination);o.start(now+i*.07);o.stop(now+i*.07+.3);
      });
    } else {
      const ctx=getAudioContext(),now=ctx.currentTime;
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sine';o.frequency.setValueAtTime(260,now);
      o.frequency.exponentialRampToValueAtTime(145,now+.18);
      g.gain.setValueAtTime(.035,now);g.gain.exponentialRampToValueAtTime(.001,now+.2);
      o.connect(g);g.connect(ctx.destination);o.start(now);o.stop(now+.21);
    }
  } catch(e) {}
}

function playSuccessSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);
      gain.gain.setValueAtTime(0.1, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.3);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + i * 0.08); osc.stop(now + i * 0.08 + 0.3);
    });
  } catch(e) {}
}

function playCaseSpinTick() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(320, ctx.currentTime);
    gain.gain.setValueAtTime(0.025, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.018);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.02);
  } catch(e) {}
}

async function getJSON(url){
  const r=await fetch(url,{cache:'no-store'});
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
}

function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escapeAttr(s){return escapeHtml(s)}
function cleanName(s){return String(s||'').trim().replace(/\\u2122/g,'™')}

function loadCachedPrices(){
  try{
    const x=JSON.parse(localStorage.getItem(PRICE_CACHE_KEY)||'null');
    if(x&&x.data){PRICE_MAP=x.data||{};return true;}
  }catch(e){}
  return false;
}
function saveSelectedCatalog(items){try{localStorage.setItem('zeno_selected_1500_v5',JSON.stringify({time:Date.now(),items}))}catch(e){}}
function loadSelectedCatalog(){try{const x=JSON.parse(localStorage.getItem('zeno_selected_1500_v5')||'null');if(x?.items?.length)return x.items}catch(e){}return null}
function finishIntro(){const el=document.getElementById('loadingScreen');if(!el)return;el.style.opacity='0';setTimeout(()=>el.style.display='none',420)}

function stableHash(str){let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}

function priceFromCs2Sh(item){
  if(!item)return 0;
  const sources=[item.steam,item.csfloat,item.buff,item.youpin,item.skinport,item.c5game];
  for(const src of sources){
    const p=Number(src?.ask);
    if(Number.isFinite(p)&&p>0)return Math.round(p*USD_RUB_RATE*100)/100;
  }
  return 0;
}

async function loadUsdRubRate(){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),3000);
  try{
    const r=await fetch('/api/usd-rub',{cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal});
    if(!r.ok)return;
    const d=await r.json();
    const rate=Number(d?.rate);
    if(Number.isFinite(rate)&&rate>0)USD_RUB_RATE=rate;
  }catch(e){
    console.warn('USD/RUB rate unavailable, using fallback rate',e);
  }finally{clearTimeout(timer);}
}
function normalizeSkin(x,i){
  const name=cleanName(x.market_hash_name||x.name||('Skin #'+i));
  const slug='skin_'+stableHash(name).toString(36);
  const image=x.image||x.icon_url||x.image_url||'';
  return {id:slug,name,category:'skins',value:0,img:image,api:x};
}
function findApiSkin(name){if(!name)return null;const n=cleanName(name).toLowerCase();return CATALOG_ITEMS.find(x=>x.name.toLowerCase()===n)||CATALOG_ITEMS.find(x=>x.name.toLowerCase().replace(/\s*\([^)]*\)$/,'')===n.replace(/\s*\([^)]*\)$/,''))||null}

async function fetchCs2ShJSON(url,options={}){
  const headers={Accept:'application/json',...(options.headers||{})};
  const r=await fetch(url,{...options,headers,cache:'no-store'});
  if(!r.ok){
    let message='HTTP '+r.status;
    try{
      const data=await r.clone().json();
      if(data?.error)message+= ': '+data.error;
      if(data?.message)message+= ': '+data.message;
    }catch(e){}
    throw new Error(message);
  }
  return r.json();
}

async function loadCs2ShCatalog(){
  const data=await fetchCs2ShJSON(API.catalog);
  const raw=data?.items||[];
  const arr=Array.isArray(raw)?raw:Object.values(raw||{});
  const items=arr.map((x,i)=>{
    const name=cleanName(x?.name||x?.market_hash_name||'');
    const image=x?.img||x?.image||x?.icon_url||x?.image_url||'';
    const usd=Number(x?.usd||x?.price_usd||0);
    const value=usd*USD_RUB_RATE;
    return {
      id:x?.id||('skin_'+stableHash(name).toString(36)+'_'+i),
      name,
      category:'skins',
      value,
      usd,
      img:image,
      api:x?.api||x
    };
  }).filter(x=>x.name&&x.img&&Number.isFinite(x.value)&&x.value>=8);
  items.sort((a,b)=>a.value-b.value);
  return items;
}

// Более мягкая экономика кейсов: окупаемые дропы встречаются чаще,
// но дорогие x2+ всё ещё остаются редкими. В среднем система сохраняет небольшой house edge.
function chooseBand(price){
  return [
    {min:price*5.00,max:price*12.00,p:1.0,label:'JACKPOT'},
    {min:price*2.50,max:price*5.00,p:4.0,label:'MEGA'},
    {min:price*1.20,max:price*2.50,p:15.0,label:'BIG'},
    {min:price*0.90,max:price*1.20,p:40.0,label:'FLAT'},
    {min:price*0.62,max:price*0.90,p:40.0,label:'LOSS'}
  ];
}
function chooseBandWithPity(price,userStats){
  let r=Math.random()*100;
  const bands=chooseBand(price);
  for(const b of bands){if(r<b.p)return b;r-=b.p;}
  return bands[bands.length-1];
}
function pickFromBand(items,band){
  let pool=items.filter(x=>x.value>=band.min&&x.value<band.max);
  if(!pool.length){
    // Никогда не подменяем выигрыш случайным предметом из другого диапазона.
    // Берём ближайший по цене только если в конкретном кейсе нет точного диапазона.
    pool=items.slice().sort((a,b)=>Math.abs(a.value-(band.min+band.max)/2)-Math.abs(b.value-(band.min+band.max)/2)).slice(0,8);
  }
  return pool[Math.floor(Math.random()*pool.length)]||items[0];
}
function buildCaseContents(price,index){
  const valid=CATALOG_ITEMS.filter(x=>x&&x.img&&Number(x.value)>=8);
  if(!valid.length)return [];
  const pools={
    loss:valid.filter(x=>x.value>=Math.max(8,price*.62)&&x.value<price*.90),
    flat:valid.filter(x=>x.value>=price*.90&&x.value<price*1.20),
    big:valid.filter(x=>x.value>=price*1.20&&x.value<price*2.50),
    mega:valid.filter(x=>x.value>=price*2.50&&x.value<price*5.00),
    jackpot:valid.filter(x=>x.value>=price*5.00&&x.value<price*12.00)
  };
  const used=new Set(),out=[];
  const addRandom=(pool,n)=>{
    const shuffled=pool.slice().sort(()=>Math.random()-.5);
    for(const x of shuffled){if(out.length>=n)break;if(!used.has(x.id)){used.add(x.id);out.push({...x});}}
  };
  addRandom(pools.loss,36);
  addRandom(pools.flat,28);
  addRandom(pools.big,18);
  addRandom(pools.mega,10);
  addRandom(pools.jackpot,8);
  // Если редкий диапазон пуст, добиваем ближайшими по цене, но не ломаем реальные цены.
  if(out.length<100){
    const rest=valid.slice().sort((a,b)=>Math.abs(a.value-price)-Math.abs(b.value-price));
    addRandom(rest,100-out.length);
  }
  while(out.length<100)out.push({...valid[Math.floor(Math.random()*valid.length)]});
  return out.slice(0,100);
}

function hashCode(str){let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}

// Произвольные картинки кейсов
const CASE_IMAGES = {
  13: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpovbSsLQJf2PLacDBA5ciJn7-MhvnwNrTglIhC68sh3r2Yrdms2Vbtr0VuYWmmLYOQJgE9M1jWqFS8ku6808e068vJn3Ngu3Ur-z-DyG2w7g/360fx360f',
  25: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgposr-kLAtl7PLZTjlH_9mkgL-OmuLwNqvUn35u5sR1jteWpI-j2wK2rkA5a2Dyd46Ue1U6N16G8gO_l-a9jZK96M_MnXJlvHRx5yzemEexhwYMMLJ4B4v97w/360fx360f',
  50: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot621FBRw7P7NYjV95N24j4yOhvLjJ4Tdn2xZ_Ipmj-vEo4j02wDjqUY-Y2v2co_Edwc6ZArYqFi_yOa6gMO5vsuZyXQw7yMgsn7Vnxezgx1IcKU807I9Ew/360fx360f',
  100: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpopujwezhmrP7PYSRD49GJlY20kPf9J4Tdn2xZ_IpmibvEp4-giQO1r1VtZ2ChJ9SSIAc3MwmEr1ntkLzoh8K_v52Zn3Uxu3Ur5n3UmB22hBtEa_swh7jRMgE/360fx360f',
  200: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpotLu8JAllx8zJYQJD_9O7m5O0m_7zO6-fkDgOvpt03uuToIqgjQO1qUdsMTqmLY_EdwZsYF-FqVK-lbjsgJ7puZ2fy3RlpCkm5XqMmxC1hElHO-Nvz7uVJQo/360fx360f',
  500: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV09-5lpKKqPrxN7LEmyVQ7MEpiLuSrYmt3wK3-kZsZj2nd4-cd1VoZAvR8li5k7q-05a-uMmdmyRqvHVysnfD30xgmR0g/360fx360f',
  1000: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot621FBRw7P7NYjV95N24j4yOhvLjJ4Tdn2xZ_Ipmj-vEo4j02wDjqUY-Y2v2co_Edwc6ZArYqFi_yOa6gMO5vsuZyXQw7yMgsn7Vnxezgx1IcKU807I9Ew/360fx360f',
  2500: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot7HxfDhjxszJemkV09-5lpKKqPrxN7LEmyVQ7MEpiLuSrYmt3wK3-kZsZj2nd4-cd1VoZAvR8li5k7q-05a-uMmdmyRqvHVysnfD30xgmR0g/360fx360f',
  5000: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot621FBRw7P7NYjV95N24j4yOhvLjJ4Tdn2xZ_Ipmj-vEo4j02wDjqUY-Y2v2co_Edwc6ZArYqFi_yOa6gMO5vsuZyXQw7yMgsn7Vnxezgx1IcKU807I9Ew/360fx360f',
  10000: 'https://community.cloudflare.steamstatic.com/economy/image/-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpopujwezhmrP7PYSRD49GJlY20kPf9J4Tdn2xZ_IpmibvEp4-giQO1r1VtZ2ChJ9SSIAc3MwmEr1ntkLzoh8K_v52Zn3Uxu3Ur5n3UmB22hBtEa_swh7jRMgE/360fx360f'
};

function getRandomCaseSkinImage(fallback){
  // Для иконок кейсов берём не только ножи, а обычные оружейные скины тоже.
  // Ножи оставляем как редкий вариант, чтобы кейсы выглядели разнообразнее.
  const all=CATALOG_ITEMS.filter(x=>{
    if(!x?.img) return false;
    const n=String(x?.name||'').toLowerCase();
    if(n.includes('sticker') || n.includes('agent') || n.includes('gloves')) return false;
    return n.includes('|');
  });
  if(!all.length)return fallback||'';

  const regular=all.filter(x=>!/^★\s/.test(String(x.name||'')));
  const knives=all.filter(x=>/^★\s/.test(String(x.name||'')));
  const pool=(regular.length && Math.random()<0.82) ? regular : (knives.length ? knives : regular);
  return pool[Math.floor(Math.random()*pool.length)]?.img || fallback || '';
}

function buildCases(){
  const prices=[13,25,50,100,200,500,1000,2500,5000,10000];
  const names=['Мини','Старт','Неон','Бронза','Серебро','Классик','Феникс','Рейд','Охотник','Премиум'];
  window.__zenoAssigned=new Set();
  CASES_DATA=prices.map((price,i)=>({
    id:'case_'+price,
    name:'Кейс '+names[i],
    price,
    img:getRandomCaseSkinImage(CASE_IMAGES[price]||''),
    items:buildCaseContents(price,i)
  }));
}

function newInventoryUid(){
  try{if(window.crypto?.randomUUID)return window.crypto.randomUUID();}catch(e){}
  return 'inv_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
}
function isWithdrawalLocked(item){
  if(!item || !currentUser?.serverAccount)return false;
  const list=Array.isArray(currentUser.serverAccount.pendingWithdrawals)?currentUser.serverAccount.pendingWithdrawals:[];
  return list.some(w=>{
    if(w.itemUid && item.uid) return w.itemUid===item.uid;
    // Совместимость со старыми заявками, созданными до UID.
    const legacyName=w.itemName||w.name;
    const legacyValue=Number(w.itemValue||w.value);
    return !w.itemUid && legacyName===item.name && Number(item.value)===legacyValue;
  });
}
function withdrawalLockText(item){return isWithdrawalLocked(item)?'Скин уже находится в заявке на вывод':'';}
function ensureInventoryUids(user){
  if(!user || !Array.isArray(user.inventory))return;
  user.inventory.forEach(x=>{if(!x.uid)x.uid=newInventoryUid();});
}

function defaultUser(steamUser){
  return {
    steamid: steamUser ? steamUser.steamid : null,
    username: steamUser ? steamUser.username : 'Игрок Zenodrop',
    avatar: steamUser ? steamUser.avatar : 'https://avatars.steamstatic.com/c85433a0be124faee4587db1ad2649b380a9fc77_full.jpg',
    balance: 3500,
    stats: {upgradesTotal:0, casesOpened:0, totalDeposited:0},
    bestDrop: {name:'--', value:0, img:''},
    inventory: CATALOG_ITEMS.slice(0,3).map(x=>({...x,uid:newInventoryUid()}))
  };
}

function normalizeUser(user, steamUser){
  if(!user||typeof user!=='object')return defaultUser(steamUser);
  if(steamUser) {
    user.steamid = steamUser.steamid;
    user.username = steamUser.username;
    user.avatar = steamUser.avatar;
  }
  if(typeof user.balance!=='number')user.balance=3500;
  if(!user.stats)user.stats={upgradesTotal:0,casesOpened:0,totalDeposited:0};
  ['upgradesTotal','casesOpened','totalDeposited'].forEach(k=>{if(typeof user.stats[k]!=='number')user.stats[k]=0});
  if(!user.bestDrop)user.bestDrop={name:'--',value:0,img:''};
  if(!Array.isArray(user.inventory))user.inventory=[];
  user.inventory.forEach(x=>{const a=findApiSkin(x.name);if(a){x.id=a.id;x.name=a.name;x.img=a.img;x.value=a.value}});
  ensureInventoryUids(user);
  return user;
}
function saveUserData(){if(!currentUser || !currentUser.steamid)return;localStorage.setItem('zeno_local_user_' + currentUser.steamid,JSON.stringify(currentUser));fetch('/api/account/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({balance:currentUser.balance,stats:currentUser.stats})}).then(r=>r.ok?r.json():null).then(d=>{if(d?.user)currentUser.serverAccount=d.user}).catch(()=>{})}

function initSteamAuth(){window.location.href = '/auth/steam';}

function updateAuthUI(){
  const btn = document.getElementById('steamAuthBtn');
  const profileBtn = document.getElementById('headerProfileBtn');
  if(currentUser && currentUser.steamid){
    if(btn) btn.style.display = 'none';
    if(profileBtn) profileBtn.style.display = 'flex';
    updateHeaderAvatar();
  } else {
    if(btn) btn.style.display = 'flex';
    if(profileBtn) profileBtn.style.display = 'none';
  }
}

async function initializeApp(){
  try{
    let steamUser=null;
    try{const res=await fetch('/api/current-user');steamUser=await res.json();}catch(e){}
    if(steamUser&&steamUser.steamid){
      const saved=JSON.parse(localStorage.getItem('zeno_local_user_'+steamUser.steamid)||'null');
      currentUser=saved?normalizeUser(saved,steamUser):defaultUser(steamUser);
    }else currentUser=defaultUser(null);
    if(steamUser?.serverAccount){ currentUser.balance=Number(steamUser.serverAccount.balance)||0; currentUser.serverAccount=steamUser.serverAccount; currentUser.webAdmin=!!steamUser.webAdmin; currentUser.tgId=steamUser.serverAccount.tgId||null; }

    loadCachedPrices();
    loadUsdRubRate().catch(()=>{});
    const cached=loadSelectedCatalog();
    if(cached){
      CATALOG_ITEMS=cached.map(x=>({...x}));
      CATALOG_ITEMS=CATALOG_ITEMS.filter(x=>Number(x.value)>=8&&x.img);
      buildCases();renderQuickChances();updateAuthUI();switchMainTab('cases');loadPromoCodes();finishIntro();
      // Обновляем реальные цены в фоне через cs2.sh.
      loadCs2ShCatalog().then(items=>{
        if(items?.length){CATALOG_ITEMS=items;saveSelectedCatalog(CATALOG_ITEMS);buildCases();renderGrid();updateUI();}
      }).catch(e=>console.warn('cs2.sh background update failed',e));
      return;
    }

    CATALOG_ITEMS=await loadCs2ShCatalog();
    if(!CATALOG_ITEMS.length)throw new Error('cs2.sh не вернул предметы с ценами');
    saveSelectedCatalog(CATALOG_ITEMS);
    buildCases();renderQuickChances();updateAuthUI();switchMainTab('cases');loadPromoCodes();finishIntro();
  }catch(e){
    console.error(e);
    // Без искусственных цен: при ошибке API показываем понятное состояние вместо выдуманных цен.
    CATALOG_ITEMS=[];
    buildCases();renderQuickChances();updateAuthUI();switchMainTab('cases');loadPromoCodes();finishIntro();
    alert('Не удалось загрузить цены CS2. Проверь API-ключ на Render и серверные маршруты.');
  }
}
function updateHeaderAvatar(){
  const b=document.getElementById('headerAvatarContainer');
  if(!b)return;
  b.innerHTML=currentUser?.avatar?`<img src="${escapeAttr(currentUser.avatar)}" alt="Avatar">`:'<div style="width:100%;height:100%;background:#333"></div>';
}

function switchMainTab(tab){
  if(isCaseSpinning && tab!=='cases')return;
  if(tab!=='cases')resetCaseResultState();
  ['navUpgrade','navCases','navProfile'].forEach(x=>document.getElementById(x).classList.remove('active'));
  ['tabUpgradeContent','tabCasesContent','tabProfileContent'].forEach(x=>document.getElementById(x).classList.remove('active'));
  if(tab==='upgrade'){
    document.getElementById('navUpgrade').classList.add('active');
    document.getElementById('tabUpgradeContent').classList.add('active');
    renderGrid();updateUI();
  }
  else if(tab==='cases'){
    document.getElementById('navCases').classList.add('active');
    document.getElementById('tabCasesContent').classList.add('active');
    document.getElementById('caseOpeningView').classList.remove('active');
    document.getElementById('casesListContainer').style.display='flex';
    renderCasesList();
  }
  else{
    document.getElementById('navProfile').classList.add('active');
    document.getElementById('tabProfileContent').classList.add('active');
    renderProfile();
  }
}
function switchCatalogTab(t){currentTab=t;['tabInventory','tabCatalogSkins'].forEach(x=>document.getElementById(x).classList.remove('active'));document.getElementById({inventory:'tabInventory',skins:'tabCatalogSkins'}[t]).classList.add('active');renderGrid()}

function renderProfile(){
  const a=document.getElementById('profileContentArea'),s=currentUser.stats,b=currentUser.bestDrop;
  if(!a)return;
  if(!currentUser.steamid) {
    a.innerHTML=`<div class="profile-main-card" style="text-align:center;padding:30px 16px;">
      <div style="font-size:14px;font-weight:800;color:#fff;margin-bottom:12px;">Требуется авторизация</div>
      <p style="font-size:12px;color:#9ca3af;margin-bottom:16px;">Войдите через Steam, чтобы получить доступ к профилю, инвентарю и балансу.</p>
      <button class="topup-btn" onclick="initSteamAuth()"><svg class="steam-icon" viewBox="0 0 24 24" aria-hidden="true">
<defs><linearGradient id="steamGrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#66c0f4"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
<circle cx="16.9" cy="7.1" r="4.1" fill="none" stroke="url(#steamGrad)" stroke-width="2"/>
<circle cx="6.2" cy="16.9" r="3.1" fill="none" stroke="url(#steamGrad)" stroke-width="2"/>
<path d="M8.9 15.1 14.2 10.2" fill="none" stroke="url(#steamGrad)" stroke-width="2.2" stroke-linecap="round"/>
<circle cx="16.9" cy="7.1" r="1.35" fill="#fff"/>
<circle cx="6.2" cy="16.9" r="1" fill="#fff"/>
</svg><span>Войти через Steam</span></button>
    </div>`;
    return;
  }
  a.innerHTML=`<div class="profile-main-card">
    <div class="profile-top-row">
      <div class="profile-username">${escapeHtml(currentUser.username)}</div>
      <a href="/auth/logout" style="color:#f87171;font-size:11px;text-decoration:none;font-weight:700;">Выйти</a>
    </div>
    <div class="profile-center-row">
      <div class="profile-avatar-large">${currentUser.avatar?`<img src="${escapeAttr(currentUser.avatar)}">`:''}</div>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-title">Апгрейды</div><div class="stat-value">${s.upgradesTotal}</div></div>
      <div class="stat-card"><div class="stat-title">Кейсы</div><div class="stat-value">${s.casesOpened}</div></div>
      <div class="stat-card"><div class="stat-title">Депозит</div><div class="stat-value">${s.totalDeposited} ₽</div></div>
    </div>
    <div class="profile-balance-row">
      <div><div class="balance-amount">${currentUser.balance.toFixed(2)} ₽</div><div class="balance-history">Баланс</div></div>
      <button class="topup-btn" onclick="topUpBalance()">Пополнить</button>
    </div>
  </div>
  ${currentUser.webAdmin?`<div class="admin-box"><div style="font-size:12px;font-weight:900;color:#f59e0b">ADMIN PANEL</div><div class="admin-row"><input id="adminSteamId" class="admin-input" placeholder="Steam ID"><input id="adminAmount" class="admin-input" type="number" placeholder="Баланс"><button class="admin-btn" onclick="adminGiveBalance()">Выдать</button><button class="admin-btn" onclick="adminToggleWithdraw()">Вывод ON/OFF</button></div><div class="admin-row"><input id="adminPromoCode" class="admin-input" placeholder="PROMO"><input id="adminPromoPercent" class="admin-input" type="number" placeholder="%"><button class="admin-btn" onclick="adminCreatePromo()">Промо</button></div><div id="adminState" class="promo-small">Загрузка...</div></div>`:''}
  <div class="best-drop-card">
    <div class="best-drop-title">Лучший дроп</div>
    <div class="best-drop-content">
      <div><div class="best-drop-name">${escapeHtml(b.name)}</div><div class="best-drop-price">${b.value>0?b.value.toFixed(2)+' ₽':'--'}</div></div>
      ${b.img?`<img src="${escapeAttr(b.img)}" class="best-drop-img">`:''}
    </div>
  </div>
  <div class="profile-inventory-box">
    <div class="inv-header-row">
      <div style="font-size:13px;font-weight:900;color:#fff;text-transform:uppercase">Инвентарь (${currentUser.inventory.length})</div>
      ${currentUser.inventory.length > 0 ? '<button class="sell-all-btn" onclick="sellAllProfileItems()">Продать все</button>' : ''}
    </div>
    <div class="items-grid profile-items-grid" id="profileItemsGrid"></div>
  </div>`;
  renderProfileInventory();
}

let selectedPaymentMethod='СБП';
let promoExpiresAt=0;
let promoTimer=null;
const PAYMENT_META={
  'СБП':{icon:'',title:'СБП',text:'Пополнение через СБП. Заявка создаётся на сайте, без оплаты через Telegram.'},
  'Карты':{icon:'',title:'Банковская карта',text:'Пополнение картой. Заявка и сумма фиксируются на сайте.'},
  'Крипта':{icon:'',title:'Криптовалюта',text:'Выберите этот способ для крипто-пополнения. Заявка создаётся отдельно от Telegram.'},
  'Telegram':{icon:'',title:'Telegram-бот',text:'Отдельный способ пополнения: откроется бот Zenodrop для оплаты через Telegram.'},
  'Скины':{icon:'',title:'Скины',text:'Пополнение балансом за переданные CS2-скины.'}
};
function topUpBalance(){if(!currentUser?.steamid){alert('Сначала войдите через Steam!');return;}document.getElementById('topupModal').classList.add('active');selectPaymentMethod(selectedPaymentMethod);loadPromoCodes();updateDepositPreview();}
function closeTopup(){document.getElementById('topupModal')?.classList.remove('active');}
function selectPaymentMethod(method){selectedPaymentMethod=method;document.querySelectorAll('.payment-tab').forEach(x=>x.classList.toggle('active',x.dataset.method===method));const m=PAYMENT_META[method]||PAYMENT_META['СБП'];const icon=document.getElementById('paymentIcon');if(icon)icon.textContent=m.icon;document.getElementById('paymentTitle').textContent=m.title;document.getElementById('paymentInfo').textContent=m.text;const main=document.getElementById('depositMainAction'),tg=document.getElementById('telegramDepositAction');if(method==='Telegram'){main.style.display='none';tg.style.display='block';}else{main.style.display='block';tg.style.display='none';}}
function setDepositAmount(v){const i=document.getElementById('depositAmount');i.value=v;updateDepositPreview();}
function updateDepositPreview(){const amount=Number(document.getElementById('depositAmount')?.value||0);const p=document.getElementById('depositPromo')?.value.trim().toUpperCase();const el=document.getElementById('promoActiveText');if(!el)return;if(!p){el.textContent='';return;}fetch('/api/promos').then(r=>r.json()).then(d=>{const x=(d.items||[]).find(a=>a.code===p);el.textContent=x?`Бонус ${Number(x.percent).toFixed(0)}% → +${(amount*Number(x.percent)/100).toFixed(2)} ₽`:'Промокод не найден или уже истёк';}).catch(()=>{});}
async function openTelegramDeposit(){const win=window.open('about:blank','_blank');try{const r=await fetch('/api/config');const d=await r.json();if(d.telegramBotUrl){const url=d.telegramBotUrl+(d.telegramBotUrl.includes('?')?'&':'?')+'start=deposit';if(win)win.location=url;else window.location=url;}else{if(win)win.close();alert('Telegram-бот пока не настроен. Добавь TELEGRAM_BOT_URL в Render.');}}catch(e){if(win)win.close();alert('Не удалось открыть Telegram-бота.');}}
async function createDepositRequest(){const amount=Number(document.getElementById('depositAmount').value),promo=document.getElementById('depositPromo').value.trim();const out=document.getElementById('depositResult');if(selectedPaymentMethod==='Telegram'){openTelegramDeposit();return;}if(!Number.isFinite(amount)||amount<50){out.textContent='Минимальная сумма — 50 ₽.';return;}try{const r=await fetch('/api/deposit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount,method:selectedPaymentMethod,promo})});const d=await r.json();if(!r.ok)throw new Error(d.error==='promo_invalid'?'Промокод недействителен или уже истёк':d.error||'Ошибка');out.textContent=`Заявка ${d.id} создана. К начислению: ${Number(d.total||amount).toFixed(2)} ₽. Оплата по выбранному способу выполняется отдельно от Telegram.`;}catch(e){out.textContent='Не удалось создать заявку: '+e.message;}}
async function loadPromoCodes(openModal=false){try{const r=await fetch('/api/promos');const d=await r.json();const items=(d.items||[]).slice(0,1);const el=document.getElementById('promoCodesBlock');if(el)el.innerHTML=items.map(x=>`<span class="promo-chip" onclick="document.getElementById('depositPromo').value='${escapeAttr(x.code)}';topUpBalance()">${escapeHtml(x.code)} <span>+${Number(x.percent).toFixed(0)}%</span></span>`).join('');const auto=items.find(x=>x.auto)||items[0];if(auto){promoExpiresAt=Number(auto.expiresAt||0);const inp=document.getElementById('depositPromo');if(inp&&!inp.value&&openModal)inp.value=auto.code;}if(promoTimer)clearInterval(promoTimer);promoTimer=setInterval(()=>{const left=Math.max(0,promoExpiresAt-Date.now());const min=Math.floor(left/60000),sec=Math.floor((left%60000)/1000);const el2=document.getElementById('promoActiveText'),el3=document.getElementById('promoHeadingTimer');const timerText=auto?`Действует ${auto.code}: +${Number(auto.percent).toFixed(0)}% · обновление через ${min}:${String(sec).padStart(2,'0')}`:'';if(el2&&!document.getElementById('depositPromo').value)el2.textContent=timerText;if(el3)el3.textContent=timerText;if(left<=0){loadPromoCodes(false);}},1000);}catch(e){}}


async function adminGiveBalance(){const steam=document.getElementById('adminSteamId')?.value.trim(),amount=Number(document.getElementById('adminAmount')?.value);if(!/^\d{17}$/.test(steam)||!amount)return alert('Укажи Steam ID и сумму');const r=await fetch('/api/admin/user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({steamid:steam,balanceDelta:amount})});const d=await r.json();alert(r.ok?`Баланс: ${Number(d.user.balance).toFixed(2)} ₽`:d.error);}
async function adminToggleWithdraw(){const steam=document.getElementById('adminSteamId')?.value.trim();if(!/^\d{17}$/.test(steam))return alert('Укажи Steam ID');const r=await fetch('/api/admin/user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({steamid:steam,withdrawDisabled:true})});const d=await r.json();alert(r.ok?'Вывод отключён':d.error)}
async function adminCreatePromo(){const code=document.getElementById('adminPromoCode')?.value.trim().toUpperCase(),percent=Number(document.getElementById('adminPromoPercent')?.value);if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!percent)return alert('Укажи код и процент');const r=await fetch('/api/admin/promo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,percent})});const d=await r.json();if(!r.ok)return alert(d.error||'Ошибка');alert('Промокод '+d.promo.code+' создан');loadPromoCodes();}
function renderProfileInventory(){
  const g = document.getElementById('profileItemsGrid');
  if (!g) return;
  g.innerHTML = '';
  if (currentUser.inventory.length === 0) {
    g.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #6b7280; font-size: 12px; padding: 20px;">Инвентарь пуст</div>';
    return;
  }
  currentUser.inventory.forEach((x, index) => {
    const c = document.createElement('div');
    c.className = 'item-card';
    c.style.cursor = 'default';
    c.innerHTML = `
      <img src="${escapeAttr(x.img)}" alt="">
      <div class="iname">${escapeHtml(x.name)}</div>
      <div class="iprice">${x.value.toFixed(2)} ₽</div>
      <div class="item-card-actions">
        <button class="mini-action-btn" title="${isWithdrawalLocked(x)?'Скин в заявке на вывод':'Выбрать для апгрейда'}" ${isWithdrawalLocked(x)?'disabled style="opacity:.35;cursor:not-allowed"':''} onclick="event.stopPropagation(); sendItemToUpgrade(${index})">Выбрать</button>
        <button class="mini-action-btn" title="${isWithdrawalLocked(x)?'Скин в заявке на вывод':'Продать'}" ${isWithdrawalLocked(x)?'disabled style="opacity:.35;cursor:not-allowed"':''} onclick="event.stopPropagation(); sellProfileItem(${index})"><svg class="inv-action-icon" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v5c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 11v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/></svg></button>
        <button class="mini-action-btn steam-mini-btn" title="Вывести в Steam" onclick="event.stopPropagation(); withdrawProfileItem(${index})"><svg class="steam-icon" viewBox="0 0 24 24" aria-hidden="true">
<defs><linearGradient id="steamGrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#66c0f4"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>
<circle cx="16.9" cy="7.1" r="4.1" fill="none" stroke="url(#steamGrad)" stroke-width="2"/>
<circle cx="6.2" cy="16.9" r="3.1" fill="none" stroke="url(#steamGrad)" stroke-width="2"/>
<path d="M8.9 15.1 14.2 10.2" fill="none" stroke="url(#steamGrad)" stroke-width="2.2" stroke-linecap="round"/>
<circle cx="16.9" cy="7.1" r="1.35" fill="#fff"/>
<circle cx="6.2" cy="16.9" r="1" fill="#fff"/>
</svg></button>
      </div>
    `;
    g.appendChild(c);
  });
}

function sendItemToUpgrade(index) {
  const item = currentUser.inventory[index];
  if (!item) return;
  if (isWithdrawalLocked(item)) { alert('Этот скин уже находится в заявке на вывод. Дождитесь обработки заявки.'); return; }
  switchMainTab('upgrade');
  const invIndex = currentUser.inventory.findIndex(x => x.uid===item.uid);
  if (invIndex !== -1) {
    selectedItemIndex = invIndex;
    activeQuickChance = null;
    targetWeapon = null;
    renderQuickChances();
    renderGrid();
    updateUI();
  }
}

function sellProfileItem(index) {
  const item = currentUser.inventory[index];
  if (!item) return;
  if (isWithdrawalLocked(item)) { alert('Этот скин уже находится в заявке на вывод. Дождитесь обработки заявки.'); return; }
  currentUser.balance += item.value;
  currentUser.inventory.splice(index, 1);
  saveUserData();
  renderProfile();
}

async function withdrawProfileItem(index){
  const item=currentUser.inventory[index];
  if(!item)return;
  if(!currentUser?.steamid){alert('Сначала войдите через Steam!');return;}
  if(currentUser.serverAccount?.withdrawDisabled){alert('Для этого аккаунта вывод скинов отключён.');return;}
  if(isWithdrawalLocked(item)){alert('Этот скин уже находится в заявке на вывод. Дождитесь обработки заявки.');return;}
  if(!confirm(`Создать заявку на вывод ${item.name} за ${Number(item.value).toFixed(2)} ₽?`))return;
  try{
    const r=await fetch('/api/withdrawals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index,item})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error==='item_withdraw_pending'?'Этот скин уже находится в заявке на вывод.':(d.error||'Ошибка'));
    if(!currentUser.serverAccount)currentUser.serverAccount={};
    if(!Array.isArray(currentUser.serverAccount.pendingWithdrawals))currentUser.serverAccount.pendingWithdrawals=[];
    currentUser.serverAccount.pendingWithdrawals.push({id:d.id,itemUid:item.uid,status:'pending',index});
    saveUserData();
    renderProfile();
    renderGrid();
    updateUI();
    alert(`Заявка ${d.id} отправлена в Telegram-бот. Скин заблокирован для продажи и апгрейда.`);
  }catch(e){alert('Ошибка вывода: '+e.message);}
}

function sellAllProfileItems() {
  if (currentUser.inventory.length === 0) return;
  const unlocked=currentUser.inventory.filter(item=>!isWithdrawalLocked(item));
  if(unlocked.length===0){alert('Все скины находятся в заявках на вывод.');return;}
  const totalSum = unlocked.reduce((acc, item) => acc + item.value, 0);
  currentUser.balance += totalSum;
  currentUser.inventory = currentUser.inventory.filter(item=>isWithdrawalLocked(item));
  saveUserData();
  renderProfile();
  renderGrid();
  updateUI();
  alert(`Продано: ${unlocked.length} скин(ов) на ${totalSum.toFixed(2)} ₽. Скины в заявках на вывод не тронуты.`);
}

function renderCasesList(){
  const g=document.getElementById('casesGrid');if(!g)return;g.innerHTML='';
  CASES_DATA.forEach(c=>{
    const d=document.createElement('div');
    d.className='case-card';
    d.innerHTML=`
      <div class="case-card-glow"></div>
      <div class="case-topline"><span>CASE</span><b>${c.price} ₽</b></div>
      <img src="${escapeAttr(c.img)}" alt="">
      <div class="case-title">${escapeHtml(c.name)}</div>
      <div class="case-price">Открыть · ${c.price} ₽</div>`;
    d.onclick=()=>openCaseScreen(c);
    g.appendChild(d);
  });
}

function selectOpenCount(count){
  if(isCaseSpinning)return;
  selectedOpenCount=Math.max(1,Math.min(5,Number(count)||1));
  document.querySelectorAll('.multi-btn[data-count]').forEach(btn=>{
    btn.classList.toggle('active',Number(btn.dataset.count)===selectedOpenCount);
  });
  const btn=document.getElementById('mainOpenBtn');
  if(btn)btn.textContent=`Открыть ${selectedOpenCount}×`;
}

function resetCaseResultState(){
  if(isCaseSpinning)return;
  currentWonItem=null;
  currentWonItemsList=[];
  const actionButtons=document.getElementById('actionButtons');
  const caseActionsPanel=document.getElementById('caseActionsPanel');
  if(actionButtons)actionButtons.style.display='none';
  if(caseActionsPanel)caseActionsPanel.style.display='flex';
}
function openCaseScreen(c){
  if(isCaseSpinning)return;
  resetCaseResultState();
  selectOpenCount(1);
  activeCase=c;
  document.getElementById('casesListContainer').style.display='none';
  document.getElementById('caseOpeningView').classList.add('active');
  document.getElementById('activeCaseTitle').textContent=c.name+' · '+c.price+' ₽';
  renderCaseContents();
  renderTrack();
}
function closeCaseOpening(){
  if(isCaseSpinning)return;
  resetCaseResultState();
  document.getElementById('caseOpeningView').classList.remove('active');
  document.getElementById('casesListContainer').style.display='flex';
}
function renderCaseContents(){const g=document.getElementById('caseContentsGrid');if(!g||!activeCase)return;g.innerHTML='';activeCase.items.forEach(x=>g.appendChild(createCard(x,false,()=>{})))}

function renderTrack(){
  if(!activeCase)return;
  let h='';
  for(let i=0;i<8;i++) {
    activeCase.items.forEach(x=> {
      h+=`<div class="roulette-item"><img src="${escapeAttr(x.img)}"><strong>${escapeHtml(x.name)}</strong></div>`;
    });
  }
  track.innerHTML=h;
}

function startOpening(count){
  count=Math.max(1,Math.min(5,Number(count)||selectedOpenCount||1));
  if(!currentUser || !currentUser.steamid){ alert('Для открытия кейсов необходимо войти через Steam!'); return; }
  if(isCaseSpinning||!activeCase)return;
  const totalPrice=activeCase.price*count;
  if(currentUser.balance<totalPrice){alert('Недостаточно средств!');return}

  currentUser.balance-=totalPrice;
  currentUser.stats.casesOpened+=count;
  saveUserData();
  isCaseSpinning=true;
  document.getElementById('caseActionsPanel').style.display='none';
  document.getElementById('actionButtons').style.display='none';
  track.style.transition='none';track.style.transform='translate3d(0,0,0)';

  currentWonItemsList=[];
  for(let i=0;i<count;i++){
    const band=chooseBandWithPity(activeCase.price,currentUser.stats);
    currentWonItemsList.push(pickFromBand(activeCase.items,band));
  }
  currentWonItem=currentWonItemsList[0];

  const idx=activeCase.items.findIndex(x=>x.id===currentWonItem.id);
  // 112px карточка + 12px gap + 6px padding-left = 124px шаг.
  // Центрируем именно выигрышную карточку под указателем, чтобы визуальный дроп
  // совпадал с тем предметом, который реально попадает в инвентарь.
  const itemWidth=112, gap=12, leftPad=6, step=itemWidth+gap;
  const cycles=5;
  const containerWidth=document.querySelector('.roulette-container')?.clientWidth||360;
  const center=(containerWidth-itemWidth)/2;
  const isFast=document.getElementById('fastCaseCheckbox').checked;
  const animDuration=isFast?800:4200;
  setTimeout(()=>{
    track.style.transition=`transform ${animDuration/1000}s cubic-bezier(.15,.85,.35,1)`;
    const targetX=leftPad+idx*step;
    track.style.transform=`translate3d(-${cycles*activeCase.items.length*step+targetX-center}px,0,0)`;
  },50);

  let spinTicks=0;
  const spinInterval=setInterval(()=>{
    playCaseSpinTick();spinTicks++;
    if(spinTicks>(isFast?8:32))clearInterval(spinInterval);
  },isFast?50:110);

  setTimeout(()=>{
    clearInterval(spinInterval);
    isCaseSpinning=false;
    let totalWonSum=0;
    currentWonItemsList.forEach(item=>{
      currentUser.inventory.push({...item,uid:newInventoryUid()});
      totalWonSum+=item.value;
      if(item.value>currentUser.bestDrop.value)currentUser.bestDrop={...item};
    });
    saveUserData();
    playCaseResultSound(totalWonSum/count,activeCase.price);

    document.getElementById('sellBtn').textContent=count>1
      ? `Продать всё за ${totalWonSum.toFixed(2)} ₽`
      : `Продать за ${currentWonItem.value.toFixed(2)} ₽`;
    document.getElementById('actionButtons').style.display='flex';
  },animDuration+100);
}

function sellCurrentItem(){
  if(!currentWonItemsList || currentWonItemsList.length === 0) return;
  let sum = 0;
  currentWonItemsList.forEach(wonItem => {
    sum += wonItem.value;
    const i = currentUser.inventory.findIndex(x => x.id === wonItem.id);
    if(i >= 0) currentUser.inventory.splice(i, 1);
  });
  currentUser.balance += sum;
  saveUserData();
  document.getElementById('actionButtons').style.display='none';
  document.getElementById('caseActionsPanel').style.display='flex';
  currentWonItemsList = [];
  currentWonItem = null;
}

function toggleFastSpin(){
  isFastSpinActive = !isFastSpinActive;
  const btn = document.getElementById('fastSpinBtn');
  if(isFastSpinActive) btn.classList.add('active');
  else btn.classList.remove('active');
}

function renderQuickChances(){const p=document.getElementById('quickChancePanel');p.innerHTML='';quickChances.forEach(ch=>{const b=document.createElement('button');b.className=`q-btn ${activeQuickChance===ch?'active':''}`;b.textContent=ch+'%';b.onclick=()=>applyChance(ch);p.appendChild(b)});const s=document.createElement('button');s.className='q-btn settings-btn';s.textContent='⚙';s.onclick=()=>document.getElementById('modalOverlay').style.display='flex';p.appendChild(s)}
function saveQuickSettings(){const a=[...new Set(document.getElementById('quickValuesInput').value.split(',').map(v=>parseInt(v.trim())).filter(n=>Number.isFinite(n)&&n>0&&n<=70))];if(a.length){quickChances=a;renderQuickChances()}document.getElementById('modalOverlay').style.display='none'}
function applyChance(ch){
  if(selectedItemIndex===null||!currentUser.inventory[selectedItemIndex]){alert('Выберите скин из инвентаря!');return}
  const src=Number(currentUser.inventory[selectedItemIndex].value)||0;
  const desired=src/(ch/100);
  const candidates=CATALOG_ITEMS.filter(x=>x&&x.value>desired).sort((a,b)=>a.value-b.value);
  if(!candidates.length){
    targetWeapon=null;activeQuickChance=null;renderQuickChances();renderGrid();updateUI();
    alert(`Для ${ch}% нужен скин дороже ${desired.toFixed(2)} ₽. В каталоге подходящего предмета нет.`);
    return;
  }
  targetWeapon=candidates[0];
  activeQuickChance=ch;
  renderQuickChances();renderGrid();updateUI();
}

function drawWheel(p){
  const w=canvas.width,h=canvas.height,cx=w/2,cy=h/2,r=w/2-10;
  ctx.clearRect(0,0,w,h);
  ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle='#161924';ctx.fill();
  if(p>0){
    ctx.beginPath();ctx.moveTo(cx,cy);
    ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+p/100*Math.PI*2);
    ctx.closePath();
    ctx.fillStyle='#f59e0b';
    ctx.fill();
  }
  ctx.beginPath();ctx.arc(cx,cy,r-28,0,Math.PI*2);ctx.fillStyle='#11131c';ctx.fill();
}

function updateUI(){let sp=0;let selectedLocked=false;if(selectedItemIndex!==null&&currentUser.inventory[selectedItemIndex]){const x=currentUser.inventory[selectedItemIndex];selectedLocked=isWithdrawalLocked(x);sp=selectedLocked?0:x.value;selectedSkinName.textContent=x.name;selectedSkinPrice.textContent=x.value.toFixed(2);selectedSkinImg.src=x.img;selectedSkinImg.style.display='block';selectedSkinPlaceholder.style.display='none'}else{selectedSkinName.textContent='--';selectedSkinPrice.textContent='0.00';selectedSkinImg.style.display='none';selectedSkinPlaceholder.style.display='block'}const tp=targetWeapon?.value||0;if(targetWeapon){targetSkinName.textContent=targetWeapon.name;targetSkinPrice.textContent=targetWeapon.value.toFixed(2);targetSkinImg.src=targetWeapon.img;targetSkinImg.style.display='block';targetSkinPlaceholder.style.display='none'}else{targetSkinName.textContent='--';targetSkinPrice.textContent='0.00';targetSkinImg.style.display='none';targetSkinPlaceholder.style.display='block'}const ch=sp>0&&tp>sp?Math.min(sp/tp*100,MAX_CHANCE):0;wheelPercent.textContent=ch.toFixed(2)+'%';drawWheel(ch);upgradeBtn.disabled=selectedLocked||!(sp>0&&tp>sp&&ch>0&&ch<=MAX_CHANCE)||isSpinning}

function renderGrid(){
  const g=document.getElementById('itemsGrid');
  if(!g)return;
  g.innerHTML='';
  const totalInvValue = currentUser.inventory.reduce((sum, item) => sum + (item.value || 0), 0);
  const invTotalEl = document.getElementById('invTotalValue');
  if (invTotalEl) invTotalEl.textContent = `Сумма: ${totalInvValue.toFixed(2)} ₽`;

  if(currentTab==='inventory'){
    priceFilterBox.classList.remove('active');
    currentUser.inventory.forEach((x,i)=>g.appendChild(createCard(x,selectedItemIndex===i,()=>{
      if(isSpinning)return;
      if(isWithdrawalLocked(x)){alert('Этот скин уже находится в заявке на вывод и недоступен для апгрейда.');return;}
      selectedItemIndex=selectedItemIndex===i?null:i;
      activeQuickChance=null;
      targetWeapon=null;
      renderQuickChances();
      renderGrid();
      updateUI();
    })));
  }else{
    priceFilterBox.classList.add('active');
    const min=Number(minPriceInput.value)||0,max=Number(maxPriceInput.value)||Infinity;
    CATALOG_ITEMS.filter(x=>x.category===currentTab&&x.value>=min&&x.value<=max).slice(0,500).forEach(x=>g.appendChild(createCard(x,targetWeapon?.id===x.id,()=>{
      if(isSpinning)return;
      targetWeapon=targetWeapon?.id===x.id?null:x;
      activeQuickChance=null;
      renderQuickChances();
      renderGrid();
      updateUI();
    })))
  }
}

function createCard(x,sel,click){
  const c=document.createElement('div');
  c.className=`item-card ${sel?'selected':''} ${isWithdrawalLocked(x)?'withdraw-locked':''}`;
  c.innerHTML=`<img src="${escapeAttr(x.img)}" alt=""><div class="iname">${escapeHtml(x.name)}</div><div class="iprice">${x.value.toFixed(2)} ₽</div>${isWithdrawalLocked(x)?'<div style="font-size:9px;color:#f59e0b;margin-top:4px;font-weight:800">ВЫВОД</div>':''}`;
  c.onclick=click;
  return c;
}
minPriceInput.addEventListener('input',renderGrid);maxPriceInput.addEventListener('input',renderGrid);

document.getElementById('upgradeBtn').onclick=()=>{
  if(!currentUser || !currentUser.steamid){ alert('Для апгрейда необходимо войти через Steam!'); return; }
  if(isSpinning||selectedItemIndex===null||!targetWeapon)return;
  const source=currentUser.inventory[selectedItemIndex];
  if(!source)return;
  if(isWithdrawalLocked(source)){ alert('Этот скин уже находится в заявке на вывод и недоступен для апгрейда.'); return; }
  const baseChance=activeQuickChance??Math.min(source.value/targetWeapon.value*100,MAX_CHANCE);
  // Бонус больше не может сделать выбранные 70% недоступными.
  let modifier = 0.93;
  if (currentUser.stats.upgradesTotal % 5 === 0) modifier = 1.02;
  const chance = Math.min(MAX_CHANCE, baseChance * modifier);

  if(chance<=0||chance>MAX_CHANCE)return;
  isSpinning=true;upgradeBtn.disabled=true;wheelOverlay.style.display='block';
  
  const success=Math.random()*100<chance;
  currentUser.stats.upgradesTotal++;
  saveUserData();

  const handleUpgradeResult = () => {
    resultOverlay.style.display='flex';
    resultText.textContent=success?'Успех!':'Неудача';
    resultText.style.color=success?'#4ade80':'#f87171';
    
    if(success) playSuccessSound(); else playUpgradeFailSound();

    const i=currentUser.inventory.findIndex(x=>x.id===source.id);
    if(i>=0)currentUser.inventory.splice(i,1);
    if(success){
      const won={...targetWeapon};
      currentUser.inventory.push({...won,uid:newInventoryUid()});
      if(won.value>currentUser.bestDrop.value)currentUser.bestDrop={...won};
    }
    saveUserData();
    resetCaseResultState();
    setTimeout(()=>{
      resultOverlay.style.display='none';wheelOverlay.style.display='none';isSpinning=false;selectedItemIndex=null;targetWeapon=null;activeQuickChance=null;renderQuickChances();renderGrid();updateUI();canvas.style.transition='none';currentRotation=((currentRotation%360)+360)%360;canvas.style.transform=`rotate(${currentRotation}deg)`
    }, isFastSpinActive ? 600 : 2000);
  };

  if(isFastSpinActive) {
    handleUpgradeResult();
    return;
  }

  const sector=chance*3.6,angle=success?(-90+sector*(.12+Math.random()*.76)):(-90+sector+(360-sector)*(.12+Math.random()*.76));const norm=((currentRotation%360)+360)%360;let delta=(-90-angle-norm)%360;if(delta<0)delta+=360;currentRotation+=2160+delta;
  
  canvas.style.transition='transform 3.6s cubic-bezier(.15,.85,.35,1)';
  canvas.style.transform=`rotate(${currentRotation}deg)`;

  let tickCount = 0;
  const tickInterval = setInterval(() => {
    playUpgradeSpinSound();
    tickCount++;
    if(tickCount > 25) clearInterval(tickInterval);
  }, 120);

  setTimeout(()=>{
    clearInterval(tickInterval);
    handleUpgradeResult();
  },3700)
};
window.onload=initializeApp;
