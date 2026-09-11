const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;

const KEY = (process.env.CS2SH_API_KEY || process.env.CS2_API_KEY || process.env.CS2SH_KEY || '').trim();
const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();

if (!KEY) { console.error('ERROR: Set CS2SH_API_KEY'); process.exit(1); }

const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/,'');
const html = fs.readFileSync(path.join(__dirname, 'Zenodrop_CS2SH_400.html'));

const sessions = new Map();
const SESSION_SECRET = (process.env.SESSION_SECRET || process.env.STEAM_SESSION_SECRET || KEY).trim();

function makeSessionCookie(steamid){
  const id=String(steamid||'');
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(id).digest('hex');
  return `steam_${id}_${sig}`;
}
function steamFromSessionCookie(value){
  const m=String(value||'').match(/^steam_(\d{17})_([a-f0-9]{64})$/);
  if(!m)return null;
  const expected=crypto.createHmac('sha256',SESSION_SECRET).update(m[1]).digest('hex');
  try{if(!crypto.timingSafeEqual(Buffer.from(m[2]),Buffer.from(expected)))return null;}catch(e){return null;}
  return m[1];
}

// ============ REDIS ============
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/,'');
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = (process.env.REDIS_STORE_KEY || 'zenodrop:store').trim();

const DATA_DIR = (process.env.DATA_DIR || __dirname).trim();
const DATA_FILE = path.join(DATA_DIR, 'zenodrop_data.json');
const CATALOG_FILE = path.join(DATA_DIR, 'cs2_catalog_cache.json');

// ============ ТОЛЬКО АДМИН-БОТ ============
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_BOT_URL = (process.env.TELEGRAM_BOT_URL || '').trim();
const TG_WEBHOOK_URL = (process.env.TELEGRAM_WEBHOOK_URL || (PUBLIC_URL ? PUBLIC_URL + '/telegram/admin-webhook' : '')).trim();
const SUPPORT_CONTACT = '@Zenodropsupport';
const TG_ADMIN_IDS = new Set(String(process.env.TG_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));

async function redisCmd(args){
  if(!USE_REDIS) return null;
  try{
    const r = await fetch(REDIS_URL, {method:'POST',headers:{'Authorization':'Bearer '+REDIS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(args)});
    if(!r.ok){ console.error('Redis HTTP',r.status); return null; }
    const j = await r.json();
    return j?.result ?? null;
  }catch(e){ console.error('Redis error:',e.message); return null; }
}
async function redisLoad(key){
  const v = await redisCmd(['GET',key]);
  if(v===null||v===undefined) return null;
  try{ return typeof v==='string'?JSON.parse(v):v; }catch(e){ return null; }
}
async function redisSave(key,obj){ try{ await redisCmd(['SET',key,JSON.stringify(obj)]); }catch(e){ console.error('redisSave:',e.message); } }

// ============ КЕЙСЫ ============
const CASE_CONFIG = {
  micro: {
    price: 13, rtp: 0.95, alpha: 0.30, pity: 12,
    accept: [8, 60],
    bands: [
      { name:'core', min:8, max:23, weight:100, label:'часто', peak:15, spread:4 },
      { name:'rare', min:23, max:60, weight:1, label:'очень редко', peak:35, spread:15 }
    ]
  },
  basic: {
    price: 100, rtp: 0.85, alpha: 0.45, pity: 10,
    accept: [70, 250],
    bands: [
      { name:'loss', min:70, max:90, weight:6, label:'слив' },
      { name:'core', min:90, max:125, weight:100, label:'часто', peak:108, spread:12 },
      { name:'rare', min:125, max:250, weight:1.5, label:'редко', peak:180, spread:50 }
    ]
  },
  small: {
    price: 250, rtp: 0.86, alpha: 0.55, pity: 10,
    accept: [110, 350],
    bands: [
      { name:'loss', min:110, max:160, weight:6, label:'слив' },
      { name:'mid',  min:160, max:190, weight:12, label:'около' },
      { name:'core', min:190, max:280, weight:100, label:'в среднем', peak:235, spread:30 },
      { name:'rare', min:280, max:350, weight:2, label:'редко', peak:310, spread:30 }
    ]
  },
  premium: {
    price: 500, rtp: 0.87, alpha: 0.60, pity: 10,
    accept: [340, 670],
    bands: [
      { name:'loss', min:340, max:420, weight:8, label:'слив' },
      { name:'core', min:420, max:560, weight:100, label:'часто', peak:490, spread:45 },
      { name:'rare', min:560, max:670, weight:2, label:'редко', peak:610, spread:40 }
    ]
  },
  expensive: {
    price: 1000, rtp: 0.88, alpha: 0.65, pity: 9,
    accept: [560, 1600],
    bands: [
      { name:'loss', min:560, max:750, weight:8, label:'слив' },
      { name:'core', min:750, max:1200, weight:100, label:'дроп', peak:975, spread:150 },
      { name:'rare', min:1200, max:1600, weight:2, label:'везучий дроп', peak:1400, spread:130 }
    ]
  },
  elite: {
    price: 2500, rtp: 0.88, alpha: 0.75, pity: 9,
    accept: [1800, 3200],
    bands: [
      { name:'loss', min:1800, max:2100, weight:8, label:'слив' },
      { name:'core', min:2100, max:2800, weight:100, label:'ядро', peak:2450, spread:220 },
      { name:'rare', min:2800, max:3200, weight:2, label:'редко', peak:3000, spread:160 }
    ]
  },
  legendary: {
    price: 5000, rtp: 0.89, alpha: 0.80, pity: 8,
    accept: [2800, 6300],
    bands: [
      { name:'loss', min:2800, max:3600, weight:8, label:'слив' },
      { name:'core', min:3600, max:5600, weight:100, label:'ядро', peak:4600, spread:600 },
      { name:'rare', min:5600, max:6300, weight:2, label:'редко', peak:5950, spread:250 }
    ]
  },
  titan: {
    price: 10000, rtp: 0.89, alpha: 0.90, pity: 8,
    accept: [5000, 16000],
    bands: [
      { name:'loss', min:5000, max:6000, weight:8, label:'слив' },
      { name:'core', min:6000, max:11000, weight:100, label:'ядро', peak:8500, spread:1600 },
      { name:'rare', min:11000, max:16000, weight:2, label:'редко', peak:13500, spread:1700 }
    ]
  }
};

const CASES = {};
const CASE_BANDS = {};
for (const k of Object.keys(CASE_CONFIG)) {
  const c = CASE_CONFIG[k];
  CASES[k] = { price: c.price, rtp: c.rtp, alpha: c.alpha, pity: c.pity, acceptMin: c.accept[0], acceptMax: c.accept[1] };
  CASE_BANDS[k] = c.bands;
}

function itemPrice(s){ const v = Number(s?.price ?? s?.value ?? s?.usd ?? 0); return Number.isFinite(v) && v > 0 ? v : 0; }
function weaponKey(name){
  const n = String(name||'').toLowerCase();
  const cut = n.split('|')[0].trim();
  return cut || n;
}
function bandOf(price, bands){ for(const b of bands){ if(price>=b.min && price<b.max) return b; } return null; }

function insideBandWeight(price, alpha, band){
  const p = Math.max(price, 1);
  let w = Math.pow(1 / p, alpha);
  if (band && Number.isFinite(Number(band.peak))) {
    const peak = Number(band.peak);
    const spread = Math.max(Number(band.spread) || peak * 0.5, 1);
    const d = (p - peak) / spread;
    w *= Math.exp(-d * d);
  }
  return w;
}

// ============ РАЗНООБРАЗИЕ ============
function applyDiversity(list, recentDrops){
  if (!Array.isArray(recentDrops) || !recentDrops.length) return list;
  const now = Date.now();
  const recentNames = new Map();
  const recentWeapons = new Map();
  for (const d of recentDrops) {
    if (!d) continue;
    const age = now - Number(d.ts || 0);
    const decay = age < 5*60*1000 ? 1.0 : age < 30*60*1000 ? 0.6 : 0.25;
    if (d.name) recentNames.set(d.name, Math.max(recentNames.get(d.name)||0, decay));
    if (d.weapon) recentWeapons.set(d.weapon, Math.max(recentWeapons.get(d.weapon)||0, decay));
  }
  return list.map(x => {
    let factor = 1;
    const namePen = recentNames.get(x.name) || 0;
    if (namePen > 0) factor *= Math.max(0.03, 1 - namePen * 0.97);
    const wk = weaponKey(x.name);
    const weaponPen = recentWeapons.get(wk) || 0;
    if (weaponPen > 0) factor *= Math.max(0.2, 1 - weaponPen * 0.8);
    return { ...x, _w: x._w * factor };
  });
}

function computeWeights(items, caseKey, alpha, recentDrops){
  const cfg = CASE_CONFIG[caseKey];
  if (!cfg) return [];
  const [amin, amax] = cfg.accept;
  const bands = cfg.bands;
  const inWindow = items.map(x => ({ ...x, price: itemPrice(x) })).filter(x => x.price >= amin && x.price < amax);
  const pool = inWindow.length ? inWindow : items.map(x => ({ ...x, price: itemPrice(x) }));
  let arr = pool.map(x => {
    const b = bandOf(x.price, bands);
    const w = b
      ? Number(b.weight||0) * insideBandWeight(x.price, alpha, b)
      : 0.01 * insideBandWeight(x.price, alpha, null);
    return { ...x, _band: b ? b.name : 'fallback', _label: b ? (b.label||'') : '', _w: w };
  });
  arr = applyDiversity(arr, recentDrops);
  const total = arr.reduce((s,x)=>s+x._w,0) || 1;
  return arr.map(x => ({ ...x, _w: x._w / total }));
}

function fitRtpAbsolute(list, casePrice, targetRtp, iterations = 10){
  if (!list.length || !casePrice) return list;
  const target = casePrice * targetRtp;
  let l = list.slice();
  for (let it = 0; it < iterations; it++){
    const total = l.reduce((s,x)=>s+x._w,0) || 1;
    const ev = l.reduce((s,x)=>s+(x._w/total)*x.price, 0);
    if (ev <= 0) break;
    const k = target / ev;
    if (Math.abs(1 - k) < 0.05) break;
    l = l.map(x => { const exp = x.price >= casePrice ? 1.4 : x.price >= casePrice*0.6 ? 0.9 : 0.4; return { ...x, _w: x._w * Math.pow(k, exp) }; });
  }
  return l;
}

function applyPity(list, caseKey, n){
  if (!n || n <= 0) return list;
  const boost = Math.min(1 + n*0.15, 2.5);
  return list.map(x => {
    if (x._band === 'rare') return { ...x, _w: x._w * boost };
    if (x._band === 'core') return { ...x, _w: x._w * (1 + (boost-1)*0.25) };
    return x;
  });
}

function normalize(list){ const t=list.reduce((s,x)=>s+x._w,0)||1; return list.map(x=>({...x,_w:x._w/t})); }
function pickByWeight(list){
  const t=list.reduce((s,x)=>s+x._w,0)||1;
  let r=Math.random()*t, cur=0;
  for(const x of list){ cur+=x._w; if(r<=cur) return x; }
  return list[list.length-1];
}

function openCase(caseKey, items, pityCount, recentDrops){
  const cfg = CASES[String(caseKey)];
  if (!cfg || !Array.isArray(items) || !items.length) return null;
  let weighted = computeWeights(items, caseKey, cfg.alpha, recentDrops);
  if (!weighted.length) return null;
  weighted = fitRtpAbsolute(weighted, cfg.price, cfg.rtp);
  weighted = applyPity(weighted, caseKey, pityCount);
  weighted = normalize(weighted);
  const picked = pickByWeight(weighted);
  if (!picked) return null;
  return { skin: { id:picked.id, name:picked.name, img:picked.img, value:picked.price, tier:picked._band }, price: cfg.price, tier: picked._band, label: picked._label };
}

// ============ АПГРЕЙД ============
const LUCK_MAP = new Map();
function getPlayerLuck(steamid){
  const id = String(steamid || '');
  if (!id) return 1.0;
  if (LUCK_MAP.has(id)) return LUCK_MAP.get(id);
  const hash = crypto.createHash('sha256').update('zenodrop_luck:' + id).digest();
  const r = hash[0] / 255;
  let luck;
  if (r < 0.30) luck = 0.85;
  else if (r < 0.50) luck = 1.15;
  else luck = 1.0;
  LUCK_MAP.set(id, luck);
  return luck;
}
function upgrade(chance, steamid, targetPrice){
  chance = Number(chance);
  if (!Number.isFinite(chance)) return false;
  chance = Math.max(0, Math.min(100, chance));
  const price = Number(targetPrice || 0);
  let real = chance;
  if (price >= 20000) real *= 0.35;
  else if (price >= 15000) real *= 0.50;
  else if (price >= 10000) real *= 0.60;
  else if (price >= 5000) real *= 0.75;
  real *= getPlayerLuck(steamid);
  real = Math.max(0.5, Math.min(95, real));
  return Math.random() * 100 < real;
}

// ============ STORE ============
let data = { users:{}, withdrawals:[], deposits:[], promos:{}, admins:{}, links:{} };

function loadStoreFromDisk(){
  try {
    const x = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    return { users:x.users||{}, withdrawals:x.withdrawals||[], deposits:x.deposits||[], promos:x.promos||{}, admins:x.admins||{}, links:x.links||{} };
  } catch(e) { return null; }
}
function saveStoreToDisk(){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e){ console.error('disk save:',e.message); } }

