const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;

const KEY = (
    process.env.CS2SH_API_KEY ||
    process.env.CS2_API_KEY ||
    process.env.CS2SH_KEY ||
    ''
).trim();

const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();

if (!KEY) {
    console.error('ERROR: Set CS2SH_API_KEY in environment variables');
    process.exit(1);
}

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.APP_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
).trim().replace(/\/$/,'');

const html = fs.readFileSync(path.join(__dirname, 'Zenodrop_CS2SH_400.html'));

// ===============================
// SESSIONS
// ===============================
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

// ============================================================
//  ХРАНИЛИЩЕ
//
//  Приоритет:
//    1. Upstash Redis (env: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
//    2. Локальный файл (DATA_DIR / __dirname)
//
//  data — синхронный объект в памяти.
//  saveStore() пишет и на диск, и в Redis (дебаунс 300 мс).
//  initStore() при старте: сначала Redis, если пусто → диск, если и там пусто → с нуля.
// ============================================================
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/,'');
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = (process.env.REDIS_STORE_KEY || 'zenodrop:store').trim();

const DATA_DIR = (process.env.DATA_DIR || __dirname).trim();
const DATA_FILE = path.join(DATA_DIR, 'zenodrop_data.json');
const CATALOG_FILE = path.join(DATA_DIR, 'cs2_catalog_cache.json');

const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TG_BOT_URL = (process.env.TELEGRAM_BOT_URL || '').trim();
const TG_WEBHOOK_URL = (process.env.TELEGRAM_WEBHOOK_URL || (PUBLIC_URL ? PUBLIC_URL + '/telegram/admin-webhook' : '')).trim();
const PAY_TG_TOKEN = (process.env.TELEGRAM_PAYMENT_BOT_TOKEN || '').trim();
const PAY_TG_BOT_URL = (process.env.TELEGRAM_PAYMENT_BOT_URL || 'https://t case.me/ZenodropPayBot').trimPrice();
const PAY_TG_WEBHOOK_URL = (process.env.T);
ELEGRAM_PAYMENT_WEBHOOK_URL    || (PUBLIC_URL ? PUBLIC_URL + const '/telegram/payment-webhook' : w '')).trim();
const SUPPORT_CONTACT = '@Zenodropsupport';