let __saveTimer=null, __saveInFlight=false;
function saveStore(){
  saveStoreToDisk();
  if(!USE_REDIS) return;
  if(__saveTimer) clearTimeout(__saveTimer);
  __saveTimer = setTimeout(async ()=>{
    if(__saveInFlight) return;
    __saveInFlight = true;
    try{ await redisSave(REDIS_KEY, data); } finally{ __saveInFlight=false; }
  }, 100);
}
async function saveStoreNow(){
  saveStoreToDisk();
  if(!USE_REDIS) return;
  if(__saveTimer){ clearTimeout(__saveTimer); __saveTimer=null; }
  try{ await redisSave(REDIS_KEY, data); }catch(e){ console.error('redis save now:',e.message); }
}
async function refreshFromRedis(){
  if(!USE_REDIS) return false;
  const remote = await redisLoad(REDIS_KEY);
  if(!remote || typeof remote !== 'object') return false;
  data = {
    users: remote.users || data.users,
    withdrawals: remote.withdrawals || data.withdrawals,
    deposits: remote.deposits || data.deposits,
    promos: remote.promos || data.promos,
    admins: remote.admins || data.admins,
    links: remote.links || data.links
  };
  return true;
}
async function initStore(){
  if(USE_REDIS){
    const remote = await redisLoad(REDIS_KEY);
    if(remote && typeof remote === 'object'){
      data = { users:remote.users||{}, withdrawals:remote.withdrawals||[], deposits:remote.deposits||[], promos:remote.promos||{}, admins:remote.admins||{}, links:remote.links||{} };
      console.log('Store loaded from Redis:', Object.keys(data.users).length,'users');
      return;
    }
    console.log('Redis empty → disk');
  }
  const local = loadStoreFromDisk();
  if(local){
    data = local;
    console.log('Store loaded from disk:', Object.keys(data.users).length,'users');
    if(USE_REDIS) await redisSave(REDIS_KEY, data);
    return;
  }
  console.log('Empty store');
}

function ensureUser(steamid){
  const id=String(steamid||''); if(!id)return null;
  if(!data.users[id]) data.users[id]={
    steamid:id, balance:0,
    stats:{totalDeposited:0, upgradesTotal:0, casesOpened:0},
    withdrawDisabled:false, tgId:null, createdAt:Date.now(),
    inventory:[], bestDrop:{name:'--',value:0,img:''},
    pity:{count:0, byCase:{}},
    recentDrops:[]
  };
  if(!data.users[id].stats) data.users[id].stats={totalDeposited:0, upgradesTotal:0, casesOpened:0};
  ['totalDeposited','upgradesTotal','casesOpened'].forEach(k=>{ if(typeof data.users[id].stats[k]!=='number') data.users[id].stats[k]=0; });
  if(!Array.isArray(data.users[id].inventory)) data.users[id].inventory=[];
  if(!data.users[id].bestDrop) data.users[id].bestDrop={name:'--',value:0,img:''};
  if(!data.users[id].pity) data.users[id].pity={count:0, byCase:{}};
  if(!data.users[id].pity.byCase) data.users[id].pity.byCase={};
  if(!Array.isArray(data.users[id].recentDrops)) data.users[id].recentDrops=[];
  return data.users[id];
}
function makeZenodropId(userOrSteam){
  const steam=typeof userOrSteam==='object'?String(userOrSteam?.steamid||''):String(userOrSteam||'');
  if(/^\d{17}$/.test(steam)){
    const hex=crypto.createHash('sha256').update('zenodrop:'+steam).digest('hex').slice(0,12);
    const num=(parseInt(hex,16)%90000000)+10000000;
    return 'ZN-'+String(num);
  }
  let id='';
  do{ id='ZN-'+String(crypto.randomInt(10000000,100000000)); } while(Object.values(data.users).some(u=>u.zenoId===id));
  return id;
}
function ensureZenodropId(user){
  if(!user.zenoId || !/^ZN-\d{8,10}$/.test(String(user.zenoId))) user.zenoId=makeZenodropId(user);
  return user.zenoId;
}
function findUserByZenodropId(zenoId){
  const id=String(zenoId||'').trim().toUpperCase().replace(/\s+/g,'');
  if(!id) return null;
  let found=Object.values(data.users).find(u=>String(u.zenoId||'').toUpperCase()===id);
  if(found) return found;
  const digits=id.replace(/\D/g,'');
  if(digits.length>=6){
    found=Object.values(data.users).find(u=>String(u.zenoId||'').replace(/\D/g,'')===digits);
    if(found) return found;
  }
  return null;
}
function pendingWithdrawalsForUser(steamid){
  return data.withdrawals.filter(w=>w.steamid===steamid && (w.status==='pending'||w.status==='approved'))
    .map(w=>({id:w.id,itemUid:w.item?.uid||null,itemName:w.item?.name||'',itemValue:Number(w.item?.value)||0,status:w.status,index:w.index,createdAt:w.createdAt||0}));
}
function isTgAdmin(id){ return TG_ADMIN_IDS.has(String(id)) || !!data.admins[String(id)]; }
function isWebAdmin(steamid){ return !!data.admins['steam:'+String(steamid)]; }

async function tg(method, body={}){
  if(!TG_TOKEN){ console.error('TG: token not set'); return null; }
  try{
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const json = await r.json();
    if(!json?.ok) console.error('TG API', method, json?.description||'err');
    return json;
  }catch(e){ console.error('TG', method, e.message); return null; }
}
async function notifyAdmins(text, keyboard){
  for(const id of TG_ADMIN_IDS){ await tg('sendMessage',{chat_id:id,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined}); }
  for(const [id,v] of Object.entries(data.admins)){ if(v && !TG_ADMIN_IDS.has(id)){ await tg('sendMessage',{chat_id:id,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined}); } }
}

function promoList(){ return Object.values(data.promos).filter(x=>x.active!==false && (!x.expiresAt||x.expiresAt>Date.now()) && (!x.maxUses||Number(x.uses||0)<Number(x.maxUses))).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)); }
function makePromo(code,percent,maxBonus=0,extra={}){
  const c=String(code||'').toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32);
  const pct=Math.max(1,Math.min(100,Number(percent)||0));
  if(!c) return null;
  for(const p of Object.values(data.promos)){ p.active=false; }
  data.promos[c]={code:c,percent:pct,maxBonus:Math.max(0,Number(maxBonus)||0),active:true,createdAt:Date.now(),uses:0,...extra};
  saveStore();
  return data.promos[c];
}
function createAutoPromo(){ const percent=[10,12,15,18,20,25][crypto.randomInt(0,6)]; return makePromo('ZEN'+percent,percent,0,{auto:true,expiresAt:Date.now()+15*60*1000,maxUses:0}); }
function ensureOneActivePromo(){
  const active=promoList();
  if(active.length){ const keep=active[0]; for(const p of Object.values(data.promos)){ if(p.code!==keep.code) p.active=false; } saveStore(); return keep; }
  return createAutoPromo();
}

// ============ АДМИН-БОТ ============
async function sendAdminMenu(chatId){
  const pendingWd = data.withdrawals.filter(x=>x.status==='pending').length;
  const pendingDep = data.deposits.filter(x=>x.status==='pending').length;
  return tg('sendMessage',{chat_id:chatId,text:`<b>Zenodrop — Админ</b>\n\nВывода: <b>${pendingWd}</b>\nПополнения: <b>${pendingDep}</b>`,parse_mode:'HTML',reply_markup:{inline_keyboard:[
    [{text:'💳 Пополнения',callback_data:'adm:deposits'},{text:'🎁 Выводы',callback_data:'adm:withdrawals'}],
    [{text:'📊 Статистика',callback_data:'adm:stats'},{text:'🎟 Промокоды',callback_data:'adm:promo'}],
    [{text:'🔄 Обновить',callback_data:'adm:menu'}]
  ]}});
}