// ============================================================
//  REDIS CLIENT (Upstash REST API)
// ============================================================
async function redisCmd(args){
  if(!USE_REDIS) return null;
  try{
    const r = await fetch(REDIS_URL, {
      method:'POST',
      headers:{
        'Authorization': 'Bearer ' + REDIS_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    if(!r.ok){ console.error('Redis HTTP', r.status); return null; }
    const j = await r.json();
    return j?.result ?? null;
  }catch(e){ console.error('Redis error:', e.message); return null; }
}
async function redisLoad(key){
  const v = await redisCmd(['GET', key]);
  if(v === null || v === undefined) return null;
  try{ return typeof v === 'string' ? JSON.parse(v) : v; }catch(e){ return null; }
}
async function redisSave(key, obj){
  try{ await redisCmd(['SET', key, JSON.stringify(obj)]); }
  catch(e){ console.error('redisSave error:', e.message); }
}

// ============================================================
//  КЕЙСЫ
// ============================================================
const CASES = {
  micro:     { price: 13,    rtp: 0.95, alpha: 0.35, pity: 12 },
  basic:     { price: 100,   rtp: 0.86, alpha: 0.60, pity: 10 },
  small:     { price: 250,   rtp: 0.87, alpha: 0.65, pity: 10 },
  premium:   { price: 500,   rtp: 0.88, alpha: 0.70, pity: 10 },
  expensive: { price: 1000,  rtp: 0.89, alpha: 0.75, pity: 9 },
  elite:     { price: 2500,  rtp: 0.89, alpha: 0.85, pity: 9 },
  legendary: { price: 5000,  rtp: 0.90, alpha: 0.90, pity: 8 },
  titan:     { price: 10000, rtp: 0.90, alpha: 1.00, pity: 8 }
};

const TIERS = [
  { name:'big_loss', min:0.00, max:0.55, weight: 4 },
  { name:'loss',     min:0.55, max:0.86, weight: 12 },
  { name:'low_flat', min:0.86, max:0.96, weight: 20 },
  { name:'flat',     min:0.96, max:1.08, weight: 34 },
  { name:'plus',     min:1.08, max:1.50, weight: 20 },
  { name:'mega',     min:1.50, max:3.00, weight: 8 },
  { name:'jackpot',  min:3.00, max:12.0, weight: 2 }
];

function itemPrice(s){
  const v = Number(s?.price ?? s?.value ?? s?.usd ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
function tierOf(price, casePrice){
  const r = casePrice > 0 ? price / casePrice : 0;
  for (const t of TIERS){
    if (r >= t.min && r < t.max) return t;
  }
  return r >= TIERS[TIERS.length-1].max ? TIERS[TIERS.length-1] : TIERS[0];
}
function insideTierWeight(price, alpha){
  const p = Math.max(price, 1);
  return Math.pow(1 / p, alpha);
}
function baseWeights(items, casePrice, alpha){
  const arr = items.map(x => {
    const p = itemPrice(x);
    const t = tierOf(p, = t.weight * insideTierWeight(p, alpha);
    return { ...x, price: p, _tier: t.name, _w: w };
  });
  const total = arr.reduce((s,x) => s + x._w, 0) || 1;
  return arr.map(x => ({ ...x, _w: x._w / total }));
}
function fitRtp(weighted, casePrice, targetRtp, iterations = 40){
  if (!weighted.length || !casePrice) return weighted;
  const target = casePrice * targetRtp;
  let list = weighted.slice();
  for (let it = 0; it < iterations; it++){
    const total = list.reduce((s,x) => s + x._w, 0) || 1;
    const ev = list.reduce((s,x) => s + (x._w / total) * x.price, 0);
    if (ev <= 0) break;
    const k = target / ev;
    if (Math.abs(1 - k) < 0.001) break;
    list = list.map(x => {
      const p = x.price;
      const exp = p >= casePrice ? 1.6 : p >= casePrice * 0.5 ? 1.0 : 0.4;
      return { ...x, _w: x._w * Math.pow(k, exp) };
    });
    const t2 = list.reduce((s,x) => s + x._w, 0) || 1;
    list = list.map(x => ({ ...x, _w: x._w / t2 }));
  }
  return list;
}
function applyPity(weighted, casePrice, n){
  if (!n || n <= 0) return weighted;
  const boost = Math.min(1 + n * 0.15, 3.0);
  return weighted.map(x => {
    const t = x._tier;
    if (t === 'plus')  return { ...x, _w: x._w * boost };
    if (t === 'mega')  return { ...x, _w: x._w * (boost * 0.6) };
    if (t === 'jackpot') return { ...x, _w: x._w * (boost * 0.4) };
    return x;
  });
}
function normalize(list){
  const total = list.reduce((s,x) => s + x._w, 0) || 1;
  return list.map(x => ({ ...x, _w: x._w / total }));
}
function pickByWeight(list){
  const total = list.reduce((s,x) => s + x._w, 0) || 1;
  let r = Math.random() * total;
  let cur = 0;
  for (const x of list){
    cur += x._w;
    if (r <= cur) return x;
  }
  return list[list.length - 1];
}
function openCase(caseKey, items, pityCount = 0){
  const cfg = CASES[String(caseKey)];
  if (!cfg || !Array.isArray(items) || !items.length) return null;
  let weighted = baseWeights(items, cfg.price, cfg.alpha);
  weighted = fitRtp(weighted, cfg.price, cfg.rtp);
  weighted = applyPity(weighted, cfg.price, pityCount);
  weighted = normalize(weighted);
  const picked = pickByWeight(weighted);
  if (!picked) return null;
  return {
    skin: {
      id: picked.id,
      name: picked.name,
      img: picked.img,
      value: picked.price,
      tier: picked._tier
    },
    price: cfg.price,
    tier: picked._tier
  };
}

// ============================================================
//  АПГРЕЙД + СЧАСТЛИВЧИКИ
// ============================================================
const LUCK_MAP = new Map();

function getPlayerLuck(steamid){
  const id = String(steamid || '');
  if (!id) return 1.0;
  if (LUCK_MAP.has(id)) return LUCK_MAP.get(id);
  const hash = crypto.createHash('sha256').update('zenodrop_luck:' + id).digest();
  const r = hash[0] / 255;
  let luck;
  if (r < 0.30)      luck = 0.85;
  else if (r < 0.50) luck = 1.15;
  else               luck = 1.0;
  LUCK_MAP.set(id, luck);
  return luck;
}

function upgrade(chance, steamid, targetPrice){
  chance = Number(chance);
  if (!Number.isFinite(chance)) return false;
  if (chance < 0)   chance = 0;
  if (chance > 100) chance = 100;
  const price = Number(targetPrice || 0);
  let real = chance;
  if (price >= 20000)      real *= 0.35;
  else if (price >= 15000) real *= 0.50;
  else if (price >= 10000) real *= 0.60;
  else if (price >= 5000)  real *= 0.75;
  real *= getPlayerLuck(steamid);
  if (real < 0.5) real = 0.5;
  if (real > 95)  real = 95;
  return Math.random() * 100 < real;
}

const TG_ADMIN_IDS = new Set(String(process.env.TG_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));

// ============================================================
//  STORE
// ============================================================
let data = {
  users:{},
  withdrawals:[],
  deposits:[],
  promos:{},
  admins:{},
  links:{}
};

function loadStoreFromDisk(){
  try {
    const x = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    return {
      users: x.users || {},
      withdrawals: x.withdrawals || [],
      deposits: x.deposits || [],
      promos: x.promos || {},
      admins: x.admins || {},
      links: x.links || {}
    };
  } catch(e) {
    return null;
  }
}
function saveStoreToDisk(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); }
  catch(e){ console.error('store save (disk):', e.message); }
}
let __saveTimer = null;
let __saveInFlight = false;
function saveStore(){
  saveStoreToDisk();
  if(!USE_REDIS) return;
  if(__saveTimer) clearTimeout(__saveTimer);
  __saveTimer = setTimeout(async ()=>{
    if(__saveInFlight) return;
    __saveInFlight = true;
    try{ await redisSave(REDIS_KEY, data); }
    finally{ __saveInFlight = false; }
  }, 300);
}
async function initStore(){
  if(USE_REDIS){
    const remote = await redisLoad(REDIS_KEY);
    if(remote && typeof remote === 'object'){
      data = {
        users: remote.users || {},
        withdrawals: remote.withdrawals || [],
        deposits: remote.deposits || [],
        promos: remote.promos || {},
        admins: remote.admins || {},
        links: remote.links || {}
      };
      console.log('Store loaded from Redis:',
        Object.keys(data.users).length, 'users,',
        data.withdrawals.length, 'withdrawals,',
        data.deposits.length, 'deposits');
      return;
    }
    console.log('Redis empty → trying local disk');
  }
  const local = loadStoreFromDisk();
  if(local){
    data = local;
    console.log('Store loaded from disk:',
      Object.keys(data.users).length, 'users,',
      data.withdrawals.length, 'withdrawals,',
      data.deposits.length, 'deposits');
    if(USE_REDIS){
      console.log('Pushing local store to Redis...');
      await redisSave(REDIS_KEY, data);
    }
    return;
  }
  console.log('Empty store (fresh start)');
}

function ensureUser(steamid){
  const id=String(steamid||''); if(!id)return null;
  if(!data.users[id]) data.users[id]={
    steamid:id,
    balance:0,
    stats:{totalDeposited:0, upgradesTotal:0, casesOpened:0},
    withdrawDisabled:false,
    tgId:null,
    createdAt:Date.now(),
    inventory:[],
    bestDrop:{name:'--',value:0,img:''},
    pity:{count:0, byCase:{}}
  };
  if(!data.users[id].stats) data.users[id].stats={totalDeposited:0, upgradesTotal:0, casesOpened:0};
  if(typeof data.users[id].stats.totalDeposited!=='number') data.users[id].stats.totalDeposited=0;
  if(typeof data.users[id].stats.upgradesTotal!=='number') data.users[id].stats.upgradesTotal=0;
  if(typeof data.users[id].stats.casesOpened!=='number') data.users[id].stats.casesOpened=0;
  if(!Array.isArray(data.users[id].inventory)) data.users[id].inventory=[];
  if(!data.users[id].bestDrop) data.users[id].bestDrop={name:'--',value:0,img:''};
  if(!data.users[id].pity) data.users[id].pity={count:0, byCase:{}};
  if(!data.users[id].pity.byCase) data.users[id].pity.byCase={};
  return data.users[id];
}
function makeZenodropId(userOrSteam){
  const steam=typeof userOrSteam==='object' ? String(userOrSteam?.steamid||'') : String(userOrSteam||'');
  if(/^\d{17}$/.test(steam)){
    const hex=crypto.createHash('sha256').update('zenodrop:'+steam).digest('hex').slice(0,12);
    const num=(parseInt(hex,16)%90000000)+10000000;
    return 'ZN-'+String(num);
  }
  let id='';
  do { id='ZN-'+String(crypto.randomInt(10000000,100000000)); }
  while(Object.values(data.users).some(u=>u.zenoId===id));
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
function findSteamByTelegram(chatId){
  return data.links[String(chatId)] || Object.values(data.users).find(u=>String(u.tgId||'')===String(chatId))?.steamid || null;
}
function pendingWithdrawalsForUser(steamid){
  return data.withdrawals
    .filter(w=>w.steamid===steamid && (w.status==='pending' || w.status==='approved'))
    .map(w=>({
      id:w.id,
      itemUid:w.item?.uid||null,
      itemName:w.item?.name||'',
      itemValue:Number(w.item?.value)||0,
      status:w.status,
      index:w.index,
      createdAt:w.createdAt||0
    }));
}
function isTgAdmin(id){return TG_ADMIN_IDS.has(String(id)) || !!data.admins[String(id)];}
function isWebAdmin(steamid){return !!data.admins['steam:'+String(steamid)];}
async function tg(method, body={}){ return tgWithToken(TG_TOKEN,'admin',method,body); }
async function tgPay(method, body={}){ return tgWithToken(PAY_TG_TOKEN,'payment',method,body); }
async function tgWithToken(token,label,method,body={}){
  if(!token){ console.error(`Telegram ${label}: token is not set`); return null; }
  try{
    const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    const json=await r.json();
    if(!json?.ok) console.error(`Telegram ${label} API`,method,json?.description||'unknown error');
    return json;
  }catch(e){ console.error(`Telegram ${label}`,method,e.message); return null; }
}
async function notifyAdmins(text, keyboard){
  for(const id of TG_ADMIN_IDS){
    await tg('sendMessage',{chat_id:id,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined});
  }
  for(const [id,v] of Object.entries(data.admins)){
    if(v && !TG_ADMIN_IDS.has(id)){
      await tg('sendMessage',{chat_id:id,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined});
    }
  }
}
function promoList(){
  return Object.values(data.promos)
    .filter(x=>x.active!==false && (!x.expiresAt || x.expiresAt>Date.now()) && (!x.maxUses || Number(x.uses||0)<Number(x.maxUses)))
    .sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
}
function makePromo(code,percent,maxBonus=0,extra={}){
  const c=String(code||'').toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32);
  const pct=Math.max(1,Math.min(100,Number(percent)||0));
  if(!c) return null;
  for(const p of Object.values(data.promos)){ p.active=false; }
  data.promos[c]={code:c,percent:pct,maxBonus:Math.max(0,Number(maxBonus)||0),active:true,createdAt:Date.now(),uses:0,...extra};
  saveStore();
  return data.promos[c];
}
function createAutoPromo(){
  const percent=[10,12,15,18,20,25][crypto.randomInt(0,6)];
  return makePromo('ZEN'+percent,percent,0,{auto:true,expiresAt:Date.now()+15*60*1000,maxUses:0});
}
function ensureOneActivePromo(){
  const active=promoList();
  if(active.length){
    const keep=active[0];
    for(const p of Object.values(data.promos)){ if(p.code!==keep.code) p.active=false; }
    saveStore();
    return keep;
  }
  return createAutoPromo();
}

// ============================================================
//  АДМИН-БОТ
// ============================================================
async function sendAdminMenu(chatId){
  const pendingWd=data.withdrawals.filter(x=>x.status==='pending').length;
  const pendingDep=data.deposits.filter(x=>x.status==='pending').length;
  return tg('sendMessage',{
    chat_id:chatId,
    text:`<b>Zenodrop — Админ-панель</b>\n\nОжидают вывода: <b>${pendingWd}</b>\nОжидают пополнения: <b>${pendingDep}</b>\n\nВыберите действие:`,
    parse_mode:'HTML',
    reply_markup:{inline_keyboard:[
      [{text:'💳 Пополнения',callback_data:'adm:deposits'},{text:'🎁 Выводы',callback_data:'adm:withdrawals'}],
      [{text:'📊 Статистика',callback_data:'adm:stats'},{text:'🎟 Промокоды',callback_data:'adm:promo'}],
      [{text:'🔄 Обновить',callback_data:'adm:menu'}]
    ]}
  });
}

async function processTelegramUpdate(u){
  if(u.callback_query){
    const q=u.callback_query;
    const id=String(q.from.id);
    const d=String(q.data||'');
    if(!isTgAdmin(id)){
      await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Нет доступа',show_alert:true});
      return;
    }
    if(d.startsWith('wd:')){
      const parts=d.split(':');
      const wid=parts[1], action=parts[2];
      const w=data.withdrawals.find(x=>x.id===wid);
      if(!w){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка не найдена',show_alert:true}); return; }
      if(action==='send'){
        w.status='approved';w.updatedAt=Date.now();saveStore();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка подтверждена'});
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`🎁 Заявка <b>${wid}</b> подтверждена.\nСкин: ${w.item?.name}\nСумма: ${Number(w.value).toFixed(2)} ₽`,parse_mode:'HTML'});
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`🎁 Вывод <b>${wid}</b> подтверждён. Скины отправляются.`,parse_mode:'HTML'});
      } else if(action==='reject'){
        const user=ensureUser(w.steamid);
        if(user){user.balance+=Number(w.refund||0);saveStore();}
        w.status='rejected';w.updatedAt=Date.now();saveStore();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка отклонена'});
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`❌ Вывод <b>${wid}</b> отклонён. ${Number(w.refund||0).toFixed(2)} ₽ возвращены на баланс.`,parse_mode:'HTML'});
      }
      return;
    }
    if(d.startsWith('dep:')){
      const parts=d.split(':');
      const did=parts[1], action=parts[2];
      const dep=data.deposits.find(x=>x.id===did);
      if(!dep){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка не найдена',show_alert:true}); return; }
      if(dep.status!=='pending'){ await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Уже обработана'}); return; }
      if(action==='approve'){
        const u=ensureUser(dep.steamid);
        const total=Number(dep.amount||0)+Number(dep.bonus||0);
        u.balance+=total;
        u.stats.totalDeposited=(u.stats.totalDeposited||0)+total;
        if(dep.promo && data.promos[dep.promo]) data.promos[dep.promo].uses=(data.promos[dep.promo].uses||0)+1;
        dep.status='paid';dep.updatedAt=Date.now();saveStore();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'✅ Зачислено'});
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`✅ Пополнение <b>${did}</b> зачислено: <b>+${total.toFixed(2)} ₽</b>\nSteam: <code>${dep.steamid}</code>`,parse_mode:'HTML'});
        if(dep.tgId) await tg('sendMessage',{chat_id:dep.tgId,text:`✅ Баланс пополнен на <b>${total.toFixed(2)} ₽</b>`,parse_mode:'HTML'});
      } else if(action==='reject'){
        dep.status='rejected';dep.updatedAt=Date.now();saveStore();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Отклонено'});
        if(dep.tgId) await tg('sendMessage',{chat_id:dep.tgId,text:`❌ Пополнение <b>${did}</b> отклонено.`,parse_mode:'HTML'});
      }
      return;
    }
    if(d==='adm:menu'){ await tg('answerCallbackQuery',{callback_query_id:q.id}); return sendAdminMenu(q.message.chat.id); }
    if(d==='adm:withdrawals'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const list=data.withdrawals.filter(x=>x.status==='pending').slice(-10).reverse();
      if(!list.length) return tg('sendMessage',{chat_id:q.message.chat.id,text:'Заявок на вывод нет.'});
      for(const w of list){
        await tg('sendMessage',{chat_id:q.message.chat.id,
          text:`🟠 <b>${w.id}</b>\nSteam: <code>${w.steamid}</code>\nСумма: ${Number(w.value).toFixed(2)} ₽\nПредмет: ${w.item.name}`,
          parse_mode:'HTML',
          reply_markup:{inline_keyboard:[[
            {text:'🎁 Выдать',callback_data:`wd:${w.id}:send`},
            {text:'❌ Отклонить',callback_data:`wd:${w.id}:reject`}
          ]]}
        });
      }
      return;
    }
    if(d==='adm:deposits'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const list=data.deposits.filter(x=>x.status==='pending').slice(-10).reverse();
      if(!list.length) return tg('sendMessage',{chat_id:q.message.chat.id,text:'Заявок на пополнение нет.'});
      for(const dep of list){
        await tg('sendMessage',{chat_id:q.message.chat.id,
          text:`💳 <b>${dep.id}</b>\nSteam: <code>${dep.steamid}</code>\nСумма: ${Number(dep.amount).toFixed(2)} ₽\nПромо: ${dep.promo||'—'}\nК начислению: ${(Number(dep.amount)+Number(dep.bonus||0)).toFixed(2)} ₽`,
          parse_mode:'HTML',
          reply_markup:{inline_keyboard:[[
            {text:'✅ Зачислить',callback_data:`dep:${dep.id}:approve`},
            {text:'❌ Отклонить',callback_data:`dep:${dep.id}:reject`}
          ]]}
        });
      }
      return;
    }
    if(d==='adm:stats'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const users=Object.values(data.users);
      const totalBal=users.reduce((s,u)=>s+(Number(u.balance)||0),0);
      const totalDep=users.reduce((s,u)=>s+(Number(u.stats?.totalDeposited)||0),0);
      const totalCases=users.reduce((s,u)=>s+(Number(u.stats?.casesOpened)||0),0);
      const totalUpg=users.reduce((s,u)=>s+(Number(u.stats?.upgradesTotal)||0),0);
      const pendingWd=data.withdrawals.filter(x=>x.status==='pending').length;
      const pendingDep=data.deposits.filter(x=>x.status==='pending').length;
      return tg('sendMessage',{chat_id:q.message.chat.id,
        text:`📊 <b>Статистика</b>\n\nПользователей: <b>${users.length}</b>\nСуммарный баланс: <b>${totalBal.toFixed(2)} ₽</b>\nДепозитов всего: <b>${totalDep.toFixed(2)} ₽</b>\nКейсов открыто: <b>${totalCases}</b>\nАпгрейдов: <b>${totalUpg}</b>\n\nОжидают вывода: <b>${pendingWd}</b>\nОжидают пополнения: <b>${pendingDep}</b>`,
        parse_mode:'HTML',
        reply_markup:{inline_keyboard:[[{text:'◀ Меню',callback_data:'adm:menu'}]]}
      });
    }
    if(d==='adm:promo'){
      await tg('answerCallbackQuery',{callback_query_id:q.id});
      const active=promoList().slice(0,5);
      const list=active.length?active.map(p=>`<code>${p.code}</code> +${p.percent}% (исп: ${Number(p.uses||0)})`).join('\n'):'—';
      return tg('sendMessage',{chat_id:q.message.chat.id,
        text:`🎟 <b>Промокоды</b>\n\n${list}\n\nСоздать: <code>/promo CODE PERCENT</code>`,
        parse_mode:'HTML',
        reply_markup:{inline_keyboard:[[{text:'◀ Меню',callback_data:'adm:menu'}]]}
      });
    }
    return;
  }

  const m=u.message;
  if(!m || !m.chat) return;
  const chatId=String(m.chat.id);
  const rawText=String(m.text||'').trim();
  const text=rawText.replace(/^\/(\w+)(?:@[^\s]+)?/, '/$1');
  const admin=isTgAdmin(chatId);

  if(/^\/start(?:\s|$)/i.test(text)){
    if(admin) return sendAdminMenu(chatId);
    return tg('sendMessage',{chat_id:chatId,
      text:'<b>Zenodrop</b>\n\nВаш Telegram ID: <code>'+chatId+'</code>\n\n/link STEAMID — привязать Steam\n/status — баланс и привязка\n/help — команды',
      parse_mode:'HTML'
    });
  }
  if(text==='/help'){
    return tg('sendMessage',{chat_id:chatId,
      text:'<b>Zenodrop</b>\n\n/link STEAMID\n/status\n/help'+(admin?'\n\n<b>Админ:</b>\n/panel — панель\n/deposits — заявки на пополнение\n/withdrawals — заявки на вывод\n/stats — статистика\n/give STEAMID SUM\n/withdrawlock STEAMID on|off\n/adminsteam STEAMID\n/promo CODE PERCENT':''),
      parse_mode:'HTML'
    });
  }
  if(text==='/status'){
    const steam=data.links[chatId];
    const u2=steam?ensureUser(steam):null;
    return tg('sendMessage',{chat_id:chatId,
      text:steam?`Steam ID: <code>${steam}</code>\nБаланс: <b>${Number(u2?.balance||0).toFixed(2)} ₽</b>`:'Steam ID ещё не привязан. Напишите /link ВАШ_STEAMID',
      parse_mode:'HTML'
    });
  }
  if(text.startsWith('/link ')){
    const steam=text.split(/\s+/)[1];
    if(!/^\d{17}$/.test(steam)) return tg('sendMessage',{chat_id:chatId,text:'Формат: /link 7656119XXXXXXXXXX'});
    data.links[chatId]=steam;
    const u2=ensureUser(steam);u2.tgId=chatId;saveStore();
    return tg('sendMessage',{chat_id:chatId,text:`✅ Привязан Steam ID <code>${steam}</code>`,parse_mode:'HTML'});
  }
  if(!admin)return;

  if(text==='/panel') return sendAdminMenu(chatId);
  if(text==='/withdrawals'){
    const list=data.withdrawals.filter(x=>x.status==='pending').slice(-10).reverse();
    if(!list.length)return tg('sendMessage',{chat_id:chatId,text:'Заявок на вывод нет.'});
    for(const w of list){
      await tg('sendMessage',{chat_id:chatId,
        text:`🟠 <b>${w.id}</b>\nSteam: <code>${w.steamid}</code>\nСумма: ${Number(w.value).toFixed(2)} ₽\nПредмет: ${w.item.name}`,
        parse_mode:'HTML',
        reply_markup:{inline_keyboard:[[
          {text:'🎁 Выдать',callback_data:`wd:${w.id}:send`},
          {text:'❌ Отклонить',callback_data:`wd:${w.id}:reject`}
        ]]}
      });
    }
    return;
  }
  if(text==='/deposits'){
    const list=data.deposits.filter(x=>x.status==='pending').slice(-10).reverse();
    if(!list.length)return tg('sendMessage',{chat_id:chatId,text:'Заявок на пополнение нет.'});
    for(const dep of list){
      await tg('sendMessage',{chat_id:chatId,
        text:`💳 <b>${dep.id}</b>\nSteam: <code>${dep.steamid}</code>\nСумма: ${Number(dep.amount).toFixed(2)} ₽\nПромо: ${dep.promo||'—'}\nК начислению: ${(Number(dep.amount)+Number(dep.bonus||0)).toFixed(2)} ₽`,
        parse_mode:'HTML',
        reply_markup:{inline_keyboard:[[
          {text:'✅ Зачислить',callback_data:`dep:${dep.id}:approve`},
          {text:'❌ Отклонить',callback_data:`dep:${dep.id}:reject`}
        ]]}
      });
    }
    return;
  }
  if(text==='/stats'){
    const users=Object.values(data.users);
    const totalBal=users.reduce((s,u)=>s+(Number(u.balance)||0),0);
    const totalDep=users.reduce((s,u)=>s+(Number(u.stats?.totalDeposited)||0),0);
    const totalCases=users.reduce((s,u)=>s+(Number(u.stats?.casesOpened)||0),0);
    const totalUpg=users.reduce((s,u)=>s+(Number(u.stats?.upgradesTotal)||0),0);
    return tg('sendMessage',{chat_id:chatId,
      text:`📊 <b>Статистика</b>\n\nПользователей: <b>${users.length}</b>\nБаланс всех: <b>${totalBal.toFixed(2)} ₽</b>\nДепозитов всего: <b>${totalDep.toFixed(2)} ₽</b>\nКейсов открыто: <b>${totalCases}</b>\nАпгрейдов: <b>${totalUpg}</b>`,
      parse_mode:'HTML'
    });
  }
  let a=text.match(/^\/give\s+(\d{17})\s+([\d.]+)/i);
  if(a){
    const u2=ensureUser(a[1]);
    u2.balance+=Number(a[2]);
    saveStore();
    return tg('sendMessage',{chat_id:chatId,text:`✅ Начислено ${Number(a[2]).toFixed(2)} ₽\nSteam: <code>${a[1]}</code>\nБаланс: <b>${Number(u2.balance).toFixed(2)} ₽</b>`,parse_mode:'HTML'});
  }
  a=text.match(/^\/withdrawlock\s+(\d{17})\s+(on|off)/i);
  if(a){
    const u2=ensureUser(a[1]);
    u2.withdrawDisabled=a[2].toLowerCase()==='on';
    saveStore();
    return tg('sendMessage',{chat_id:chatId,text:`✅ Вывод для <code>${a[1]}</code>: ${u2.withdrawDisabled?'запрещён':'разрешён'}`,parse_mode:'HTML'});
  }
  a=text.match(/^\/adminsteam\s+(\d{17})/i);
  if(a){data.admins['steam:'+a[1]]=true;saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Steam ID ${a[1]} получил web-admin.`});}
  a=text.match(/^\/admin\s+(\d+)/i);
  if(a){data.admins[a[1]]=true;saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Telegram ID ${a[1]} получил админку.`});}
  a=text.match(/^\/promo\s+([A-Za-z0-9_-]+)\s+(\d+(?:\.\d+)?)\s*(?:([\d.]+))?/i);
  if(a){
    const p=makePromo(a[1],a[2],a[3]||0);
    return tg('sendMessage',{chat_id:chatId,text:`✅ Промокод <code>${p.code}</code> создан: +${p.percent}%`,parse_mode:'HTML'});
  }
  return tg('sendMessage',{chat_id:chatId,text:'Неизвестная команда. /panel — админ-панель, /help — список.'});
}