async function processTelegramUpdate(u){
  if(u.callback_query){
    const q=u.callback_query, id=String(q.from.id), d=String(q.data||'');
    await refreshFromRedis();
    if(!isTgAdmin(id)){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Нет доступа',show_alert:true}); return; }

    if(d.startsWith('wd:')){
      const [,wid,action]=d.split(':');
      const w=data.withdrawals.find(x=>x.id===wid);
      if(!w){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка не найдена',show_alert:true}); return; }

      if(action==='send'){
        const user=ensureUser(w.steamid);
        if(user && Array.isArray(user.inventory) && w.item?.uid){
          const before=user.inventory.length;
          user.inventory = user.inventory.filter(x => x.uid !== w.item.uid);
          console.log(`[wd:${wid}] removed ${before-user.inventory.length} item(s) from ${w.steamid}`);
        }
        w.status='approved'; w.updatedAt=Date.now();
        await saveStoreNow();

        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Скин выдан'});
        await tg('sendMessage',{
          chat_id:q.message.chat.id,
          text:`🎁 <b>${wid}</b> — скин выдан.\nИнвентарь игрока очищен.\n\n<b>Подтвердите факт отправки в Steam:</b>\n<i>${w.item?.name}</i>`,
          parse_mode:'HTML',
          reply_markup:{inline_keyboard:[[{text:'✅ Подтвердить отправку',callback_data:`wd:${wid}:confirm`}]]}
        });
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`🎁 Ваш вывод <b>${wid}</b> обрабатывается.\nСкин «${w.item?.name}» будет отправлен в Steam.`,parse_mode:'HTML'});
        return;
      }

      if(action==='confirm'){
        w.status='delivered'; w.deliveredAt=Date.now();
        await saveStoreNow();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Отправка подтверждена'});
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`✅ <b>${wid}</b> отмечен как доставленный.`,parse_mode:'HTML'});
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`✅ Ваш скин «${w.item?.name}» отправлен в Steam.`,parse_mode:'HTML'});
        return;
      }

      if(action==='reject'){
        w.status='rejected'; w.updatedAt=Date.now();
        await saveStoreNow();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Отклонено'});
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`❌ <b>${wid}</b> отклонён. Скин возвращён игроку.`,parse_mode:'HTML'});
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`❌ Вывод <b>${wid}</b> отклонён. Скин остался в вашем инвентаре.`,parse_mode:'HTML'});
        return;
      }
      return;
    }

    if(d.startsWith('dep:')){
      const [,did,action]=d.split(':');
      const dep=data.deposits.find(x=>x.id===did);
      if(!dep){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка не найдена',show_alert:true}); return; }
      if(dep.status!=='pending'){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Уже обработана'}); return; }
      if(action==='approve'){
        const u=ensureUser(dep.steamid);
        const total=Number(dep.amount||0)+Number(dep.bonus||0);
        u.balance+=total;
        u.stats.totalDeposited=(u.stats.totalDeposited||0)+total;
        if(dep.promo&&data.promos[dep.promo]) data.promos[dep.promo].uses=(data.promos[dep.promo].uses||0)+1;
        dep.status='paid'; dep.updatedAt=Date.now(); await saveStoreNow();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'✅ Зачислено'});
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`✅ <b>${did}</b>: +${total.toFixed(2)} ₽`,parse_mode:'HTML'});
        if(dep.tgId) await tg('sendMessage',{chat_id:dep.tgId,text:`✅ +${total.toFixed(2)} ₽`,parse_mode:'HTML'});
      } else if(action==='reject'){
        dep.status='rejected'; dep.updatedAt=Date.now(); await saveStoreNow();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Отклонено'});
        if(dep.tgId) await tg('sendMessage',{chat_id:dep.tgId,text:`❌ Пополнение <b>${did}</b> отклонено.`,parse_mode:'HTML'});
      }
      return;
    }

    if(d==='adm:menu'){ await tg('answerCallbackQuery',{callback_query_id:q.id}); return sendAdminMenu(q.message.chat.id); }

    if(d==='adm:withdrawals'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const list=data.withdrawals.filter(x=>x.status==='pending').slice(-10).reverse();
      if(!list.length) return tg('sendMessage',{chat_id:q.message.chat.id,text:'Заявок нет.'});
      for(const w of list){
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`🟠 <b>${w.id}</b>\n<code>${w.steamid}</code>\n${Number(w.value).toFixed(2)} ₽\n${w.item.name}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🎁 Выдать',callback_data:`wd:${w.id}:send`},{text:'❌ Отклонить',callback_data:`wd:${w.id}:reject`}]]}});
      }
      return;
    }

    if(d==='adm:deposits'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const list=data.deposits.filter(x=>x.status==='pending').slice(-10).reverse();
      if(!list.length) return tg('sendMessage',{chat_id:q.message.chat.id,text:'Заявок нет.'});
      for(const dep of list){
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`💳 <b>${dep.id}</b>\n<code>${dep.steamid}</code>\n${Number(dep.amount).toFixed(2)} ₽\nПромо: ${dep.promo||'—'}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'✅ Зачислить',callback_data:`dep:${dep.id}:approve`},{text:'❌ Отклонить',callback_data:`dep:${dep.id}:reject`}]]}});
      }
      return;
    }

    if(d==='adm:stats'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const users=Object.values(data.users);
      const tb=users.reduce((s,u)=>s+(Number(u.balance)||0),0);
      const td=users.reduce((s,u)=>s+(Number(u.stats?.totalDeposited)||0),0);
      const tc=users.reduce((s,u)=>s+(Number(u.stats?.casesOpened)||0),0);
      const tu=users.reduce((s,u)=>s+(Number(u.stats?.upgradesTotal)||0),0);
      return tg('sendMessage',{chat_id:q.message.chat.id,text:`📊 Юзеров: <b>${users.length}</b>\nБаланс: <b>${tb.toFixed(2)} ₽</b>\nДепозит: <b>${td.toFixed(2)} ₽</b>\nКейсов: <b>${tc}</b>\nАпгрейдов: <b>${tu}</b>`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'◀ Меню',callback_data:'adm:menu'}]]}});
    }

    if(d==='adm:promo'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const active=promoList().slice(0,5);
      const list=active.length?active.map(p=>`<code>${p.code}</code> +${p.percent}%`).join('\n'):'—';
      return tg('sendMessage',{chat_id:q.message.chat.id,text:`🎟 <b>Промо</b>\n\n${list}\n\n<code>/promo CODE PERCENT</code>`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'◀ Меню',callback_data:'adm:menu'}]]}});
    }

    return;
  }

  const m=u.message; if(!m||!m.chat) return;
  const chatId=String(m.chat.id);
  const rawText=String(m.text||'').trim();
  const text=rawText.replace(/^\/(\w+)(?:@[^\s]+)?/,'/$1');
  const admin=isTgAdmin(chatId);

  if(/^\/start(?:\s|$)/i.test(text)){
    if(admin) return sendAdminMenu(chatId);
    return tg('sendMessage',{chat_id:chatId,text:`<b>Zenodrop</b>\n\nID: <code>${chatId}</code>\n\n/link STEAMID\n/status\n/help`,parse_mode:'HTML'});
  }
  if(text==='/help') return tg('sendMessage',{chat_id:chatId,text:'<b>Zenodrop</b>\n\n/link STEAMID\n/status\n/help'+(admin?'\n\n<b>Админ:</b>\n/panel\n/deposits\n/withdrawals\n/stats\n/give STEAMID SUM\n/withdrawlock STEAMID on|off\n/adminsteam STEAMID\n/promo CODE PERCENT':''),parse_mode:'HTML'});
  if(text==='/status'){
    const steam=data.links[chatId]; const u2=steam?ensureUser(steam):null;
    return tg('sendMessage',{chat_id:chatId,text:steam?`Steam: <code>${steam}</code>\nБаланс: <b>${Number(u2?.balance||0).toFixed(2)} ₽</b>`:'Не привязан.',parse_mode:'HTML'});
  }
  if(text.startsWith('/link ')){
    const steam=text.split(/\s+/)[1];
    if(!/^\d{17}$/.test(steam)) return tg('sendMessage',{chat_id:chatId,text:'Формат: /link 7656119XXXXXXXXXX'});
    data.links[chatId]=steam;
    const u2=ensureUser(steam); u2.tgId=chatId; await saveStoreNow();
    return tg('sendMessage',{chat_id:chatId,text:`✅ <code>${steam}</code>`,parse_mode:'HTML'});
  }

  if(!admin) return;
  if(text==='/panel') return sendAdminMenu(chatId);

  if(text==='/withdrawals'){
    await refreshFromRedis();
    const list=data.withdrawals.filter(x=>x.status==='pending').slice(-10).reverse();
    if(!list.length) return tg('sendMessage',{chat_id:chatId,text:'Нет.'});
    for(const w of list){
      await tg('sendMessage',{chat_id:chatId,text:`🟠 <b>${w.id}</b>\n<code>${w.steamid}</code>\n${Number(w.value).toFixed(2)} ₽\n${w.item.name}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🎁',callback_data:`wd:${w.id}:send`},{text:'❌',callback_data:`wd:${w.id}:reject`}]]}});
    }
    return;
  }
  if(text==='/deposits'){
    await refreshFromRedis();
    const list=data.deposits.filter(x=>x.status==='pending').slice(-10).reverse();
    if(!list.length) return tg('sendMessage',{chat_id:chatId,text:'Нет.'});
    for(const dep of list){
      await tg('sendMessage',{chat_id:chatId,text:`💳 <b>${dep.id}</b>\n<code>${dep.steamid}</code>\n${Number(dep.amount).toFixed(2)} ₽\nПромо: ${dep.promo||'—'}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'✅',callback_data:`dep:${dep.id}:approve`},{text:'❌',callback_data:`dep:${dep.id}:reject`}]]}});
    }
    return;
  }
  if(text==='/stats'){
    await refreshFromRedis();
    const users=Object.values(data.users);
    const tb=users.reduce((s,u)=>s+(Number(u.balance)||0),0);
    const td=users.reduce((s,u)=>s+(Number(u.stats?.totalDeposited)||0),0);
    return tg('sendMessage',{chat_id:chatId,text:`📊 Юзеров: <b>${users.length}</b>\nБаланс: <b>${tb.toFixed(2)} ₽</b>\nДепозит: <b>${td.toFixed(2)} ₽</b>`,parse_mode:'HTML'});
  }

  let a=text.match(/^\/give\s+(\d{17})\s+([\d.]+)/i);
  if(a){ const u2=ensureUser(a[1]); u2.balance+=Number(a[2]); await saveStoreNow(); return tg('sendMessage',{chat_id:chatId,text:`✅ +${Number(a[2]).toFixed(2)} ₽`,parse_mode:'HTML'}); }
  a=text.match(/^\/withdrawlock\s+(\d{17})\s+(on|off)/i);
  if(a){ const u2=ensureUser(a[1]); u2.withdrawDisabled=a[2].toLowerCase()==='on'; await saveStoreNow(); return tg('sendMessage',{chat_id:chatId,text:`✅ Вывод: ${u2.withdrawDisabled?'OFF':'ON'}`}); }
  a=text.match(/^\/adminsteam\s+(\d{17})/i);
  if(a){ data.admins['steam:'+a[1]]=true; await saveStoreNow(); return tg('sendMessage',{chat_id:chatId,text:`✅ web-admin: ${a[1]}`}); }
  a=text.match(/^\/admin\s+(\d+)/i);
  if(a){ data.admins[a[1]]=true; await saveStoreNow(); return tg('sendMessage',{chat_id:chatId,text:`✅ admin: ${a[1]}`}); }
  a=text.match(/^\/promo\s+([A-Za-z0-9_-]+)\s+(\d+(?:\.\d+)?)\s*(?:([\d.]+))?/i);
  if(a){ const p=makePromo(a[1],a[2],a[3]||0); await saveStoreNow(); return tg('sendMessage',{chat_id:chatId,text:`✅ <code>${p.code}</code> +${p.percent}%`,parse_mode:'HTML'}); }
  return tg('sendMessage',{chat_id:chatId,text:'/panel'});
}

async function telegramStart(){
  if(!TG_TOKEN){ console.error('Admin TG disabled: no token'); return; }
  try{
    const me = await tg('getMe',{});
    if(!me?.ok){ console.error('TG bad token'); return; }
    await tg('setMyCommands',{commands:[
      {command:'start',description:'Меню'},
      {command:'panel',description:'Админ-панель'},
      {command:'deposits',description:'Пополнения'},
      {command:'withdrawals',description:'Выводы'},
      {command:'stats',description:'Статистика'},
      {command:'status',description:'Мой баланс'},
      {command:'link',description:'Привязать Steam'},
      {command:'help',description:'Помощь'}
    ]});
    if(TG_WEBHOOK_URL){
      const secret = crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0,32);
      const r = await tg('setWebhook',{url:TG_WEBHOOK_URL,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
      if(r?.ok) console.log('TG webhook:',TG_WEBHOOK_URL); else console.error('TG setWebhook:',r?.description);
    } else {
      await tg('deleteWebhook',{drop_pending_updates:false});
      startTelegramPollingFallback();
    }
  }catch(e){ console.error('TG init:',e.message); }
}

let tgPollingFallback=false;
async function startTelegramPollingFallback(){
  if(tgPollingFallback)return; tgPollingFallback=true;
  let offset=0;
  while(tgPollingFallback){
    try{
      const r = await tg('getUpdates',{offset,timeout:30,allowed_updates:['message','callback_query']});
      if(!r?.ok){ await new Promise(res=>setTimeout(res,3000)); continue; }
      for(const u of (r.result||[])){ offset=Math.max(offset,u.update_id+1); try{ await processTelegramUpdate(u); }catch(e){ console.error(e.message); } }
    }catch(e){ await new Promise(res=>setTimeout(res,3000)); }
  }
}

// ============ CS2.SH ============
let cs2CatalogCache = { data: null, expires: 0 };
const CS2_CACHE_MS = 10 * 60 * 1000;

function loadCatalogFromDisk(){
  try{
    const x=JSON.parse(fs.readFileSync(CATALOG_FILE,'utf8'));
    if(Array.isArray(x?.items) && x.items.length){ cs2CatalogCache.data=x.items; cs2CatalogCache.expires=Date.now()+CS2_CACHE_MS; console.log('Catalog from disk:',x.items.length); return true; }
  }catch(e){}
  return false;
}
function saveCatalogToDisk(items){ try{ fs.writeFileSync(CATALOG_FILE,JSON.stringify({items,savedAt:Date.now()})); }catch(e){ console.error(e.message); } }
async function refreshCatalogInBackground(){
  try{
    const items=await buildCs2Catalog();
    if(items?.length){ cs2CatalogCache={data:items,expires:Date.now()+CS2_CACHE_MS}; saveCatalogToDisk(items); console.log('Catalog refreshed:',items.length); }
  }catch(e){ console.error('catalog bg:',e.message); }
}

async function cs2Fetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const r = await fetch(url, {...options, signal: controller.signal, headers: {'Authorization':'Bearer '+KEY,'Accept':'application/json','Accept-Encoding':'gzip',...(options.headers||{})}});
        const text = await r.text();
        let d=null; try{ d=JSON.parse(text); }catch(_){}
        if(!r.ok){ const err=new Error(d?.message||d?.error||('HTTP '+r.status)); err.status=r.status; err.body=d||text.slice(0,1000); throw err; }
        return d;
    } finally { clearTimeout(timer); }
}