// ============================================================
//  ПЛАТЁЖНЫЙ БОТ
// ============================================================
function infoText(){
  return `<b>Zenodrop — информация</b>\n\n<b>Политика конфиденциальности:</b> <a href="/privacy">открыть</a>\n<b>Пользовательское соглашение:</b> <a href="/terms">открыть</a>\n\n<b>Поддержка:</b> ${SUPPORT_CONTACT}`;
}

async function processPaymentTelegramUpdate(u){
  if(u.callback_query){
    const q=u.callback_query, chatId=String(q.from?.id||q.message?.chat?.id||'');
    const d=String(q.data||'');
    if(d==='pay:menu'){ await tgPay('answerCallbackQuery',{callback_query_id:q.id}); return sendPaymentMenu(chatId); }
    if(d==='pay:profile'){
      const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
      await tgPay('answerCallbackQuery',{callback_query_id:q.id});
      if(!user) return tgPay('sendMessage',{chat_id:chatId,text:'Аккаунт не привязан.'});
      return tgPay('sendMessage',{chat_id:chatId,text:`<b>Профиль Zenodrop</b>\n\nID: <code>${ensureZenodropId(user)}</code>\nSteam ID: <code>${user.steamid}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>`,parse_mode:'HTML'});
    }
    if(d==='pay:topup'){ await tgPay('answerCallbackQuery',{callback_query_id:q.id}); return sendPaymentMenu(chatId); }
    return tgPay('answerCallbackQuery',{callback_query_id:q.id});
  }
  const m=u.message;
  if(!m || !m.chat) return;
  const chatId=String(m.chat.id);
  const raw=String(m.text||'').trim();
  const command=raw.replace(/^\/(\w+)(?:@[^\s]+)?/,'/$1').toLowerCase();
  const payload=raw.split(/\s+/).slice(1).join(' ').trim();

  if(command==='/start'){
    const matchId=payload.match(/ZN[\-\s]?(\d{8,10})/i);
    const zenoFull=matchId?('ZN-'+matchId[1]):null;
    if(zenoFull){
      const user=findUserByZenodropId(zenoFull);
      if(user){
        user.tgId=chatId;
        data.links[chatId]=user.steamid;
        saveStore();
        return tgPay('sendMessage',{chat_id:chatId,text:`<b>Zenodrop — Пополнение</b>\n\nID: <code>${ensureZenodropId(user)}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'💰 Пополнить',callback_data:'pay:topup'},{text:'👤 Профиль',callback_data:'pay:profile'}]]}});
      }
    }
    return sendPaymentMenu(chatId);
  }
  if(command==='/info') return tgPay('sendMessage',{chat_id:chatId,text:infoText(),parse_mode:'HTML',disable_web_page_preview:true});
  if(command==='/deposit' || command==='/pay') return sendPaymentMenu(chatId);
  if(command==='/id'){
    const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
    return tgPay('sendMessage',{chat_id:chatId,text:user?`Ваш Zenodrop ID: <code>${ensureZenodropId(user)}</code>`:'Аккаунт ещё не привязан.',parse_mode:'HTML'});
  }
  if(command==='/balance'){
    const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
    return tgPay('sendMessage',{chat_id:chatId,text:user?`Баланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>`:'Аккаунт ещё не привязан.',parse_mode:'HTML'});
  }
  return sendPaymentMenu(chatId);
}

async function sendPaymentMenu(chatId){
  const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
  const id=user?ensureZenodropId(user):null;
  return tgPay('sendMessage',{
    chat_id:chatId,
    text:`<b>Zenodrop — Пополнение</b>\n\n${id?`Ваш ID: <code>${id}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>\n\n`:'Откройте пополнение через Telegram с сайта.\n\n'}Выберите действие:`,
    parse_mode:'HTML',
    reply_markup:{inline_keyboard:[[{text:'💰 Пополнить',callback_data:'pay:topup'},{text:'👤 Профиль',callback_data:'pay:profile'}]]}
  });
}

async function paymentTelegramStart(){
  if(!PAY_TG_TOKEN){ console.error('Payment Telegram bot disabled: no token'); return; }
  try{
    const me=await tgPay('getMe',{});
    if(!me?.ok){ console.error('Payment Telegram: invalid token'); return; }
    await tgPay('setMyCommands',{commands:[
      {command:'start',description:'Открыть меню'},
      {command:'deposit',description:'Пополнить'},
      {command:'id',description:'Zenodrop ID'},
      {command:'balance',description:'Баланс'}
    ]});
    if(PAY_TG_WEBHOOK_URL){
      const secret=crypto.createHash('sha256').update(PAY_TG_TOKEN).digest('hex').slice(0,32);
      const r=await tgPay('setWebhook',{url:PAY_TG_WEBHOOK_URL,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
      if(r?.ok) console.log('Payment webhook enabled:',PAY_TG_WEBHOOK_URL);
      else console.error('Payment setWebhook failed:',r?.description);
    }
  }catch(e){ console.error('Payment Telegram init:',e.message); }
}

async function telegramStart(){
  if(!TG_TOKEN){ console.error('Telegram bot disabled: no token'); return; }
  try{
    const me=await tg('getMe',{});
    if(!me?.ok){ console.error('Telegram: invalid token'); return; }
    await tg('setMyCommands',{commands:[
      {command:'start',description:'Открыть меню'},
      {command:'panel',description:'Админ-панель'},
      {command:'deposits',description:'Заявки на пополнение'},
      {command:'withdrawals',description:'Заявки на вывод'},
      {command:'stats',description:'Статистика'},
      {command:'status',description:'Мой баланс'},
      {command:'link',description:'Привязать Steam ID'},
      {command:'help',description:'Список команд'}
    ]});
    if(TG_WEBHOOK_URL){
      const secret=crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0,32);
      const r=await tg('setWebhook',{url:TG_WEBHOOK_URL,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
      if(r?.ok) console.log('Telegram webhook enabled:',TG_WEBHOOK_URL);
      else console.error('Telegram setWebhook failed:',r?.description);
    }else{
      await tg('deleteWebhook',{drop_pending_updates:false});
      startTelegramPollingFallback();
    }
  }catch(e){ console.error('Telegram init:',e.message); }
}

let tgPollingFallback=false;
async function startTelegramPollingFallback(){
  if(tgPollingFallback)return;
  tgPollingFallback=true;
  let offset=0;
  while(tgPollingFallback){
    try{
      const r=await tg('getUpdates',{offset,timeout:30,allowed_updates:['message','callback_query']});
      if(!r?.ok){ await new Promise(res=>setTimeout(res,3000)); continue; }
      for(const u of (r.result||[])){
        offset=Math.max(offset,u.update_id+1);
        try{ await processTelegramUpdate(u); }catch(e){ console.error('TG update:',e.message); }
      }
    }catch(e){ await new Promise(res=>setTimeout(res,3000)); }
  }
}

// ===============================
// CS2.SH + КЭШ
// ===============================
let cs2CatalogCache = { data: null, expires: 0 };
const CS2_CACHE_MS = 10 * 60 * 1000;

function loadCatalogFromDisk(){
  try{
    const x=JSON.parse(fs.readFileSync(CATALOG_FILE,'utf8'));
    if(Array.isArray(x?.items) && x.items.length){
      cs2CatalogCache.data=x.items;
      cs2CatalogCache.expires=Date.now()+CS2_CACHE_MS;
      console.log('CS2 catalog loaded from disk:',x.items.length);
      return true;
    }
  }catch(e){}
  return false;
}
function saveCatalogToDisk(items){
  try{ fs.writeFileSync(CATALOG_FILE, JSON.stringify({items, savedAt:Date.now()})); }
  catch(e){ console.error('catalog cache save:',e.message); }
}
async function refreshCatalogInBackground(){
  try{
    const items=await buildCs2Catalog();
    if(items?.length){
      cs2CatalogCache={data:items, expires:Date.now()+CS2_CACHE_MS};
      saveCatalogToDisk(items);
      console.log('CS2 catalog refreshed:',items.length);
    }
  }catch(e){ console.error('catalog bg refresh:',e.message); }
}

async function cs2Fetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, 30000);
    try {
        const r = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                'Authorization': 'Bearer ' + KEY,
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                ...(options.headers || {})
            }
        });
        const text = await r.text();
        let d = null;
        try { d = JSON.parse(text); } catch (_) {}
        if (!r.ok) {
            const err = new Error(d?.message || d?.error || ('HTTP ' + r.status));
            err.status = r.status;
            err.body = d || text.slice(0, 1000);
            throw err;
        }
        return d;
    } finally { clearTimeout(timer); }
}

async function buildCs2Catalog() {
    const schema = await cs2Fetch('https://api.cs2.sh/v1/schema');
    const raw = schema?.items || schema || {};
    const arr = Array.isArray(raw) ? raw : Object.values(raw);

    const candidates = [];
    const seen = new Set();
    for (const x of arr) {
        const name = String(x?.market_hash_name || x?.name || '').trim();
        const image = x?.image || x?.icon_url || x?.image_url || '';
        if (!name || !image || !name.includes('|')) continue;
        const low = name.toLowerCase();
        if (low.includes('sticker') || low.includes('patch') || low.includes('graffiti') || low.includes('music kit')) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        candidates.push({name, image});
    }

    const priorityWords = [
        'ak-47 |','m4a1-s |','m4a4 |','awp |','usp-s |','glock-18 |','p250 |',
        'deagle |','desert eagle |','famas |','galil ar |','mp9 |','mac-10 |',
        'mp7 |','mp5-sd |','ump-45 |','p90 |','ssg 08 |','scar-20 |','aug |',
        'sg 553 |','nova |','xm1014 |','mag-7 |','sawed-off |','tec-9 |',
        'five-seven |','cz75-auto |','dual berettas |','r8 revolver |','negev |','m249 |'
    ];
    const isWeapon = x => {
        const c=String(x?.category||'').toLowerCase();
        const n=String(x?.name||'').toLowerCase();
        return c==='skin' || n.includes(' | ');
    };
    const rarityTier = x => Number(x?.rarity?.tier || 0);
    const isKnife = x => /^★\s/.test(x.name) || String(x?.category||'').toLowerCase().includes('knife');
    const isGlove = x => String(x?.category||'').toLowerCase().includes('glove') || x.name.toLowerCase().includes('gloves');

    const high = candidates.filter(x => isWeapon(x) && rarityTier(x) >= 5);
    const knives = candidates.filter(x => isKnife(x) || isGlove(x));
    const priority = candidates.filter(x => priorityWords.some(w => x.name.toLowerCase().startsWith(w)));
    const cheapPool = candidates.filter(x => rarityTier(x) <= 4);

    const selected = [];
    const selectedSet = new Set();
    const add = x => {
        if(selected.length >= 7000 || !x || selectedSet.has(x.name)) return;
        selectedSet.add(x.name); selected.push(x);
    };

    for (const x of high) add(x);
    for (const x of knives) add(x);
    for (const x of priority) add(x);

    const rest = cheapPool.filter(x => !selectedSet.has(x.name));
    const need = 7000 - selected.length;
    if (need > 0 && rest.length) {
        for (let i=0; i<Math.min(need, rest.length); i++) {
            const idx=Math.floor(i * rest.length / Math.min(need, rest.length));
            add(rest[idx]);
        }
    }
    const remaining = candidates.filter(x => !selectedSet.has(x.name));
    const left = 7000 - selected.length;
    if (left > 0 && remaining.length) {
        for (let i=0; i<Math.min(left, remaining.length); i++) {
            const idx=Math.floor(i * remaining.length / Math.min(left, remaining.length));
            add(remaining[idx]);
        }
    }

    const batches = [];
    for (let i = 0; i < selected.length; i += 100) batches.push(selected.slice(i, i + 100).map(x => x.name));

    const priceMap = new Map();
    let cursor = 0;
    const workers = Math.min(8, batches.length);
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= batches.length) return;
            try {
                const d = await cs2Fetch('https://api.cs2.sh/v1/prices/latest', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({items: batches[i]})
                });
                for (const [name, item] of Object.entries(d?.items || {})) priceMap.set(name, item);
            } catch (e) { console.warn('CS2 batch failed:', e.message || e); }
        }
    }
    await Promise.all(Array.from({length: workers}, worker));

    const result = [];
    const sources = ['steam','csfloat','buff','youpin','skinport','c5game'];
    for (const x of selected) {
        const p = priceMap.get(x.name);
        if (!p) continue;
        let usd = 0;
        for (const source of sources) {
            const ask = Number(p?.[source]?.ask);
            if (Number.isFinite(ask) && ask > 0) { usd = ask; break; }
        }
        if (usd <= 0) continue;
        if (usd * 80 < 8) continue;
        result.push({
            id: 'skin_' + crypto.createHash('sha1').update(x.name).digest('hex').slice(0, 12),
            name: x.name,
            img: x.image,
            usd,
            api: p
        });
    }

    result.sort((a,b) => a.usd - b.usd);
    return result.slice(0, 7000);
}

// ===============================
// COOKIES / READ JSON
// ===============================
function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (!rc) return list;
    rc.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        const key = parts.shift().trim();
        list[key] = decodeURI(parts.join('='));
    });
    return list;
}
async function readJson(req){
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>{b+=c;if(b.length>2e6)req.destroy();});
    req.on('end',()=>{try{resolve(JSON.parse(b||'{}'));}catch(e){reject(e);}});
    req.on('error',reject);
  });
}

// ===============================
// SERVER
// ===============================
const server = http.createServer(async (req, res) => {

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;
    const cookies = parseCookies(req);

    let sessionUser = null;
    if (cookies.session_id && sessions.has(cookies.session_id)) {
        sessionUser = sessions.get(cookies.session_id);
    } else {
        const signedSteam=steamFromSessionCookie(cookies.session_id);
        if(signedSteam){
            const stored=ensureUser(signedSteam);
            if(stored){
                sessionUser={steamid:signedSteam,username:stored.username||'',avatar:stored.avatar||''};
                ensureZenodropId(stored);
            }
        }
    }

    if (pathname === '/auth/steam') {
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const realm = `${proto}://${req.headers.host}`;
        const returnTo = `${realm}/auth/steam/return`;
        const params = new URLSearchParams({
            'openid.ns': 'http://specs.openid.net/auth/2.0',
            'openid.mode': 'checkid_setup',
            'openid.return_to': returnTo,
            'openid.realm': realm,
            'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
            'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select'
        });
        res.writeHead(302, {Location: `https://steamcommunity.com/openid/login?${params.toString()}`});
        return res.end();
    }

    if (pathname === '/auth/steam/return') {
        try {
            const params = new URLSearchParams();
            params.append('openid.ns', 'http://specs.openid.net/auth/2.0');
            params.append('openid.mode', 'check_authentication');
            urlObj.searchParams.forEach((value, key) => {
                if (key !== 'openid.mode') params.append(key, value);
            });
            const verification = await fetch('https://steamcommunity.com/openid/login', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: params.toString()
            });
            const verificationText = await verification.text();
            if (verificationText.includes('is_valid:true')) {
                const claimedId = urlObj.searchParams.get('openid.claimed_id');
                const match = claimedId ? claimedId.match(/\/id\/([0-9]{17})/) : null;
                const steamId = match ? match[1] : null;
                if (steamId) {
                    const playerRes = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`);
                    const playerData = await playerRes.json();
                    const player = playerData.response?.players?.[0] || {};
                    const userData = {
                        steamid: steamId,
                        username: player.personaname || '',
                        avatar: player.avatarfull || player.avatarmedium || player.avatar || ''
                    };
                    const sessionId = makeSessionCookie(steamId);
                    sessions.set(sessionId,userData);
                    const stored=ensureUser(steamId);
                    ensureZenodropId(stored);
                    stored.username=userData.username;
                    stored.avatar=userData.avatar;
                    saveStore();
                    res.writeHead(302, {
                        Location: '/',
                        'Set-Cookie': `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
                    });
                    return res.end();
                }
            }
        } catch (e) { console.error('Steam Auth Error:', e); }
        res.writeHead(302, {Location: '/'});
        return res.end();
    }

    if (pathname === '/api/current-user' && req.method === 'GET') {
        res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
        if(sessionUser){
            const stored=ensureUser(sessionUser.steamid);
            ensureZenodropId(stored);
            const luck = getPlayerLuck(sessionUser.steamid);
            const serverAccount={
                ...stored,
                pendingWithdrawals:pendingWithdrawalsForUser(sessionUser.steamid)
            };
            return res.end(JSON.stringify({...sessionUser,serverAccount,webAdmin:isWebAdmin(sessionUser.steamid),luck}));
        }
        return res.end(JSON.stringify(null));
    }

    if (pathname === '/auth/logout') {
        if (cookies.session_id) sessions.delete(cookies.session_id);
        res.writeHead(302, {
            Location: '/',
            'Set-Cookie': 'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        });
        return res.end();
    }

    if (req.url === '/') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        return res.end(html);
    }

    if(pathname==='/api/upgrade-roll' && req.method==='POST'){
        if(!sessionUser?.steamid){
            res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'auth_required'}));
        }
        try{
            const body=await readJson(req);
            const chance=Number(body.chance);
            if(!Number.isFinite(chance) || chance<0 || chance>100){
                res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
                return res.end(JSON.stringify({error:'invalid_chance'}));
            }
            const success=upgrade(chance, sessionUser.steamid, Number(body.targetPrice)||0);
            const user=ensureUser(sessionUser.steamid);
            user.stats.upgradesTotal=(user.stats.upgradesTotal||0)+1;
            saveStore();
            res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({ok:true,success,chance}));
        }catch(e){
            res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'invalid_json'}));
        }
    }

    if(pathname==='/api/case/open' && req.method==='POST'){
        if(!sessionUser?.steamid){
            res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'auth_required'}));
        }
        try{
            const body=await readJson(req);
            const caseKey=String(body.case||'');
            const skins=Array.isArray(body.skins)?body.skins:[];
            const cfg=CASES[caseKey];
            if(!cfg){
                res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
                return res.end(JSON.stringify({error:'invalid_case'}));
            }
            if(!skins.length){
                res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
                return res.end(JSON.stringify({error:'empty_pool'}));
            }
            const user=ensureUser(sessionUser.steamid);
            ensureZenodropId(user);
            if(Number(user.balance||0) < cfg.price){
                res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
                return res.end(JSON.stringify({error:'insufficient_balance',balance:Number(user.balance||0),price:cfg.price}));
            }
            const pityState = user.pity.byCase[caseKey] || 0;
            const result = openCase(caseKey, skins, pityState);
            if(!result || !result.skin){
                res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});
                return res.end(JSON.stringify({error:'roll_failed'}));
            }
            user.balance = Number(user.balance||0) - cfg.price;
            user.stats.casesOpened = (user.stats.casesOpened||0) + 1;
            const goodTiers = new Set(['flat','plus','mega','jackpot']);
            if(goodTiers.has(result.tier)){
                user.pity.byCase[caseKey] = 0;
            } else {
                user.pity.byCase[caseKey] = (user.pity.byCase[caseKey]||0) + 1;
            }
            saveStore();
            res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({
                ok:true,
                case:caseKey,
                price:cfg.price,
                skin:result.skin,
                tier:result.tier,
                balance:user.balance
            }));
        }catch(e){
            res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'invalid_json'}));
        }
    }

    if(pathname==='/api/account/sync' && req.method==='POST'){
        if(!sessionUser?.steamid){
            res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'auth_required'}));
        }
        try{
            const body=await readJson(req);
            const u=ensureUser(sessionUser.steamid);
            ensureZenodropId(u);
            if(Number.isFinite(Number(body.balance))) u.balance=Math.max(0,Number(body.balance));
            if(body.stats && typeof body.stats==='object'){
                if(typeof body.stats.upgradesTotal==='number')
                    u.stats.upgradesTotal=Math.max(u.stats.upgradesTotal||0, body.stats.upgradesTotal);
                if(typeof body.stats.casesOpened==='number')
                    u.stats.casesOpened=Math.max(u.stats.casesOpened||0, body.stats.casesOpened);
            }
            if(Array.isArray(body.inventory)){
                u.inventory=body.inventory.slice(0,5000).map(x=>({
                    id:String(x?.id||''),
                    name:String(x?.name||''),
                    category:'skins',
                    value:Number(x?.value)||0,
                    img:String(x?.img||''),
                    uid:String(x?.uid||'')
                })).filter(x=>x.name && x.uid);
            }
            if(body.bestDrop && typeof body.bestDrop==='object'){
                u.bestDrop={
                    name:String(body.bestDrop.name||'--'),
                    value:Number(body.bestDrop.value)||0,
                    img:String(body.bestDrop.img||'')
                };
            }
            saveStore();
            const responseUser={
                ...u,
                pendingWithdrawals:pendingWithdrawalsForUser(sessionUser.steamid)
            };
            res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({ok:true,user:responseUser}));
        }catch(e){
            res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'invalid_json'}));
        }
    }

    if(pathname==='/api/config' && req.method==='GET'){
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        return res.end(JSON.stringify({
            telegramBotUrl:TG_BOT_URL||null,
            paymentTelegramBotUrl:PAY_TG_BOT_URL||'https://t.me/ZenodropPayBot',
            cases:CASES,
            storage: USE_REDIS ? 'redis' : 'disk'
        }));
    }

    if(pathname==='/api/promos' && req.method==='GET'){
        const list=promoList().slice(0,8).map(x=>({
            code:x.code,
            percent:x.percent,
            maxBonus:x.maxBonus,
            expiresAt:x.expiresAt||0,
            auto:!!x.auto,
            uses:Number(x.uses||0),
            maxUses:Number(x.maxUses||0)
        }));
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        return res.end(JSON.stringify({items:list}));
    }

    if(pathname==='/api/deposit' && req.method==='POST'){
        if(!sessionUser?.steamid){
            res.writeHead(401);return res.end(JSON.stringify({error:'auth_required'}));
        }
        const body=await readJson(req);
        const amount=Number(body.amount)||0;
        const method=String(body.method||'');
        const promo=String(body.promo||'').toUpperCase();
        if(amount<50){res.writeHead(400);return res.end(JSON.stringify({error:'min_50'}));}
        const pc=promo?data.promos[promo]:null;
        if(promo && (!pc || pc.active===false || (pc.expiresAt && pc.expiresAt<=Date.now()))){
            res.writeHead(400);return res.end(JSON.stringify({error:'promo_invalid'}));
        }
        const bonus=pc?Math.min(amount*(Number(pc.percent)||0)/100,Number(pc.maxBonus)||Infinity):0;
        const id='dep_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');
        data.deposits.push({
            id,steamid:sessionUser.steamid,
            tgId:ensureUser(sessionUser.steamid)?.tgId||null,
            amount,bonus,method,promo,status:'pending',createdAt:Date.now()
        });
        saveStore();
        await notifyAdmins(
          `💳 <b>Новое пополнение</b>\nID: <code>${id}</code>\nSteam: <code>${sessionUser.steamid}</code>\nСумма: ${amount.toFixed(2)} ₽\nМетод: ${method}\nПромо: ${promo||'—'}\nК начислению: ${(amount+bonus).toFixed(2)} ₽`,
          [[
            {text:'✅ Зачислить',callback_data:`dep:${id}:approve`},
            {text:'❌ Отклонить',callback_data:`dep:${id}:reject`}
          ]]
        );
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,id,bonus,total:amount+bonus}));
    }

    if(pathname==='/api/withdrawals' && req.method==='POST'){
        if(!sessionUser?.steamid){
            res.writeHead(401);return res.end(JSON.stringify({error:'auth_required'}));
        }
        const body=await readJson(req);
        const index=Number(body.index);
        const stored=ensureUser(sessionUser.steamid);
        if(stored.withdrawDisabled){
            res.writeHead(403);return res.end(JSON.stringify({error:'withdraw_disabled'}));
        }
        const item=body.item;
        if(!item || !item.name || !Number(item.value)){
            res.writeHead(400);return res.end(JSON.stringify({error:'item_required'}));
        }
        const itemUid=String(item.uid||'');
        if(!itemUid){
            res.writeHead(400);return res.end(JSON.stringify({error:'item_uid_required'}));
        }
        const alreadyPending=data.withdrawals.some(x=>x.steamid===sessionUser.steamid && x.item?.uid===itemUid && (x.status==='pending'||x.status==='approved'));
        if(alreadyPending){
            res.writeHead(409);return res.end(JSON.stringify({error:'item_withdraw_pending'}));
        }
        const id='wd_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');
        const w={
            id,steamid:sessionUser.steamid,tgId:stored.tgId||null,index,
            item:{name:item.name,value:Number(item.value),img:item.img||'',assetid:item.assetid||null,uid:itemUid},
            value:Number(item.value),refund:Number(item.value),status:'pending',createdAt:Date.now()
        };
        data.withdrawals.push(w);saveStore();
        await notifyAdmins(
            `🟠 <b>Новая заявка на вывод</b>\nID: <code>${id}</code>\nSteam: <code>${sessionUser.steamid}</code>\nСумма: ${w.value.toFixed(2)} ₽\nСкин: ${item.name}`,
            [[{text:'🎁 Выдать',callback_data:`wd:${id}:send`},{text:'❌ Отклонить',callback_data:`wd:${id}:reject`}]]
        );
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,id,status:'pending'}));
    }

    if(pathname==='/api/admin/state' && req.method==='GET'){
        if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){
            res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));
        }
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({
            users:Object.values(data.users),
            withdrawals:data.withdrawals.slice(-100).reverse(),
            deposits:data.deposits.slice(-100).reverse(),
            promos:promoList(),
            cases:CASES,
            tiers:TIERS,
            storage: USE_REDIS ? 'redis' : 'disk'
        }));
    }

    if(pathname==='/api/admin/promo' && req.method==='POST'){
        if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){
            res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));
        }
        const body=await readJson(req);
        const code=String(body.code||'').trim().toUpperCase();
        const percent=Number(body.percent);
        const maxBonus=Number(body.maxBonus)||0;
        const expiresMinutes=Number(body.expiresMinutes)||0;
        if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!Number.isFinite(percent)||percent<1||percent>100){
            res.writeHead(400);return res.end(JSON.stringify({error:'invalid_promo'}));
        }
        const p=makePromo(code,percent,maxBonus,{auto:false,expiresAt:expiresMinutes>0?Date.now()+expiresMinutes*60000:0});
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,promo:p}));
    }

    if(pathname==='/api/admin/user' && req.method==='POST'){
        if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){
            res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));
        }
        const body=await readJson(req);
        const u=ensureUser(body.steamid);
        if(!u){res.writeHead(400);return res.end(JSON.stringify({error:'steamid_required'}));}
        if(body.balanceDelta!==undefined)u.balance+=Number(body.balanceDelta)||0;
        if(body.balance!==undefined)u.balance=Number(body.balance)||0;
        if(body.withdrawDisabled!==undefined)u.withdrawDisabled=!!body.withdrawDisabled;
        saveStore();
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,user:u}));
    }

    if(pathname==='/api/admin/deposit-confirm' && req.method==='POST'){
        if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){
            res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));
        }
        const body=await readJson(req);
        const d=data.deposits.find(x=>x.id===body.id);
        if(!d){res.writeHead(404);return res.end(JSON.stringify({error:'not_found'}));}
        if(d.status!=='pending'){return res.end(JSON.stringify({ok:true,status:d.status}));}
        const u=ensureUser(d.steamid);
        u.balance+=d.amount+d.bonus;
        u.stats.totalDeposited=(u.stats.totalDeposited||0)+d.amount+d.bonus;
        if(d.promo&&data.promos[d.promo])data.promos[d.promo].uses=(data.promos[d.promo].uses||0)+1;
        d.status='paid';d.updatedAt=Date.now();saveStore();
        if(d.tgId)await tg('sendMessage',{chat_id:d.tgId,text:`✅ Пополнение <b>${d.id}</b> подтверждено: +${(d.amount+d.bonus).toFixed(2)} ₽`,parse_mode:'HTML'});
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true,user:u}));
    }

    if (pathname === '/api/usd-rub' && req.method === 'GET') {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3000);
            const r = await fetch('https://kurs-rublya.ru/api/v1/rates/USD/', {
                signal: controller.signal, headers: {Accept: 'application/json'}
            });
            clearTimeout(timer);
            const text = await r.text();
            if (!r.ok) { res.writeHead(r.status, {'Content-Type':'application/json'}); return res.end(text); }
            const d = JSON.parse(text);
            const rate = Number(d.ratePerUnit || d.value || d.data?.ratePerUnit || d.data?.rate);
            if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid USD rate');
            res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({rate, source:'kurs-rublya.ru', updatedAt:new Date().toISOString()}));
        } catch (e) {
            res.writeHead(502, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({error:String(e)}));
        }
    }

    if (pathname === '/api/cs2/catalog' && req.method === 'GET') {
        if (cs2CatalogCache.data && cs2CatalogCache.data.length) {
            res.writeHead(200, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300'});
            return res.end(JSON.stringify({currency:'USD', items:cs2CatalogCache.data, cached:true}));
        }
        refreshCatalogInBackground();
        res.writeHead(202, {'Content-Type':'application/json','Cache-Control':'no-store'});
        return res.end(JSON.stringify({currency:'USD', items:[], warming:true}));
    }

    if (pathname === '/api/cs2/schema' && req.method === 'GET') {
        try {
            const r = await fetch('https://api.cs2.sh/v1/schema', {
                method: 'GET', headers: {'Authorization':'Bearer ' + KEY, 'Accept-Encoding':'gzip'}
            });
            const text = await r.text();
            res.writeHead(r.status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
            return res.end(text);
        } catch (e) {
            res.writeHead(502, {'Content-Type':'application/json; charset=utf-8'});
            return res.end(JSON.stringify({error:'cs2_schema_proxy_error', message:String(e)}));
        }
    }

    if (pathname === '/api/prices' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const input = JSON.parse(body || '{}');
                const items = Array.isArray(input.items) ? input.items.filter(x => typeof x === 'string' && x.trim()).slice(0, 100) : [];
                if (!items.length) {
                    res.writeHead(400, {'Content-Type':'application/json'});
                    return res.end(JSON.stringify({error:'items_required'}));
                }
                const r = await fetch('https://api.cs2.sh/v1/prices/latest', {
                    method: 'POST',
                    headers: {'Authorization':'Bearer ' + KEY, 'Content-Type':'application/json', 'Accept-Encoding':'gzip'},
                    body: JSON.stringify({items})
                });
                const text = await r.text();
                res.writeHead(r.status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
                return res.end(text);
            } catch (e) {
                res.writeHead(502, {'Content-Type':'application/json'});
                return res.end(JSON.stringify({error:'cs2_prices_proxy_error', message:String(e.message||e)}));
            }
        });
        return;
    }

    if((pathname==='/telegram/admin-webhook' || pathname==='/telegram/webhook') && req.method==='POST'){
        const update=await readJson(req);
        const expected=TG_TOKEN ? crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0,32) : '';
        const provided=String(req.headers['x-telegram-bot-api-secret-token']||'');
        if(expected && provided!==expected){
            res.writeHead(403,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:'forbidden'}));
            return;
        }
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
        Promise.resolve(processTelegramUpdate(update)).catch(e=>console.error('Admin TG webhook:',e.message));
        return;
    }

    if(pathname==='/telegram/payment-webhook' && req.method==='POST'){
        const update=await readJson(req);
        const expected=PAY_TG_TOKEN ? crypto.createHash('sha256').update(PAY_TG_TOKEN).digest('hex').slice(0,32) : '';
        const provided=String(req.headers['x-telegram-bot-api-secret-token']||'');
        if(expected && provided!==expected){
            res.writeHead(403,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,error:'forbidden'}));
            return;
        }
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
        Promise.resolve(processPaymentTelegramUpdate(update)).catch(e=>console.error('Payment TG webhook:',e.message));
        return;
    }

    if(pathname==='/privacy' || pathname==='/terms' || pathname==='/info') {
        const title = pathname==='/privacy' ? 'Политика конфиденциальности' : pathname==='/terms' ? 'Пользовательское соглашение' : 'Информация Zenodrop';
        const body = pathname==='/privacy' ? `
            <h1>Политика конфиденциальности Zenodrop</h1>
            <p><b>Дата актуализации: 9 сентября 2026 года.</b></p>
            <p>Настоящая политика описывает обработку данных при использовании сайта Zenodrop.</p>
            <h2>1. Какие данные обрабатываются</h2><p>Steam ID, отображаемое имя и аватар Steam, данные аккаунта Zenodrop, операции пополнения и вывода, а также технические данные, необходимые для работы сайта.</p>
            <h2>2. Цели обработки</h2><p>Авторизация, ведение аккаунта, выполнение операций, предотвращение злоупотреблений, поддержка пользователей и обеспечение безопасности.</p>
            <h2>3. Хранение</h2><p>Данные хранятся только в объёме, необходимом для работы сервиса и исполнения операций.</p>
            <h2>4. Передача</h2><p>Данные могут передаваться техническим и платёжным провайдерам только в объёме, необходимом для соответствующей операции.</p>
            <h2>5. Обращения</h2><p>Поддержка: ${SUPPORT_CONTACT}</p>` : pathname==='/terms' ? `
            <h1>Пользовательское соглашение Zenodrop</h1>
            <p><b>Дата актуализации: 9 сентября 2026 года.</b></p>
            <h2>1. Общие положения</h2><p>Используя Zenodrop, пользователь подтверждает, что ознакомился с настоящим соглашением и принимает его условия.</p>
            <h2>2. Аккаунт</h2><p>Для использования функций аккаунта требуется авторизация через Steam.</p>
            <h2>3. Пополнение</h2><p>Перед оплатой пользователь видит выбранный тариф и конкретную сумму.</p>
            <h2>4. Вывод</h2><p>Заявки на вывод обрабатываются в соответствии с правилами сервиса.</p>
            <h2>5. Поддержка</h2><p>${SUPPORT_CONTACT}</p>` : `
            <h1>Zenodrop — информация</h1><p><b>Актуально на 9 сентября 2026 года.</b></p>
            <p><a href="/privacy">Политика конфиденциальности</a></p><p><a href="/terms">Пользовательское соглашение</a></p>`;
        const page=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#0d0f17;color:#e8ecf4;max-width:820px;margin:0 auto;padding:32px;line-height:1.6}h1{color:#f59e0b}h2{color:#fff;margin-top:28px}a{color:#f7b32b}code{background:#1b2130;padding:3px 7px;border-radius:6px}</style></head><body>${body}<hr><p><a href="/info">← Вернуться к информации</a></p></body></html>`;
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
        return res.end(page);
    }

    res.writeHead(404);
    res.end('Not found');
});

// ===============================
// BOOT
// ===============================
(async () => {
  await initStore();
  for(const u of Object.values(data.users)){ ensureZenodropId(u); }
  saveStore();
  ensureOneActivePromo();
  setInterval(()=>{
    const active=promoList()[0];
    if(!active || (active.expiresAt && active.expiresAt<=Date.now()) || active.auto) createAutoPromo();
  },15*60*1000);

  loadCatalogFromDisk();
  if(!cs2CatalogCache.data) refreshCatalogInBackground();
  setInterval(refreshCatalogInBackground, CS2_CACHE_MS);

  server.listen(PORT, () => {
    console.log('Zenodrop running on port ' + PORT);
    console.log('PUBLIC_URL:', PUBLIC_URL || '(not set)');
    console.log('DATA_DIR:', DATA_DIR);
    console.log('Storage:', USE_REDIS ? 'Redis (Upstash)' : 'Local disk only');
    if(TG_TOKEN){ console.log('Admin TG enabled'); telegramStart(); } else { console.log('Admin TG disabled: no token'); }
    if(PAY_TG_TOKEN){ console.log('Payment TG enabled'); paymentTelegramStart(); } else { console.log('Payment TG disabled: no token'); }
  });
})();