async function buildCs2Catalog() {
    const schema = await cs2Fetch('https://api.cs2.sh/v1/schema');
    const raw = schema?.items || schema || {};
    const arr = Array.isArray(raw) ? raw : Object.values(raw);
    const candidates=[]; const seen=new Set();
    for(const x of arr){
        const name = String(x?.market_hash_name||x?.name||'').trim();
        const image = x?.image||x?.icon_url||x?.image_url||'';
        if(!name||!image||!name.includes('|')) continue;
        const low = name.toLowerCase();
        if(low.includes('sticker')||low.includes('patch')||low.includes('graffiti')||low.includes('music kit')) continue;
        if(seen.has(name)) continue; seen.add(name); candidates.push({name,image});
    }
    const priorityWords=['ak-47 |','m4a1-s |','m4a4 |','awp |','usp-s |','glock-18 |','p250 |','deagle |','desert eagle |','famas |','galil ar |','mp9 |','mac-10 |','mp7 |','mp5-sd |','ump-45 |','p90 |','ssg 08 |','scar-20 |','aug |','sg 553 |','nova |','xm1014 |','mag-7 |','sawed-off |','tec-9 |','five-seven |','cz75-auto |','dual berettas |','r8 revolver |','negev |','m249 |'];
    const isWeapon=x=>{const c=String(x?.category||'').toLowerCase(),n=String(x?.name||'').toLowerCase();return c==='skin'||n.includes(' | ');};
    const rarityTier=x=>Number(x?.rarity?.tier||0);
    const isKnife=x=>/^★\s/.test(x.name)||String(x?.category||'').toLowerCase().includes('knife');
    const isGlove=x=>String(x?.category||'').toLowerCase().includes('glove')||x.name.toLowerCase().includes('gloves');
    const high=candidates.filter(x=>isWeapon(x)&&rarityTier(x)>=5);
    const knives=candidates.filter(x=>isKnife(x)||isGlove(x));
    const priority=candidates.filter(x=>priorityWords.some(w=>x.name.toLowerCase().startsWith(w)));
    const cheapPool=candidates.filter(x=>rarityTier(x)<=4);
    const selected=[]; const selectedSet=new Set();
    const add=x=>{ if(selected.length>=7000||!x||selectedSet.has(x.name))return; selectedSet.add(x.name); selected.push(x); };
    for(const x of high)add(x); for(const x of knives)add(x); for(const x of priority)add(x);
    const rest=cheapPool.filter(x=>!selectedSet.has(x.name));
    const need=7000-selected.length;
    if(need>0&&rest.length){ for(let i=0;i<Math.min(need,rest.length);i++){ const idx=Math.floor(i*rest.length/Math.min(need,rest.length)); add(rest[idx]); } }
    const remaining=candidates.filter(x=>!selectedSet.has(x.name));
    const left=7000-selected.length;
    if(left>0&&remaining.length){ for(let i=0;i<Math.min(left,remaining.length);i++){ const idx=Math.floor(i*remaining.length/Math.min(left,remaining.length)); add(remaining[idx]); } }
    const batches=[]; for(let i=0;i<selected.length;i+=100) batches.push(selected.slice(i,i+100).map(x=>x.name));
    const priceMap=new Map(); let cursor=0; const workers=Math.min(8,batches.length);
    async function worker(){ while(true){ const i=cursor++; if(i>=batches.length)return; try{ const d=await cs2Fetch('https://api.cs2.sh/v1/prices/latest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:batches[i]})}); for(const [n,it] of Object.entries(d?.items||{})) priceMap.set(n,it); }catch(e){ console.warn('batch:',e.message); } } }
    await Promise.all(Array.from({length:workers},worker));
    const result=[]; const sources=['steam','csfloat','buff','youpin','skinport','c5game'];
    for(const x of selected){
        const p=priceMap.get(x.name); if(!p)continue;
        let usd=0;
        for(const s of sources){ const ask=Number(p?.[s]?.ask); if(Number.isFinite(ask)&&ask>0){usd=ask;break;} }
        if(usd<=0)continue;
        if(usd*80<8)continue;
        result.push({id:'skin_'+crypto.createHash('sha1').update(x.name).digest('hex').slice(0,12),name:x.name,img:x.image,usd,api:p});
    }
    result.sort((a,b)=>a.usd-b.usd);
    return result.slice(0,7000);
}

function parseCookies(req){ const list={}; const rc=req.headers.cookie; if(!rc)return list; rc.split(';').forEach(c=>{const p=c.split('=');const k=p.shift().trim();list[k]=decodeURI(p.join('='));}); return list; }
async function readJson(req){ return new Promise((resolve,reject)=>{ let b=''; req.on('data',c=>{b+=c;if(b.length>2e6)req.destroy();}); req.on('end',()=>{try{resolve(JSON.parse(b||'{}'));}catch(e){reject(e);}}); req.on('error',reject); }); }

// ============ SERVER ============
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;
  const cookies = parseCookies(req);

  let sessionUser = null;
  if (cookies.session_id && sessions.has(cookies.session_id)) sessionUser = sessions.get(cookies.session_id);
  else {
    const signedSteam = steamFromSessionCookie(cookies.session_id);
    if(signedSteam){ const stored=ensureUser(signedSteam); if(stored){ sessionUser={steamid:signedSteam,username:stored.username||'',avatar:stored.avatar||''}; ensureZenodropId(stored); } }
  }

  if (pathname === '/auth/steam') {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const realm = `${proto}://${req.headers.host}`;
    const returnTo = `${realm}/auth/steam/return`;
    const params = new URLSearchParams({'openid.ns':'http://specs.openid.net/auth/2.0','openid.mode':'checkid_setup','openid.return_to':returnTo,'openid.realm':realm,'openid.identity':'http://specs.openid.net/auth/2.0/identifier_select','openid.claimed_id':'http://specs.openid.net/auth/2.0/identifier_select'});
    res.writeHead(302,{Location:`https://steamcommunity.com/openid/login?${params.toString()}`});
    return res.end();
  }

  if (pathname === '/auth/steam/return') {
    try {
      const params = new URLSearchParams();
      params.append('openid.ns','http://specs.openid.net/auth/2.0');
      params.append('openid.mode','check_authentication');
      urlObj.searchParams.forEach((v,k)=>{ if(k!=='openid.mode') params.append(k,v); });
      const v = await fetch('https://steamcommunity.com/openid/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
      const vt = await v.text();
      if(vt.includes('is_valid:true')){
        const claimed = urlObj.searchParams.get('openid.claimed_id');
        const m = claimed ? claimed.match(/\/id\/([0-9]{17})/) : null;
        const steamId = m ? m[1] : null;
        if(steamId){
          const pr = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
          const pd = await pr.json();
          const player = pd.response?.players?.[0] || {};
          const userData = {steamid:steamId,username:player.personaname||'',avatar:player.avatarfull||player.avatarmedium||player.avatar||''};
          const sid = makeSessionCookie(steamId);
          sessions.set(sid,userData);
          const stored = ensureUser(steamId); ensureZenodropId(stored); stored.username=userData.username; stored.avatar=userData.avatar;
          await saveStoreNow();
          res.writeHead(302,{Location:'/','Set-Cookie':`session_id=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`});
          return res.end();
        }
      }
    } catch(e){ console.error('Steam auth:',e); }
    res.writeHead(302,{Location:'/'}); return res.end();
  }

  if (pathname === '/api/current-user' && req.method === 'GET') {
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    if(sessionUser){
      const stored = ensureUser(sessionUser.steamid); ensureZenodropId(stored);
      const luck = getPlayerLuck(sessionUser.steamid);
      const serverAccount = {...stored, pendingWithdrawals: pendingWithdrawalsForUser(sessionUser.steamid)};
      return res.end(JSON.stringify({...sessionUser,serverAccount,webAdmin:isWebAdmin(sessionUser.steamid),luck}));
    }
    return res.end(JSON.stringify(null));
  }

  if (pathname === '/auth/logout') {
    if (cookies.session_id) sessions.delete(cookies.session_id);
    res.writeHead(302,{Location:'/','Set-Cookie':'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'});
    return res.end();
  }

  if (req.url === '/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(html); }

  if(pathname==='/api/upgrade-roll' && req.method==='POST'){
    if(!sessionUser?.steamid){ res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'auth_required'})); }
    try{
      const body = await readJson(req);
      const chance = Number(body.chance);
      if(!Number.isFinite(chance)||chance<0||chance>100){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_chance'})); }
      const success = upgrade(chance, sessionUser.steamid, Number(body.targetPrice)||0);
      const user = ensureUser(sessionUser.steamid);
      user.stats.upgradesTotal = (user.stats.upgradesTotal||0)+1;
      saveStore();
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true,success,chance}));
    }catch(e){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_json'})); }
  }

  if(pathname==='/api/case/open' && req.method==='POST'){
    if(!sessionUser?.steamid){ res.writeHead(401); return res.end(JSON.stringify({error:'auth_required'})); }
    try{
      const body = await readJson(req);
      const caseKey = String(body.case||'');
      const skins = Array.isArray(body.skins) ? body.skins : [];
      const cfg = CASES[caseKey];
      if(!cfg){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_case'})); }
      if(!skins.length){ res.writeHead(400); return res.end(JSON.stringify({error:'empty_pool'})); }
      const user = ensureUser(sessionUser.steamid); ensureZenodropId(user);
      if(Number(user.balance||0) < cfg.price){ res.writeHead(400); return res.end(JSON.stringify({error:'insufficient_balance',balance:Number(user.balance||0),price:cfg.price})); }

      const pityState = user.pity.byCase[caseKey] || 0;
      const recentDrops = Array.isArray(user.recentDrops) ? user.recentDrops : [];
      const result = openCase(caseKey, skins, pityState, recentDrops);
      if(!result || !result.skin){ res.writeHead(500); return res.end(JSON.stringify({error:'roll_failed'})); }

      user.balance = Number(user.balance||0) - cfg.price;
      user.stats.casesOpened = (user.stats.casesOpened||0)+1;

      user.recentDrops.unshift({
        name: result.skin.name,
        weapon: weaponKey(result.skin.name),
        value: result.skin.value,
        ts: Date.now()
      });
      user.recentDrops = user.recentDrops.slice(0, 8);

      const goodBands = new Set(['core','rare','mid']);
      if(goodBands.has(result.tier)) user.pity.byCase[caseKey] = 0;
      else user.pity.byCase[caseKey] = (user.pity.byCase[caseKey]||0)+1;

      saveStore();
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true,case:caseKey,price:cfg.price,skin:result.skin,tier:result.tier,label:result.label,balance:user.balance}));
    }catch(e){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_json'})); }
  }

  if(pathname==='/api/case/preview' && req.method==='POST'){
    try{
      const body = await readJson(req);
      const caseKey = String(body.case||'');
      const skins = Array.isArray(body.skins) ? body.skins : [];
      const cfg = CASES[caseKey];
      if(!cfg||!skins.length){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_input'})); }
      const N = Math.min(Number(body.n)||20000, 200000);
      let sum=0, tiers={}, inWindow=0;
      const recent = [];
      for(const s of skins){ const p = Number(s.price ?? s.value ?? s.usd ?? 0); if(p >= cfg.acceptMin && p < cfg.acceptMax) inWindow++; }
      for(let i=0;i<N;i++){
        const r = openCase(caseKey, skins, 0, recent);
        if(!r) continue;
        sum += r.skin.value;
        tiers[r.tier] = (tiers[r.tier]||0)+1;
        recent.unshift({name:r.skin.name, weapon:weaponKey(r.skin.name), ts:Date.now()});
        recent.length = Math.min(recent.length, 8);
      }
      const ev = sum/N;
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true,case:caseKey,samples:N,poolSize:skins.length,inWindow,accept:[cfg.acceptMin,cfg.acceptMax],ev:+ev.toFixed(2),evPercent:+((ev/cfg.price)*100).toFixed(2),targetRtp:cfg.rtp,tiers}));
    }catch(e){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_json'})); }
  }

  if(pathname==='/api/account/sync' && req.method==='POST'){
    if(!sessionUser?.steamid){ res.writeHead(401); return res.end(JSON.stringify({error:'auth_required'})); }
    try{
      const body = await readJson(req);
      const u = ensureUser(sessionUser.steamid); ensureZenodropId(u);
      if(Number.isFinite(Number(body.balance))) u.balance = Math.max(0, Number(body.balance));
      if(body.stats && typeof body.stats === 'object'){
        if(typeof body.stats.upgradesTotal === 'number') u.stats.upgradesTotal = Math.max(u.stats.upgradesTotal||0, body.stats.upgradesTotal);
        if(typeof body.stats.casesOpened === 'number') u.stats.casesOpened = Math.max(u.stats.casesOpened||0, body.stats.casesOpened);
      }
      if(Array.isArray(body.inventory)){
        u.inventory = body.inventory.slice(0,5000).map(x=>({id:String(x?.id||''),name:String(x?.name||''),category:'skins',value:Number(x?.value)||0,img:String(x?.img||''),uid:String(x?.uid||'')})).filter(x=>x.name&&x.uid);
      }
      if(body.bestDrop && typeof body.bestDrop === 'object'){
        u.bestDrop = {name:String(body.bestDrop.name||'--'),value:Number(body.bestDrop.value)||0,img:String(body.bestDrop.img||'')};
      }
      saveStore();
      const responseUser = {...u, pendingWithdrawals: pendingWithdrawalsForUser(sessionUser.steamid)};
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:true,user:responseUser}));
    }catch(e){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_json'})); }
  }

  if(pathname==='/api/config' && req.method==='GET'){
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({telegramBotUrl:TG_BOT_URL||null,cases:CASES,bands:CASE_BANDS,storage:USE_REDIS?'redis':'disk'}));
  }

  if(pathname==='/api/promos' && req.method==='GET'){
    const list = promoList().slice(0,8).map(x=>({code:x.code,percent:x.percent,maxBonus:x.maxBonus,expiresAt:x.expiresAt||0,auto:!!x.auto,uses:Number(x.uses||0),maxUses:Number(x.maxUses||0)}));
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({items:list}));
  }

  if(pathname==='/api/deposit' && req.method==='POST'){
    if(!sessionUser?.steamid){ res.writeHead(401); return res.end(JSON.stringify({error:'auth_required'})); }
    const body = await readJson(req);
    const amount = Number(body.amount)||0, method = String(body.method||''), promo = String(body.promo||'').toUpperCase();
    if(amount < 50){ res.writeHead(400); return res.end(JSON.stringify({error:'min_50'})); }
    const pc = promo ? data.promos[promo] : null;
    if(promo && (!pc||pc.active===false||(pc.expiresAt && pc.expiresAt<=Date.now()))){ res.writeHead(400); return res.end(JSON.stringify({error:'promo_invalid'})); }
    const bonus = pc ? Math.min(amount*(Number(pc.percent)||0)/100, Number(pc.maxBonus)||Infinity) : 0;
    const id = 'dep_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');
    data.deposits.push({id,steamid:sessionUser.steamid,tgId:ensureUser(sessionUser.steamid)?.tgId||null,amount,bonus,method,promo,status:'pending',createdAt:Date.now()});
    await saveStoreNow();
    await notifyAdmins(`💳 <b>Пополнение</b>\n<code>${id}</code>\n<code>${sessionUser.steamid}</code>\n${amount.toFixed(2)} ₽\n${method}\nПромо: ${promo||'—'}\nИтого: ${(amount+bonus).toFixed(2)} ₽`,[[{text:'✅ Зачислить',callback_data:`dep:${id}:approve`},{text:'❌ Отклонить',callback_data:`dep:${id}:reject`}]]);
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,id,bonus,total:amount+bonus}));
  }

  if(pathname==='/api/withdrawals' && req.method==='POST'){
    if(!sessionUser?.steamid){ res.writeHead(401); return res.end(JSON.stringify({error:'auth_required'})); }
    const body = await readJson(req);
    const index = Number(body.index);
    const stored = ensureUser(sessionUser.steamid);
    if(stored.withdrawDisabled){ res.writeHead(403); return res.end(JSON.stringify({error:'withdraw_disabled'})); }
    const item = body.item;
    if(!item||!item.name||!Number(item.value)){ res.writeHead(400); return res.end(JSON.stringify({error:'item_required'})); }
    const itemUid = String(item.uid||'');
    if(!itemUid){ res.writeHead(400); return res.end(JSON.stringify({error:'item_uid_required'})); }
    const ap = data.withdrawals.some(x=>x.steamid===sessionUser.steamid && x.item?.uid===itemUid && (x.status==='pending'||x.status==='approved'));
    if(ap){ res.writeHead(409); return res.end(JSON.stringify({error:'item_withdraw_pending'})); }
    const id = 'wd_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');
    const w = {id,steamid:sessionUser.steamid,tgId:stored.tgId||null,index,item:{name:item.name,value:Number(item.value),img:item.img||'',assetid:item.assetid||null,uid:itemUid},value:Number(item.value),status:'pending',createdAt:Date.now()};
    data.withdrawals.push(w); await saveStoreNow();
    await notifyAdmins(`🟠 <b>Вывод</b>\n<code>${id}</code>\n<code>${sessionUser.steamid}</code>\n${w.value.toFixed(2)} ₽\n${item.name}`,[[{text:'🎁 Выдать',callback_data:`wd:${id}:send`},{text:'❌ Отклонить',callback_data:`wd:${id}:reject`}]]);
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,id,status:'pending'}));
  }

  if(pathname==='/api/admin/state' && req.method==='GET'){
    if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){ res.writeHead(403); return res.end(JSON.stringify({error:'forbidden'})); }
    await refreshFromRedis();
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({users:Object.values(data.users),withdrawals:data.withdrawals.slice(-100).reverse(),deposits:data.deposits.slice(-100).reverse(),promos:promoList(),cases:CASES,bands:CASE_BANDS,storage:USE_REDIS?'redis':'disk'}));
  }

  if(pathname==='/api/admin/promo' && req.method==='POST'){
    if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){ res.writeHead(403); return res.end(JSON.stringify({error:'forbidden'})); }
    const body = await readJson(req);
    const code = String(body.code||'').trim().toUpperCase(), percent = Number(body.percent), maxBonus = Number(body.maxBonus)||0, expiresMinutes = Number(body.expiresMinutes)||0;
    if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!Number.isFinite(percent)||percent<1||percent>100){ res.writeHead(400); return res.end(JSON.stringify({error:'invalid_promo'})); }
    const p = makePromo(code,percent,maxBonus,{auto:false,expiresAt:expiresMinutes>0?Date.now()+expiresMinutes*60000:0});
    await saveStoreNow();
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,promo:p}));
  }

  if(pathname==='/api/admin/user' && req.method==='POST'){
    if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){ res.writeHead(403); return res.end(JSON.stringify({error:'forbidden'})); }
    const body = await readJson(req);
    const u = ensureUser(body.steamid);
    if(!u){ res.writeHead(400); return res.end(JSON.stringify({error:'steamid_required'})); }
    if(body.balanceDelta !== undefined) u.balance += Number(body.balanceDelta)||0;
    if(body.balance !== undefined) u.balance = Number(body.balance)||0;
    if(body.withdrawDisabled !== undefined) u.withdrawDisabled = !!body.withdrawDisabled;
    await saveStoreNow();
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,user:u}));
  }

  if(pathname==='/api/admin/deposit-confirm' && req.method==='POST'){
    if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){ res.writeHead(403); return res.end(JSON.stringify({error:'forbidden'})); }
    const body = await readJson(req);
    const d = data.deposits.find(x=>x.id===body.id);
    if(!d){ res.writeHead(404); return res.end(JSON.stringify({error:'not_found'})); }
    if(d.status !== 'pending'){ return res.end(JSON.stringify({ok:true,status:d.status})); }
    const u = ensureUser(d.steamid);
    u.balance += d.amount + d.bonus;
    u.stats.totalDeposited = (u.stats.totalDeposited||0) + d.amount + d.bonus;
    if(d.promo && data.promos[d.promo]) data.promos[d.promo].uses = (data.promos[d.promo].uses||0)+1;
    d.status = 'paid'; d.updatedAt = Date.now(); await saveStoreNow();
    if(d.tgId) await tg('sendMessage',{chat_id:d.tgId,text:`✅ Пополнение <b>${d.id}</b>: +${(d.amount+d.bonus).toFixed(2)} ₽`,parse_mode:'HTML'});
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,user:u}));
  }

  if (pathname === '/api/usd-rub' && req.method === 'GET') {
    try {
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(),3000);
      const r = await fetch('https://kurs-rublya.ru/api/v1/rates/USD/',{signal:controller.signal,headers:{Accept:'application/json'}});
      clearTimeout(timer);
      const text = await r.text();
      if(!r.ok){ res.writeHead(r.status,{'Content-Type':'application/json'}); return res.end(text); }
      const d = JSON.parse(text);
      const rate = Number(d.ratePerUnit || d.value || d.data?.ratePerUnit || d.data?.rate);
      if(!Number.isFinite(rate)||rate<=0) throw new Error('Invalid USD rate');
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({rate,source:'kurs-rublya.ru',updatedAt:new Date().toISOString()}));
    } catch(e){ res.writeHead(502,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:String(e)})); }
  }

  if (pathname === '/api/cs2/catalog' && req.method === 'GET') {
    if (cs2CatalogCache.data && cs2CatalogCache.data.length) {
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300'});
      return res.end(JSON.stringify({currency:'USD',items:cs2CatalogCache.data,cached:true}));
    }
    refreshCatalogInBackground();
    res.writeHead(202,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({currency:'USD',items:[],warming:true}));
  }

  if (pathname === '/api/cs2/schema' && req.method === 'GET') {
    try {
      const r = await fetch('https://api.cs2.sh/v1/schema',{method:'GET',headers:{'Authorization':'Bearer '+KEY,'Accept-Encoding':'gzip'}});
      const text = await r.text();
      res.writeHead(r.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      return res.end(text);
    } catch(e){ res.writeHead(502,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'cs2_schema_proxy_error',message:String(e)})); }
  }

  if (pathname === '/api/prices' && req.method === 'POST') {
    let body = '';
    req.on('data',c=>{ body += c; });
    req.on('end', async () => {
      try{
        const input = JSON.parse(body || '{}');
        const items = Array.isArray(input.items) ? input.items.filter(x=>typeof x === 'string' && x.trim()).slice(0,100) : [];
        if(!items.length){ res.writeHead(400,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'items_required'})); }
        const r = await fetch('https://api.cs2.sh/v1/prices/latest',{method:'POST',headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json','Accept-Encoding':'gzip'},body:JSON.stringify({items})});
        const text = await r.text();
        res.writeHead(r.status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
        return res.end(text);
      } catch(e){ res.writeHead(502,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'cs2_prices_proxy_error',message:String(e.message||e)})); }
    });
    return;
  }

  if((pathname==='/telegram/admin-webhook' || pathname==='/telegram/webhook') && req.method==='POST'){
    const update = await readJson(req);
    const expected = TG_TOKEN ? crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0,32) : '';
    const provided = String(req.headers['x-telegram-bot-api-secret-token']||'');
    if(expected && provided !== expected){ res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'forbidden'})); return; }
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    Promise.resolve(processTelegramUpdate(update)).catch(e=>console.error('admin wh:',e.message));
    return;
  }

  if(pathname==='/privacy' || pathname==='/terms' || pathname==='/info'){
    const title = pathname==='/privacy' ? 'Политика конфиденциальности' : pathname==='/terms' ? 'Пользовательское соглашение' : 'Информация Zenodrop';
    const body = pathname==='/privacy' ? `<h1>Политика конфиденциальности Zenodrop</h1><p><b>Дата актуализации: 9 сентября 2026 года.</b></p><p>Настоящая политика описывает обработку данных при использовании сайта Zenodrop.</p><h2>1. Какие данные обрабатываются</h2><p>Steam ID, отображаемое имя и аватар Steam, данные аккаунта Zenodrop, операции пополнения и вывода, а также технические данные, необходимые для работы сайта.</p><h2>2. Цели обработки</h2><p>Авторизация, ведение аккаунта, выполнение операций, предотвращение злоупотреблений, поддержка пользователей и обеспечение безопасности.</p><h2>3. Хранение</h2><p>Данные хранятся только в объёме, необходимом для работы сервиса и исполнения операций.</p><h2>4. Передача</h2><p>Данные могут передаваться техническим и платёжным провайдерам только в объёме, необходимом для соответствующей операции.</p><h2>5. Обращения</h2><p>Поддержка: ${SUPPORT_CONTACT}</p>` : pathname==='/terms' ? `<h1>Пользовательское соглашение Zenodrop</h1><p><b>Дата актуализации: 9 сентября 2026 года.</b></p><h2>1. Общие положения</h2><p>Используя Zenodrop, пользователь подтверждает, что ознакомился с настоящим соглашением и принимает его условия.</p><h2>2. Аккаунт</h2><p>Для использования функций аккаунта требуется авторизация через Steam.</p><h2>3. Пополнение</h2><p>Перед оплатой пользователь видит выбранный тариф и конкретную сумму.</p><h2>4. Вывод</h2><p>Заявки на вывод обрабатываются в соответствии с правилами сервиса.</p><h2>5. Поддержка</h2><p>${SUPPORT_CONTACT}</p>` : `<h1>Zenodrop — информация</h1><p><b>Актуально на 9 сентября 2026 года.</b></p><p><a href="/privacy">Политика конфиденциальности</a></p><p><a href="/terms">Пользовательское соглашение</a></p>`;
    const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#0d0f17;color:#e8ecf4;max-width:820px;margin:0 auto;padding:32px;line-height:1.6}h1{color:#f59e0b}h2{color:#fff;margin-top:28px}a{color:#f7b32b}code{background:#1b2130;padding:3px 7px;border-radius:6px}</style></head><body>${body}<hr><p><a href="/info">← К информации</a></p></body></html>`;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); return res.end(page);
  }

  res.writeHead(404); res.end('Not found');
});

(async () => {
  await initStore();
  for(const u of Object.values(data.users)){ ensureZenodropId(u); }
  await saveStoreNow();
  ensureOneActivePromo();
  setInterval(()=>{ const a = promoList()[0]; if(!a || (a.expiresAt && a.expiresAt<=Date.now()) || a.auto) createAutoPromo(); }, 15*60*1000);
  loadCatalogFromDisk();
  if(!cs2CatalogCache.data) refreshCatalogInBackground();
  setInterval(refreshCatalogInBackground, CS2_CACHE_MS);
  server.listen(PORT, () => {
    console.log('Zenodrop on ' + PORT);
    console.log('PUBLIC_URL:', PUBLIC_URL || '(not set)');
    console.log('DATA_DIR:', DATA_DIR);
    console.log('Storage:', USE_REDIS ? 'Redis' : 'disk');
    if(TG_TOKEN){ console.log('Admin TG enabled'); telegramStart(); } else console.log('Admin TG off');
  });
})();
