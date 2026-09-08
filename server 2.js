const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8787;

const KEY = (
    process.env.CS2SH_API_KEY ||
    process.env.CS2_API_KEY ||
    process.env.CS2SH_KEY ||
    ''
).trim();

// Steam Web API key
const STEAM_API_KEY = (process.env.STEAM_API_KEY || '').trim();

if (!KEY) {
    console.error(
        'ERROR: Set CS2SH_API_KEY in Render Environment Variables'
    );
    process.exit(1);
}

const html = fs.readFileSync(
    path.join(__dirname, 'Zenodrop_CS2SH_400.html')
);

// ===============================
// SESSIONS
// ===============================

const sessions = new Map();


// ===============================
// ZENODROP ACCOUNT / TELEGRAM STORE
// ===============================
const PERSIST_DIR = process.env.ZENODROP_DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : __dirname);
try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch(e) {}
const DATA_FILE = path.join(PERSIST_DIR, 'zenodrop_data.json');
const CATALOG_FILE = path.join(PERSIST_DIR, 'cs2_catalog_cache.json');
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim(); // бот заявок + админ
const TG_BOT_URL = (process.env.TELEGRAM_BOT_URL || '').trim();
const TG_WEBHOOK_URL = (process.env.TELEGRAM_WEBHOOK_URL || ((process.env.RENDER_EXTERNAL_URL || '').trim() ? (process.env.RENDER_EXTERNAL_URL.trim().replace(/\/$/,'') + '/telegram/admin-webhook') : '')).trim();
const PAY_TG_TOKEN = (process.env.TELEGRAM_PAYMENT_BOT_TOKEN || '').trim(); // отдельный бот пополнений
const PAY_TG_BOT_URL = (process.env.TELEGRAM_PAYMENT_BOT_URL || 'https://t.me/ZenodropPayBot').trim();
const PAY_TG_WEBHOOK_URL = (process.env.TELEGRAM_PAYMENT_WEBHOOK_URL || ((process.env.RENDER_EXTERNAL_URL || '').trim() ? (process.env.RENDER_EXTERNAL_URL.trim().replace(/\/$/,'') + '/telegram/payment-webhook') : '')).trim();
const TG_ADMIN_IDS = new Set(String(process.env.TG_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));
let data = loadStore();
let tgOffset = 0;
let tgLoopRunning = false;
let tgUsername = '';

function loadStore(){
  try {
    const x=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    return {users:x.users||{},withdrawals:x.withdrawals||[],deposits:x.deposits||[],promos:x.promos||{},admins:x.admins||{},links:x.links||{}};
  } catch(e) {
    return {users:{},withdrawals:[],deposits:[],promos:{},admins:{},links:{}};
  }
}
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const dbPool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
}) : null;
let dbSaveQueue = Promise.resolve();
let dbReady = Promise.resolve();
let dbInitialized = false;

async function initCatalogDatabase(){
  if(!dbPool) return;
  await dbPool.query(`CREATE TABLE IF NOT EXISTS cs2_catalog_cache (id INTEGER PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function loadCatalogFromDatabase(){
  if(!dbPool) return null;
  try{
    const r=await dbPool.query('SELECT payload, updated_at FROM cs2_catalog_cache WHERE id=1');
    const payload=r.rows[0]?.payload;
    const items=Array.isArray(payload?.items) ? payload.items : null;
    if(items?.length){
      console.log('CS2.SH catalog loaded from PostgreSQL:', items.length, 'updated:', r.rows[0].updated_at);
      return {items, updatedAt:r.rows[0].updated_at};
    }
  }catch(e){ console.error('PostgreSQL catalog read:', e.message); }
  return null;
}

async function saveCatalogToDatabase(items){
  if(!dbPool || !Array.isArray(items) || !items.length) return;
  try{
    await dbPool.query(`INSERT INTO cs2_catalog_cache (id,payload,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()`, [JSON.stringify({items})]);
    console.log('CS2.SH catalog saved to PostgreSQL:', items.length);
  }catch(e){ console.error('PostgreSQL catalog save:', e.message); }
}

async function initDatabase(){
  if(!dbPool){
    for(const u of Object.values(data.users)){ ensureZenodropId(u); }
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e) {}
    console.log('DATABASE_URL is not configured; using local file storage.');
    return;
  }
  try{
    await dbPool.query(`CREATE TABLE IF NOT EXISTS zenodrop_state (id INTEGER PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const r = await dbPool.query('SELECT payload FROM zenodrop_state WHERE id=1');
    if(r.rows[0]?.payload){
      const x=r.rows[0].payload;
      data={users:x.users||{},withdrawals:x.withdrawals||[],deposits:x.deposits||[],promos:x.promos||{},admins:x.admins||{},links:x.links||{}};
      console.log('Zenodrop state loaded from PostgreSQL.');
    }else{
      await dbPool.query('INSERT INTO zenodrop_state (id,payload) VALUES (1,$1::jsonb) ON CONFLICT (id) DO NOTHING',[JSON.stringify(data)]);
      console.log('Zenodrop state initialized in PostgreSQL.');
    }
    await initCatalogDatabase();
    for(const u of Object.values(data.users)){ ensureZenodropId(u); }
    dbInitialized = true;
    saveStore();
  }catch(e){
    console.error('PostgreSQL init failed; continuing with file storage:', e.message);
  }
}

function saveStore(){
  const snapshot=JSON.stringify(data,null,2);
  try { fs.writeFileSync(DATA_FILE, snapshot); } catch(e){ console.error('store save:',e.message); }
  if(dbPool && dbInitialized){
    dbSaveQueue=dbSaveQueue.then(async()=>{
      try{
        await dbPool.query(`INSERT INTO zenodrop_state (id,payload,updated_at) VALUES (1,$1::jsonb,NOW()) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()`,[snapshot]);
      }catch(e){ console.error('PostgreSQL state save:',e.message); }
    });
  }
}
function ensureUser(steamid){
  const id=String(steamid||''); if(!id)return null;
  if(!data.users[id]) data.users[id]={steamid:id,balance:0,stats:{totalDeposited:0},withdrawDisabled:false,tgId:null,createdAt:Date.now()};
  if(!data.users[id].stats)data.users[id].stats={totalDeposited:0};
  return data.users[id];
}
function makeZenodropId(){
  let id='';
  do { id='ZN-'+String(crypto.randomInt(10000000,100000000)); }
  while(Object.values(data.users).some(u=>u.zenoId===id));
  return id;
}
function ensureZenodropId(user){
  if(!user.zenoId || !/^ZN-\d{8}$/.test(String(user.zenoId))) user.zenoId=makeZenodropId();
  return user.zenoId;
}
function findUserByZenodropId(zenoId){
  const id=String(zenoId||'').trim().toUpperCase();
  return Object.values(data.users).find(u=>String(u.zenoId||'').toUpperCase()===id) || null;
}
function findSteamByTelegram(chatId){
  return data.links[String(chatId)] || Object.values(data.users).find(u=>String(u.tgId||'')===String(chatId))?.steamid || null;
}
function pendingWithdrawalsForUser(steamid){
  return data.withdrawals
    .filter(w=>w.steamid===steamid && (w.status==='pending' || w.status==='approved'))
    .map(w=>({id:w.id,itemUid:w.item?.uid||null,itemName:w.item?.name||'',itemValue:Number(w.item?.value)||0,status:w.status,index:w.index,createdAt:w.createdAt||0}));
}
function isTgAdmin(id){return TG_ADMIN_IDS.has(String(id)) || !!data.admins[String(id)];}
function isWebAdmin(steamid){return !!data.admins['steam:'+String(steamid)];}
async function tg(method, body={}){ return tgWithToken(TG_TOKEN,'admin',method,body); }
async function tgPay(method, body={}){ return tgWithToken(PAY_TG_TOKEN,'payment',method,body); }
async function tgWithToken(token,label,method,body={}){
  if(!token){ console.error(`Telegram ${label}: token is not set`); return null; }
  try{
    const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const json=await r.json();
    if(!json?.ok) console.error(`Telegram ${label} API`,method,json?.description||'unknown error');
    return json;
  }catch(e){ console.error(`Telegram ${label}`,method,e.message); return null; }
}
async function notifyAdmins(text, keyboard){
  for(const id of TG_ADMIN_IDS){ await tg('sendMessage',{chat_id:id,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined}); }
  for(const [id,v] of Object.entries(data.admins)){ if(v && !TG_ADMIN_IDS.has(id)) await tg('sendMessage',{chat_id:id,text,parse_mode:'HTML',reply_markup:keyboard?{inline_keyboard:keyboard}:undefined}); }
}
function promoList(){return Object.values(data.promos).filter(x=>x.active!==false && (!x.expiresAt || x.expiresAt>Date.now()) && (!x.maxUses || Number(x.uses||0)<Number(x.maxUses))).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));}
function makePromo(code,percent,maxBonus=0,extra={}){
  const c=String(code||'').toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,32);
  const pct=Math.max(1,Math.min(100,Number(percent)||0));
  if(!c) return null;
  // В Zenodrop одновременно действует только один промокод.
  for(const p of Object.values(data.promos)){ p.active=false; }
  data.promos[c]={code:c,percent:pct,maxBonus:Math.max(0,Number(maxBonus)||0),active:true,createdAt:Date.now(),uses:0,...extra};
  saveStore();
  return data.promos[c];
}
function randomPromoCode(percent){
  const pct=Math.max(10,Math.min(25,Number(percent)||15));
  return 'ZEN'+pct;
}
function createAutoPromo(){
  const now=Date.now();
  const percent=[10,12,15,18,20,25][crypto.randomInt(0,6)];
  const code=randomPromoCode(percent);
  const p=makePromo(code,percent,0,{auto:true,expiresAt:now+15*60*1000,maxUses:0});
  console.log('New active promo:',p.code,p.percent+'%');
  return p;
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
// Старые версии могли оставить несколько промокодов в JSON. Делаем активным только один.
ensureOneActivePromo();
setInterval(()=>{
  const active=promoList()[0];
  if(!active || (active.expiresAt && active.expiresAt<=Date.now()) || active.auto) createAutoPromo();
},15*60*1000);
async function processTelegramUpdate(u){
  if(u.callback_query){
    const q=u.callback_query, id=String(q.from.id), d=String(q.data||'');
    if(!isTgAdmin(id)){await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Нет доступа',show_alert:true});return;}
    if(d.startsWith('wd:')){
      const [_,wid,action]=d.split(':'); const w=data.withdrawals.find(x=>x.id===wid);
      if(!w){await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка не найдена',show_alert:true});return;}
      if(action==='send'){
        w.status='approved';w.updatedAt=Date.now();saveStore();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка подтверждена'});
        await tg('sendMessage',{chat_id:q.message.chat.id,text:`Заявка <b>${wid}</b> подтверждена.\nОтправка скинов: <b>в обработке</b>.` ,parse_mode:'HTML'});
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`🎁 Вывод <b>${wid}</b> подтверждён. Скины отправляются.` ,parse_mode:'HTML'});
      } else if(action==='reject'){
        const user=ensureUser(w.steamid); if(user){user.balance+=Number(w.refund||0);}
        w.status='rejected';w.updatedAt=Date.now();saveStore();
        await tg('answerCallbackQuery',{callback_query_id:q.id,text:'Заявка отклонена'});
        if(w.tgId) await tg('sendMessage',{chat_id:w.tgId,text:`❌ Вывод <b>${wid}</b> отклонён. Средства возвращены.` ,parse_mode:'HTML'});
      }
    }
    return;
  }
  const m=u.message; if(!m || !m.chat)return; const chatId=String(m.chat.id), rawText=String(m.text||'').trim();
  const text=rawText.replace(/^\/(\w+)(?:@[^\s]+)?/, '/$1');
  const admin=isTgAdmin(chatId);
  if(/^\/start(?:\s|$)/i.test(text)){
    const payload=rawText.split(/\s+/).slice(1).join(' ').trim().toLowerCase();
    const depositText=payload.startsWith('deposit')
      ? '\n\n<b>Пополнение</b>\nОткройте сайт Zenodrop, выберите сумму и способ оплаты. Если пополняете через Telegram, заявка будет привязана к вашему Telegram ID.'
      : '';
    return tg('sendMessage',{chat_id:chatId,text:'<b>Zenodrop</b>\n\nВаш Telegram ID: <code>'+chatId+'</code>'+depositText+'\n\n/link STEAMID — привязать Steam\n/status — баланс и привязка\n/help — список команд',parse_mode:'HTML'});
  }
  if(text==='/deposit' || text==='/pay') return tg('sendMessage',{chat_id:chatId,text:'<b>Пополнение Zenodrop</b>\n\nПерейдите на сайт и выберите способ «Telegram». После создания заявки следуйте инструкции администратора.\n\nВаш Telegram ID: <code>'+chatId+'</code>',parse_mode:'HTML'});
  if(text==='/help') return tg('sendMessage',{chat_id:chatId,text:'<b>Zenodrop</b>\n\n/link STEAMID\n/status\n/help'+(admin?'\n\nАдминистратор:\n/give STEAMID SUM\n/withdrawlock STEAMID on|off\n/adminsteam STEAMID\n/admin TELEGRAM_ID\n/promo CODE PERCENT [MAX_BONUS]\n/withdrawals\n/adminpanel':'') ,parse_mode:'HTML'});
  if(text==='/status'){
    const steam=data.links[chatId]; const u2=steam?ensureUser(steam):null;
    return tg('sendMessage',{chat_id:chatId,text:steam?`Steam ID: <code>${steam}</code>\nБаланс: <b>${Number(u2?.balance||0).toFixed(2)} ₽</b>`:'Steam ID ещё не привязан.',parse_mode:'HTML'});
  }
  if(text.startsWith('/link ')){
    const steam=text.split(/\s+/)[1]; if(!/^\d{17}$/.test(steam)) return tg('sendMessage',{chat_id:chatId,text:'Используй: /link 7656119XXXXXXXXXX'});
    data.links[chatId]=steam; const u2=ensureUser(steam);u2.tgId=chatId;saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Привязан Steam ID <code>${steam}</code>`,parse_mode:'HTML'});
  }
  if(!admin && !/^\/(start|status|link|help|deposit|pay)(?:\s|$)/i.test(text)) return tg('sendMessage',{chat_id:chatId,text:'Команда не найдена. Используйте /start, /status, /link или /deposit.',parse_mode:'HTML'});
  if(!admin)return;
  if(text==='/withdrawals'){
    const list=data.withdrawals.filter(x=>x.status==='pending').slice(-10).reverse();
    if(!list.length)return tg('sendMessage',{chat_id:chatId,text:'Заявок на вывод нет.'});
    for(const w of list){await tg('sendMessage',{chat_id:chatId,text:`🟠 <b>${w.id}</b>\nSteam: <code>${w.steamid}</code>\nСумма: ${Number(w.value).toFixed(2)} ₽\nПредмет: ${w.item.name}`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🎁 Выдать',callback_data:`wd:${w.id}:send`},{text:'❌ Отклонить',callback_data:`wd:${w.id}:reject`}]]}});}
    return;
  }
  let a=text.match(/^\/give\s+(\d{17})\s+([\d.]+)/i); if(a){const u2=ensureUser(a[1]);u2.balance+=Number(a[2]);saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Начислено ${Number(a[2]).toFixed(2)} ₽ пользователю <code>${a[1]}</code>`,parse_mode:'HTML'});}
  a=text.match(/^\/withdrawlock\s+(\d{17})\s+(on|off)/i); if(a){const u2=ensureUser(a[1]);u2.withdrawDisabled=a[2].toLowerCase()==='on';saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Вывод для ${a[1]}: ${u2.withdrawDisabled?'запрещён':'разрешён'}`});}
  a=text.match(/^\/adminsteam\s+(\d{17})/i); if(a){data.admins['steam:'+a[1]]=true;saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Steam ID ${a[1]} получил web-admin.`});}
  a=text.match(/^\/admin\s+(\d+)/i); if(a){data.admins[a[1]]=true;saveStore();return tg('sendMessage',{chat_id:chatId,text:`✅ Telegram ID ${a[1]} получил admin.`});}
  a=text.match(/^\/promo\s+([A-Za-z0-9_-]+)\s+(\d+(?:\.\d+)?)\s*(?:([\d.]+))?/i); if(a){const p=makePromo(a[1],a[2],a[3]||0);return tg('sendMessage',{chat_id:chatId,text:`✅ Промокод <code>${p.code}</code>: +${p.percent}%`,parse_mode:'HTML'});}
  if(text==='/adminpanel')return tg('sendMessage',{chat_id:chatId,text:`Админ-панель: <code>/adminsteam STEAMID</code>\nБаланс: <code>/give STEAMID 1000</code>\nВывод: <code>/withdrawlock STEAMID on</code>\nПромо: <code>/promo CODE 12</code>\nЗаявки: <code>/withdrawals</code>`,parse_mode:'HTML'});
}
async function processPaymentTelegramUpdate(u){
  if(u.callback_query){
    const q=u.callback_query, chatId=String(q.from?.id||q.message?.chat?.id||'');
    const d=String(q.data||'');
    if(d==='pay:menu'){
      return sendPaymentMenu(chatId);
    }
    if(d==='pay:profile'){
      const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
      if(!user) return tgPay('sendMessage',{chat_id:chatId,text:'Аккаунт не привязан. Откройте Telegram через кнопку «Пополнить → Telegram» на сайте Zenodrop.'});
      return tgPay('sendMessage',{chat_id:chatId,text:`<b>Профиль Zenodrop</b>\n\nID: <code>${ensureZenodropId(user)}</code>\nSteam ID: <code>${user.steamid}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>`,parse_mode:'HTML'});
    }
    if(d.startsWith('pay:test:')){
      const amount=Number(d.split(':')[2]);
            const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
      if(!user || !Number.isFinite(amount) || amount<=0 || amount>10000){
        return tgPay('sendMessage',{chat_id:chatId,text:'❌ Сначала привяжите аккаунт через сайт Zenodrop.'});
      }
      user.balance=Number(user.balance||0)+amount;
      user.stats=user.stats||{totalDeposited:0};
      user.stats.totalDeposited=Number(user.stats.totalDeposited||0)+amount;
      user.lastTestTopup={amount,createdAt:Date.now(),telegramId:chatId};
      saveStore();
      return tgPay('sendMessage',{chat_id:chatId,text:`✅ <b>Тестовое пополнение</b>\n\n+${amount.toFixed(2)} ₽\nБаланс: <b>${Number(user.balance).toFixed(2)} ₽</b>\nID: <code>${ensureZenodropId(user)}</code>\n\nТестовый режим: деньги виртуальные.`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'💰 Пополнить ещё',callback_data:'pay:topup'}],[{text:'👤 Профиль',callback_data:'pay:profile'}]]}});
    }
    if(d==='pay:topup'){
      const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
      if(!user) return tgPay('sendMessage',{chat_id:chatId,text:'<b>Пополнение</b>\n\nСначала отправьте сюда свой Zenodrop ID с сайта.\nНапример: <code>ZN-12345678</code>',parse_mode:'HTML'});
      return tgPay('sendMessage',{chat_id:chatId,text:`<b>Пополнение Zenodrop</b>\n\nID: <code>${ensureZenodropId(user)}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>\n\nВыберите сумму для тестового пополнения:`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'🧪 +100 ₽',callback_data:'pay:test:100'},{text:'🧪 +500 ₽',callback_data:'pay:test:500'}],[{text:'🧪 +1000 ₽',callback_data:'pay:test:1000'}],[{text:'👤 Профиль',callback_data:'pay:profile'}]]}});
    }
    return;
  }
  const m=u.message;
  if(!m || !m.chat) return;
  const chatId=String(m.chat.id);
  const raw=String(m.text||'').trim();
  const command=raw.replace(/^\/(\w+)(?:@[^\s]+)?/,'/$1').toLowerCase();
  const payload=raw.split(/\s+/).slice(1).join(' ').trim();

  if(command==='/start'){
    const payloadId=(payload.match(/(?:deposit[_-])?(ZN-\d{8})/i)||[])[1];
    if(payloadId){
      const user=findUserByZenodropId(payloadId);
      if(user){
        user.tgId=chatId;
        data.links[chatId]=user.steamid;
        saveStore();
        return tgPay('sendMessage',{chat_id:chatId,text:`<b>Zenodrop — Пополнение</b>\n\nАккаунт привязан автоматически.\nID: <code>${ensureZenodropId(user)}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>\n\nВыберите действие:`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'💰 Пополнить',callback_data:'pay:topup'},{text:'👤 Профиль',callback_data:'pay:profile'}],[{text:'🌐 Открыть Zenodrop',url:'https://osododod.onrender.com/'}]]}});
      }
    }
    return sendPaymentMenu(chatId);
  }
  if(command==='/deposit' || command==='/pay') return sendPaymentMenu(chatId);
  // Пользователь может просто отправить свой Zenodrop ID из сайта: ZN-12345678
  // или 12345678. Никаких команд и deep-link не требуется.
  const plainId = raw.match(/^(?:ZN[- ]?)?(\d{8})$/i);
  if(plainId){
    const zenoId='ZN-'+plainId[1];
    const user=findUserByZenodropId(zenoId);
    if(user){
      user.tgId=chatId;
      data.links[chatId]=user.steamid;
      saveStore();
      return tgPay('sendMessage',{chat_id:chatId,text:`✅ <b>Аккаунт привязан</b>\n\nZenodrop ID: <code>${ensureZenodropId(user)}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>\n\nТеперь этот Telegram автоматически используется для пополнений Zenodrop.`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'💰 Пополнить',callback_data:'pay:topup'},{text:'👤 Профиль',callback_data:'pay:profile'}],[{text:'🌐 Открыть Zenodrop',url:'https://osododod.onrender.com/'}]]}});
    }
    return tgPay('sendMessage',{chat_id:chatId,text:'❌ Такой Zenodrop ID не найден. Скопируйте ID прямо из профиля на сайте, например <code>ZN-12345678</code>.',parse_mode:'HTML'});
  }
  if(command==='/id'){
    const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
    return tgPay('sendMessage',{chat_id:chatId,text:user?`Ваш Zenodrop ID: <code>${ensureZenodropId(user)}</code>`:'Аккаунт ещё не привязан. Откройте пополнение через Telegram с сайта Zenodrop.',parse_mode:'HTML'});
  }
  if(command==='/balance'){
    const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
    return tgPay('sendMessage',{chat_id:chatId,text:user?`Баланс <code>${ensureZenodropId(user)}</code>: <b>${Number(user.balance||0).toFixed(2)} ₽</b>`:'Аккаунт ещё не привязан.',parse_mode:'HTML'});
  }
  return sendPaymentMenu(chatId);
}
async function sendPaymentMenu(chatId){
  const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
  const id=user?ensureZenodropId(user):null;
  const text=id
    ? `<b>Zenodrop — Пополнение</b>\n\nВаш ID: <code>${id}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>\n\nВыберите действие:`
    : `<b>Zenodrop — Пополнение</b>\n\n<b>Сначала отправьте сюда свой Zenodrop ID с сайта.</b>\nНапример: <code>ZN-12345678</code>\n\nПосле этого аккаунт привяжется автоматически.`;
  return tgPay('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',reply_markup:{inline_keyboard:id?[[{text:'💰 Пополнить',callback_data:'pay:topup'},{text:'👤 Профиль',callback_data:'pay:profile'}],[{text:'🧪 Тест +100 ₽',callback_data:'pay:test:100'},{text:'🧪 Тест +500 ₽',callback_data:'pay:test:500'}],[{text:'🧪 Тест +1000 ₽',callback_data:'pay:test:1000'}],[{text:'🌐 Открыть Zenodrop',url:'https://osododod.onrender.com/'}]]:[]}});
}
async function paymentTelegramStart(){
  if(!PAY_TG_TOKEN){ console.error('Payment Telegram bot disabled: TELEGRAM_PAYMENT_BOT_TOKEN is missing'); return; }
  try{
    const me=await tgPay('getMe',{});
    if(!me?.ok){ console.error('Payment Telegram: invalid TELEGRAM_PAYMENT_BOT_TOKEN'); return; }
    console.log('Payment Telegram bot:',me.result.username?'@'+me.result.username:me.result.first_name||'unknown');
    await tgPay('setMyCommands',{commands:[{command:'start',description:'Открыть меню Zenodrop'},{command:'deposit',description:'Пополнить баланс'},{command:'id',description:'Показать Zenodrop ID'},{command:'balance',description:'Показать баланс'}]});
    if(PAY_TG_WEBHOOK_URL){
      const secret=crypto.createHash('sha256').update(PAY_TG_TOKEN).digest('hex').slice(0,32);
      const r=await tgPay('setWebhook',{url:PAY_TG_WEBHOOK_URL,secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
      if(r?.ok) console.log('Payment Telegram webhook enabled:',PAY_TG_WEBHOOK_URL);
      else console.error('Payment Telegram setWebhook failed:',r?.description||'unknown error');
    } else {
      console.error('Payment Telegram webhook URL is missing');
    }
  }catch(e){ console.error('Payment Telegram init:',e.message); }
}

async function telegramStart(){
  if(!TG_TOKEN){
    console.error('Telegram bot disabled: TELEGRAM_BOT_TOKEN is missing');
    return;
  }

  try{
    const me=await tg('getMe',{});
    if(!me?.ok){
      console.error('Telegram: invalid TELEGRAM_BOT_TOKEN');
      return;
    }

    tgUsername=me.result.username||'';
    console.log('Telegram bot:',tgUsername?'@'+tgUsername:me.result.first_name||'unknown');

    await tg('setMyCommands',{commands:[
      {command:'start',description:'Открыть Zenodrop'},
      {command:'status',description:'Показать баланс'},
      {command:'link',description:'Привязать Steam ID'},
      {command:'deposit',description:'Пополнение'},
      {command:'help',description:'Список команд'}
    ]});

    if(TG_WEBHOOK_URL){
      const secret=crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0,32);
      const r=await tg('setWebhook',{
        url:TG_WEBHOOK_URL,
        secret_token:secret,
        allowed_updates:['message','callback_query'],
        drop_pending_updates:false
      });
      if(r?.ok){
        console.log('Telegram webhook enabled:',TG_WEBHOOK_URL);
      }else{
        console.error('Telegram setWebhook failed:',r?.description||'unknown error');
      }
    }else{
      // Если проект запущен не на Render и webhook URL не задан — используем polling.
      const del=await tg('deleteWebhook',{drop_pending_updates:false});
      if(!del?.ok) console.error('Telegram deleteWebhook:',del?.description||'unknown error');
      startTelegramPollingFallback();
    }
  }catch(e){
    console.error('Telegram init:',e.message);
  }
}

let tgPollingFallback=false;
async function startTelegramPollingFallback(){
  if(tgPollingFallback)return;
  tgPollingFallback=true;
  let offset=0;
  console.log('Telegram polling fallback started');
  while(tgPollingFallback){
    try{
      const r=await tg('getUpdates',{offset,timeout:30,allowed_updates:['message','callback_query']});
      if(!r?.ok){
        console.error('Telegram getUpdates failed:',r?.description||'unknown error');
        await new Promise(resolve=>setTimeout(resolve,3000));
        continue;
      }
      for(const u of (r.result||[])){
        offset=Math.max(offset,u.update_id+1);
        try{ await processTelegramUpdate(u); }
        catch(e){ console.error('Telegram update:',e.message); }
      }
    }catch(e){
      console.error('Telegram polling:',e.message);
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
  }
}

// ===============================
// CS2.SH CACHE
// ===============================

let cs2CatalogCache = {
    data: null,
    expires: 0
};

let cs2CatalogPromise = null;
const CS2_CACHE_MS = 10 * 60 * 1000;

// ===============================
// CS2.SH REQUEST
// ===============================

async function cs2Fetch(url, options = {}) {
    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, 120000);

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

        let data = null;

        try {
            data = JSON.parse(text);
        } catch (_) {}

        if (!r.ok) {
            const msg =
                data?.message ||
                data?.error ||
                ('HTTP ' + r.status);

            const err = new Error(msg);

            err.status = r.status;
            err.body = data || text.slice(0, 1000);

            throw err;
        }

        return data;

    } finally {
        clearTimeout(timer);
    }
}

// ===============================
// BUILD CS2 CATALOG
// ===============================

function loadDiskCatalog(){
    try {
        if(!fs.existsSync(CATALOG_FILE)) return null;
        const x=JSON.parse(fs.readFileSync(CATALOG_FILE,'utf8'));
        if(Array.isArray(x?.items) && x.items.length) return x.items;
    } catch(e){ console.error('catalog disk read:', e.message); }
    return null;
}
function saveDiskCatalog(items){
    try {
        fs.mkdirSync(PERSIST_DIR,{recursive:true});
        fs.writeFileSync(CATALOG_FILE, JSON.stringify({savedAt:Date.now(),items}));
    } catch(e){ console.error('catalog disk save:', e.message); }
}

async function buildCs2Catalog() {
    console.log('Loading CS2.SH schema + prices in batches...');

    // Старая система Zenodrop: сначала схема, затем цены батчами по 100.
    // Это сохраняет большой живой каталог, а не искусственно созданные цены.
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
        if (
            low.includes('sticker') || low.includes('patch') ||
            low.includes('graffiti') || low.includes('music kit') ||
            low.includes('charm') || low.includes('agent') ||
            low.includes('case key')
        ) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        candidates.push({
            name,
            image,
            category: x?.category || x?.type || '',
            type: x?.type || '',
            rarity: x?.rarity || null
        });
    }

    const priorityWords = [
        'ak-47 |','m4a1-s |','m4a4 |','awp |','usp-s |','glock-18 |','p250 |',
        'deagle |','desert eagle |','famas |','galil ar |','mp9 |','mac-10 |',
        'mp7 |','mp5-sd |','ump-45 |','p90 |','ssg 08 |','scar-20 |','aug |',
        'sg 553 |','nova |','xm1014 |','mag-7 |','sawed-off |','tec-9 |',
        'five-seven |','cz75-auto |','dual berettas |','r8 revolver |','negev |','m249 |'
    ];
    const rarityTier = x => Number(x?.rarity?.tier || 0);
    const isKnife = x => /^★\s/.test(x.name) || /knife/i.test(String(x.category||''));
    const isGlove = x => /glove/i.test(String(x.category||'')) || /gloves/i.test(x.name);

    const high = candidates.filter(x => rarityTier(x) >= 5);
    const knives = candidates.filter(x => isKnife(x) || isGlove(x));
    const priority = candidates.filter(x => priorityWords.some(w => x.name.toLowerCase().startsWith(w)));
    const cheapPool = candidates.filter(x => rarityTier(x) <= 4);

    const selected = [];
    const selectedSet = new Set();
    const add = x => {
        if (selected.length >= 7000 || !x || selectedSet.has(x.name)) return;
        selectedSet.add(x.name);
        selected.push(x);
    };

    // Старая последовательность отбора: дорогие -> ножи/перчатки -> основные пушки -> дешёвый/средний пул.
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
    for (let i=0; i<selected.length; i += 100) {
        batches.push(selected.slice(i, i + 100).map(x => x.name));
    }

    const priceMap = new Map();
    let cursor = 0;
    const workers = Math.min(8, batches.length);
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= batches.length) return;
            try {
                const data = await cs2Fetch('https://api.cs2.sh/v1/prices/latest', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({items: batches[i]})
                });
                for (const [name, item] of Object.entries(data?.items || {})) priceMap.set(name, item);
            } catch (e) {
                console.warn('CS2 batch failed:', e.message || e);
            }
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
            category: x.category,
            type: x.type,
            rarity: x.rarity,
            api: p
        });
    }

    result.sort((a,b) => a.usd - b.usd);
    console.log('Priced weapon items:', result.length, 'batches:', batches.length);
    const finalItems = result.slice(0, 7000);
    saveDiskCatalog(finalItems);
    await saveCatalogToDatabase(finalItems);
    return finalItems;
}

// ===============================
// COOKIES
// ===============================

function parseCookies(req) {

    const list = {};

    const rc = req.headers.cookie;

    if (!rc) {
        return list;
    }

    rc.split(';').forEach(cookie => {

        const parts = cookie.split('=');

        const key = parts
            .shift()
            .trim();

        const value = decodeURI(
            parts.join('=')
        );

        list[key] = value;
    });

    return list;
}

async function readJson(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>1e6)req.destroy();});req.on('end',()=>{try{resolve(JSON.parse(b||'{}'));}catch(e){reject(e);}});req.on('error',reject);});}

// ===============================
// SERVER
// ===============================

dbReady = initDatabase();

const server = http.createServer(
    async (req, res) => {

        await dbReady;

        const urlObj = new URL(
            req.url,
            `http://${req.headers.host}`
        );

        const pathname =
            urlObj.pathname;

        // ===========================
        // SESSION
        // ===========================

        const cookies =
            parseCookies(req);

        let sessionUser = null;

        if (
            cookies.session_id &&
            sessions.has(cookies.session_id)
        ) {
            sessionUser =
                sessions.get(
                    cookies.session_id
                );
        }

        // ===========================
        // STEAM LOGIN
        // ===========================

        if (
            pathname === '/auth/steam'
        ) {

            const proto =
                req.headers['x-forwarded-proto'] ||
                'http';

            const realm =
                `${proto}://${req.headers.host}`;

            const returnTo =
                `${realm}/auth/steam/return`;

            const params =
                new URLSearchParams({

                    'openid.ns':
                        'http://specs.openid.net/auth/2.0',

                    'openid.mode':
                        'checkid_setup',

                    'openid.return_to':
                        returnTo,

                    'openid.realm':
                        realm,

                    'openid.identity':
                        'http://specs.openid.net/auth/2.0/identifier_select',

                    'openid.claimed_id':
                        'http://specs.openid.net/auth/2.0/identifier_select'
                });

            res.writeHead(
                302,
                {
                    Location:
                        `https://steamcommunity.com/openid/login?${params.toString()}`
                }
            );

            return res.end();
        }

        // ===========================
        // STEAM RETURN
        // ===========================

        if (
            pathname ===
            '/auth/steam/return'
        ) {

            try {

                const params =
                    new URLSearchParams();

                params.append(
                    'openid.ns',
                    'http://specs.openid.net/auth/2.0'
                );

                params.append(
                    'openid.mode',
                    'check_authentication'
                );

                urlObj.searchParams.forEach(
                    (value, key) => {

                        if (
                            key !==
                            'openid.mode'
                        ) {
                            params.append(
                                key,
                                value
                            );
                        }
                    }
                );

                const verification =
                    await fetch(
                        'https://steamcommunity.com/openid/login',
                        {
                            method: 'POST',

                            headers: {
                                'Content-Type':
                                    'application/x-www-form-urlencoded'
                            },

                            body:
                                params.toString()
                        }
                    );

                const verificationText =
                    await verification.text();

                if (
                    verificationText.includes(
                        'is_valid:true'
                    )
                ) {

                    const claimedId =
                        urlObj.searchParams.get(
                            'openid.claimed_id'
                        );

                    const match =
                        claimedId
                            ? claimedId.match(
                                /\/id\/([0-9]{17})/
                            )
                            : null;

                    const steamId =
                        match
                            ? match[1]
                            : null;

                    if (steamId) {

                        const playerRes =
                            await fetch(
                                `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId}`
                            );

                        const playerData =
                            await playerRes.json();

                        const player =
                            playerData
                                .response
                                ?.players
                                ?.[0] ||
                            {};

                        const userData = {

                            steamid:
                                steamId,

                            username:
                                player.personaname ||
                                'Unknown',

                            avatar:
                                player.avatarfull ||
                                player.avatarmedium ||
                                player.avatar ||
                                ''
                        };

                        const sessionId =
                            crypto.randomBytes(
                                16
                            ).toString('hex');

                        sessions.set(sessionId,userData);
                        const stored=ensureUser(steamId);
                        ensureZenodropId(stored);
                        stored.username=userData.username;
                        stored.avatar=userData.avatar;
                        saveStore();

                        res.writeHead(
                            302,
                            {
                                Location: '/',

                                'Set-Cookie':
                                    `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
                            }
                        );

                        return res.end();
                    }
                }

            } catch (e) {

                console.error(
                    'Steam Auth Error:',
                    e
                );
            }

            res.writeHead(
                302,
                {
                    Location: '/'
                }
            );

            return res.end();
        }

        // ===========================
        // CURRENT USER
        // ===========================

        if (
            pathname ===
                '/api/current-user' &&
            req.method === 'GET'
        ) {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'application/json',

                    'Cache-Control':
                        'no-store'
                }
            );

            if(sessionUser){
              const stored=ensureUser(sessionUser.steamid);
              ensureZenodropId(stored);
              const serverAccount={...stored,pendingWithdrawals:pendingWithdrawalsForUser(sessionUser.steamid)};
              return res.end(JSON.stringify({...sessionUser,serverAccount,webAdmin:isWebAdmin(sessionUser.steamid)}));
            }
            return res.end(JSON.stringify(null));
        }

        // ===========================
        // LOGOUT
        // ===========================

        if (
            pathname ===
                '/auth/logout'
        ) {

            if (
                cookies.session_id
            ) {
                sessions.delete(
                    cookies.session_id
                );
            }

            res.writeHead(
                302,
                {
                    Location: '/',

                    'Set-Cookie':
                        'session_id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
                }
            );

            return res.end();
        }

        // ===========================
        // MAIN HTML
        // ===========================

        if (
            req.url === '/'
        ) {

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'text/html; charset=utf-8'
                }
            );

            return res.end(html);
        }


        // ===========================
        // ACCOUNT / PROMOS / DEPOSITS / WITHDRAWALS
        // ===========================
        if(pathname==='/api/account/sync' && req.method==='POST'){
          if(!sessionUser?.steamid){res.writeHead(401);return res.end(JSON.stringify({error:'auth_required'}));}
          const body=await readJson(req),u=ensureUser(sessionUser.steamid);
          ensureZenodropId(u);
          if(Number.isFinite(Number(body.balance)))u.balance=Math.max(0,Number(body.balance));
          if(body.stats&&typeof body.stats==='object')u.stats={...u.stats,...body.stats};
          saveStore();
          const responseUser={...u,pendingWithdrawals:pendingWithdrawalsForUser(sessionUser.steamid)};
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,user:responseUser}));
        }
        if(pathname==='/api/config' && req.method==='GET'){
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
          return res.end(JSON.stringify({telegramBotUrl:TG_BOT_URL||null,paymentTelegramBotUrl:PAY_TG_BOT_URL||'https://t.me/ZenodropPayBot'}));
        }
        if(pathname==='/api/promos' && req.method==='GET'){
          const list=promoList().slice(0,8).map(x=>({code:x.code,percent:x.percent,maxBonus:x.maxBonus,expiresAt:x.expiresAt||0,auto:!!x.auto,uses:Number(x.uses||0),maxUses:Number(x.maxUses||0)}));
          res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}); return res.end(JSON.stringify({items:list}));
        }
        if(pathname==='/api/deposit' && req.method==='POST'){
          if(!sessionUser?.steamid){res.writeHead(401);return res.end(JSON.stringify({error:'auth_required'}));}
          const body=await readJson(req); const amount=Number(body.amount)||0, method=String(body.method||''); const promo=String(body.promo||'').toUpperCase();
          if(amount<50){res.writeHead(400);return res.end(JSON.stringify({error:'min_50'}));}
          const pc=promo?data.promos[promo]:null;
          if(promo && (!pc || pc.active===false || (pc.expiresAt && pc.expiresAt<=Date.now()))){res.writeHead(400);return res.end(JSON.stringify({error:'promo_invalid'}));}
          const bonus=pc?Math.min(amount*(Number(pc.percent)||0)/100,Number(pc.maxBonus)||Infinity):0;
          const id='dep_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');
          data.deposits.push({id,steamid:sessionUser.steamid,tgId:ensureUser(sessionUser.steamid)?.tgId||null,amount,bonus,method,promo,status:'pending',createdAt:Date.now()});saveStore();
          await notifyAdmins(`💳 <b>Новое пополнение</b>\nID: <code>${id}</code>\nSteam: <code>${sessionUser.steamid}</code>\nСумма: ${amount.toFixed(2)} ₽\nМетод: ${method}\nПромо: ${promo||'—'}\nК начислению: ${(amount+bonus).toFixed(2)} ₽`);
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,id,bonus,total:amount+bonus}));
        }
        if(pathname==='/api/withdrawals' && req.method==='POST'){
          if(!sessionUser?.steamid){res.writeHead(401);return res.end(JSON.stringify({error:'auth_required'}));}
          const body=await readJson(req), index=Number(body.index); const stored=ensureUser(sessionUser.steamid);
          if(stored.withdrawDisabled){res.writeHead(403);return res.end(JSON.stringify({error:'withdraw_disabled'}));}
          // Предмет блокируется сразу после создания заявки: пока вывод pending/approved,
          // его нельзя продать или выбрать для апгрейда.
          const item=body.item; if(!item || !item.name || !Number(item.value)){res.writeHead(400);return res.end(JSON.stringify({error:'item_required'}));}
          const itemUid=String(item.uid||'');
          if(!itemUid){res.writeHead(400);return res.end(JSON.stringify({error:'item_uid_required'}));}
          const alreadyPending=data.withdrawals.some(x=>x.steamid===sessionUser.steamid && x.item?.uid===itemUid && (x.status==='pending'||x.status==='approved'));
          if(alreadyPending){res.writeHead(409);return res.end(JSON.stringify({error:'item_withdraw_pending'}));}
          const id='wd_'+Date.now().toString(36)+'_'+crypto.randomBytes(3).toString('hex');
          const w={id,steamid:sessionUser.steamid,tgId:stored.tgId||null,index,item:{name:item.name,value:Number(item.value),img:item.img||'',assetid:item.assetid||null,uid:itemUid},value:Number(item.value),refund:Number(item.value),status:'pending',createdAt:Date.now()};
          data.withdrawals.push(w);saveStore();
          await notifyAdmins(`🟠 <b>Новая заявка на вывод</b>\nID: <code>${id}</code>\nSteam: <code>${sessionUser.steamid}</code>\nСумма: ${w.value.toFixed(2)} ₽\nСкин: ${item.name}`,[[{text:'🎁 Выдать',callback_data:`wd:${id}:send`},{text:'❌ Отклонить',callback_data:`wd:${id}:reject`}]]);
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,id,status:'pending'}));
        }
        if(pathname==='/api/admin/state' && req.method==='GET'){
          if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));}
          const users=Object.values(data.users);res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({users,withdrawals:data.withdrawals.slice(-100).reverse(),deposits:data.deposits.slice(-100).reverse(),promos:promoList()}));
        }
        if(pathname==='/api/admin/promo' && req.method==='POST'){
          if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));}
          const body=await readJson(req),code=String(body.code||'').trim().toUpperCase(),percent=Number(body.percent),maxBonus=Number(body.maxBonus)||0,expiresMinutes=Number(body.expiresMinutes)||0;
          if(!/^[A-Z0-9_-]{3,32}$/.test(code)||!Number.isFinite(percent)||percent<1||percent>100){res.writeHead(400);return res.end(JSON.stringify({error:'invalid_promo'}));}
          const p=makePromo(code,percent,maxBonus,{auto:false,expiresAt:expiresMinutes>0?Date.now()+expiresMinutes*60000:0});
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,promo:p}));
        }
        if(pathname==='/api/admin/user' && req.method==='POST'){
          if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));}
          const body=await readJson(req); const u=ensureUser(body.steamid); if(!u){res.writeHead(400);return res.end(JSON.stringify({error:'steamid_required'}));}
          if(body.balanceDelta!==undefined)u.balance+=Number(body.balanceDelta)||0; if(body.balance!==undefined)u.balance=Number(body.balance)||0; if(body.withdrawDisabled!==undefined)u.withdrawDisabled=!!body.withdrawDisabled; saveStore();
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,user:u}));
        }
        if(pathname==='/api/admin/deposit-confirm' && req.method==='POST'){
          if(!sessionUser?.steamid || !isWebAdmin(sessionUser.steamid)){res.writeHead(403);return res.end(JSON.stringify({error:'forbidden'}));}
          const body=await readJson(req); const d=data.deposits.find(x=>x.id===body.id); if(!d){res.writeHead(404);return res.end(JSON.stringify({error:'not_found'}));}
          if(d.status!=='pending'){return res.end(JSON.stringify({ok:true,status:d.status}));} const u=ensureUser(d.steamid);u.balance+=d.amount+d.bonus;u.stats.totalDeposited=(u.stats.totalDeposited||0)+d.amount+d.bonus;if(d.promo&&data.promos[d.promo])data.promos[d.promo].uses=(data.promos[d.promo].uses||0)+1;d.status='paid';d.updatedAt=Date.now();saveStore();
          if(d.tgId)await tg('sendMessage',{chat_id:d.tgId,text:`✅ Пополнение <b>${d.id}</b> подтверждено: +${(d.amount+d.bonus).toFixed(2)} ₽`,parse_mode:'HTML'});
          res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,user:u}));
        }
        // ===========================
        // USD → RUB
        // ===========================

        if (
            pathname ===
                '/api/usd-rub' &&
            req.method === 'GET'
        ) {

            try {

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 3000);
                const r =
                    await fetch(
                        'https://kurs-rublya.ru/api/v1/rates/USD/',
                        {
                            signal: controller.signal,
                            headers: {
                                Accept:
                                    'application/json'
                            }
                        }
                    );
                clearTimeout(timer);

                const text =
                    await r.text();

                if (!r.ok) {

                    res.writeHead(
                        r.status,
                        {
                            'Content-Type':
                                'application/json'
                        }
                    );

                    return res.end(
                        text
                    );
                }

                const d =
                    JSON.parse(text);

                const rate =
                    Number(
                        d.ratePerUnit ||
                        d.value ||
                        d.data?.ratePerUnit ||
                        d.data?.rate
                    );

                if (
                    !Number.isFinite(rate) ||
                    rate <= 0
                ) {
                    throw new Error(
                        'Invalid USD rate'
                    );
                }

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json',

                        'Cache-Control':
                            'no-store'
                    }
                );

                return res.end(
                    JSON.stringify({
                        rate,

                        source:
                            'kurs-rublya.ru',

                        updatedAt:
                            new Date().toISOString()
                    })
                );

            } catch (e) {

                res.writeHead(
                    502,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                return res.end(
                    JSON.stringify({
                        error:
                            String(e)
                    })
                );
            }
        }

        // ===========================
        // CS2 HEALTH
        // ===========================
        if (pathname === '/api/cs2/health' && req.method === 'GET') {
            try {
                const started = Date.now();
                const r = await fetch('https://api.cs2.sh/v1/schema', {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + KEY,
                        'Accept-Encoding': 'gzip',
                        'Accept': 'application/json'
                    }
                });
                const text = await r.text();
                let body = null;
                try { body = JSON.parse(text); } catch (_) {}
                res.writeHead(r.ok ? 200 : r.status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
                return res.end(JSON.stringify({
                    ok: r.ok,
                    keyConfigured: !!KEY,
                    upstreamStatus: r.status,
                    latencyMs: Date.now() - started,
                    upstreamMessage: r.ok ? null : (body?.message || body?.error || text.slice(0,300))
                }));
            } catch (e) {
                res.writeHead(502, {'Content-Type':'application/json; charset=utf-8'});
                return res.end(JSON.stringify({ok:false,keyConfigured:!!KEY,error:String(e?.message||e)}));
            }
        }

        // ===========================
        // CS2 CATALOG
        // ===========================

        if (
            pathname ===
                '/api/cs2/catalog' &&
            req.method === 'GET'
        ) {

            try {

                // Отдаём кеш
                if (
                    cs2CatalogCache.data &&
                    Date.now() <
                        cs2CatalogCache.expires
                ) {

                    res.writeHead(
                        200,
                        {
                            'Content-Type':
                                'application/json; charset=utf-8',

                            'Cache-Control':
                                'no-store'
                        }
                    );

                    return res.end(
                        JSON.stringify({
                            currency: 'USD',

                            items:
                                cs2CatalogCache.data,

                            cached: true
                        })
                    );
                }

                // Один общий запрос на построение: несколько пользователей не запускают
                // одновременно несколько тяжёлых snapshot-запросов к cs2.sh.
                if (!cs2CatalogPromise) {
                    cs2CatalogPromise = buildCs2Catalog().finally(() => { cs2CatalogPromise = null; });
                }
                const items = await cs2CatalogPromise;

                if (!items.length) {
                    throw new Error(
                        'cs2.sh returned no priced items'
                    );
                }

                cs2CatalogCache = {

                    data: items,

                    expires:
                        Date.now() +
                        5 * 60 * 1000
                };

                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json; charset=utf-8',

                        'Cache-Control':
                            'no-store'
                    }
                );

                return res.end(
                    JSON.stringify({
                        currency: 'USD',

                        items,

                        cached: false
                    })
                );

            } catch (e) {

                const status =
                    Number(e.status) ||
                    502;

                res.writeHead(
                    status,
                    {
                        'Content-Type':
                            'application/json; charset=utf-8'
                    }
                );

                return res.end(
                    JSON.stringify({

                        error:
                            'cs2_catalog_proxy_error',

                        message:
                            String(
                                e.message || e
                            ),

                        upstreamStatus:
                            e.status || null,

                        details:
                            e.body || null
                    })
                );
            }
        }

        // ===========================
        // CS2 SCHEMA PROXY
        // ===========================

        if (
            pathname ===
                '/api/cs2/schema' &&
            req.method === 'GET'
        ) {

            try {

                const r =
                    await fetch(
                        'https://api.cs2.sh/v1/schema',
                        {
                            method: 'GET',

                            headers: {
                                'Authorization':
                                    'Bearer ' + KEY,

                                'Accept-Encoding':
                                    'gzip'
                            }
                        }
                    );

                const text =
                    await r.text();

                res.writeHead(
                    r.status,
                    {
                        'Content-Type':
                            'application/json; charset=utf-8',

                        'Cache-Control':
                            'no-store'
                    }
                );

                return res.end(
                    text
                );

            } catch (e) {

                res.writeHead(
                    502,
                    {
                        'Content-Type':
                            'application/json; charset=utf-8'
                    }
                );

                return res.end(
                    JSON.stringify({

                        error:
                            'cs2_schema_proxy_error',

                        message:
                            String(e)
                    })
                );
            }
        }

        // ===========================
        // CS2 PRICES PROXY
        // ===========================

        if (
            pathname ===
                '/api/prices' &&
            req.method === 'POST'
        ) {

            let body = '';

            req.on(
                'data',
                chunk => {
                    body += chunk;
                }
            );

            req.on(
                'end',
                async () => {

                    try {

                        const input =
                            JSON.parse(
                                body || '{}'
                            );

                        const items =
                            Array.isArray(
                                input.items
                            )
                                ? input.items
                                    .filter(
                                        x =>
                                            typeof x === 'string' &&
                                            x.trim()
                                    )
                                    .slice(0, 100)
                                : [];

                        if (
                            !items.length
                        ) {

                            res.writeHead(
                                400,
                                {
                                    'Content-Type':
                                        'application/json'
                                }
                            );

                            return res.end(
                                JSON.stringify({
                                    error:
                                        'items_required'
                                })
                            );
                        }

                        const r =
                            await fetch(
                                'https://api.cs2.sh/v1/prices/latest',
                                {
                                    method: 'POST',

                                    headers: {
                                        'Authorization':
                                            'Bearer ' + KEY,

                                        'Content-Type':
                                            'application/json',

                                        'Accept-Encoding':
                                            'gzip'
                                    },

                                    body:
                                        JSON.stringify({
                                            items
                                        })
                                }
                            );

                        const text =
                            await r.text();

                        res.writeHead(
                            r.status,
                            {
                                'Content-Type':
                                    'application/json; charset=utf-8',

                                'Cache-Control':
                                    'no-store'
                            }
                        );

                        return res.end(
                            text
                        );

                    } catch (e) {

                        res.writeHead(
                            502,
                            {
                                'Content-Type':
                                    'application/json'
                            }
                        );

                        return res.end(
                            JSON.stringify({

                                error:
                                    'cs2_prices_proxy_error',

                                message:
                                    String(
                                        e.message || e
                                    )
                            })
                        );
                    }
                }
            );

            return;
        }

        if((pathname==='/telegram/admin-webhook' || pathname==='/telegram/webhook') && req.method==='POST'){
          const update=await readJson(req);
          const expected=TG_TOKEN ? crypto.createHash('sha256').update(TG_TOKEN).digest('hex').slice(0,32) : '';
          const provided=String(req.headers['x-telegram-bot-api-secret-token']||'');
          if(expected && provided!==expected){ res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'forbidden'})); return; }
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
          Promise.resolve(processTelegramUpdate(update)).catch(e=>console.error('Admin Telegram webhook:',e.message));
          return;
        }

        if(pathname==='/telegram/payment-webhook' && req.method==='POST'){
          const update=await readJson(req);
          const expected=PAY_TG_TOKEN ? crypto.createHash('sha256').update(PAY_TG_TOKEN).digest('hex').slice(0,32) : '';
          const provided=String(req.headers['x-telegram-bot-api-secret-token']||'');
          if(expected && provided!==expected){ res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'forbidden'})); return; }
          // Для callback_query отвечаем Telegram прямо HTTP-ответом webhook.
          // Это мгновенно снимает вечный spinner с кнопки даже если Render/Node
          // задержит последующую обработку update.
          if(update && update.callback_query){
            const q=update.callback_query;
            const d=String(q.data||'');
            const text=d.startsWith('pay:test:') ? `Обрабатываем +${Number(d.split(':')[2])||0} ₽…` : '';
            try{ await tgPay('answerCallbackQuery',{callback_query_id:q.id,text,show_alert:false,cache_time:0}); }catch(e){ console.error('Payment callback ack:',e.message); }
          }
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
          Promise.resolve(processPaymentTelegramUpdate(update)).catch(e=>console.error('Payment Telegram webhook:',e.message));
          return;
        }

        // ===========================
        // 404
        // ===========================

        res.writeHead(404);

        res.end(
            'Not found'
        );
    }
);

// ===============================
// START
// ===============================

// Каталог строится только по запросу клиента и затем кешируется.

dbReady.then(() => server.listen(
    PORT,
    () => {

        console.log(
            'Zenodrop running on port ' +
            PORT
        );

        console.log('CS2.SH proxy enabled');
        // Предзагрузка: сначала мгновенно поднимаем сохранённый каталог с диска,
        // затем обновляем его с CS2.SH в фоне. Поэтому первый экран не зависает на батчах.
        (async () => {
            let stored = null;
            if(dbPool){ stored = await loadCatalogFromDatabase(); }
            const diskCatalog = stored?.items || loadDiskCatalog();
            if(diskCatalog?.length){
                cs2CatalogCache = { data: diskCatalog, expires: Date.now() + CS2_CACHE_MS };
                console.log(stored ? 'CS2.SH catalog loaded from PostgreSQL cache:' : 'CS2.SH catalog loaded from persistent file cache:', diskCatalog.length);
            }
            setTimeout(() => {
                if (!cs2CatalogPromise) {
                cs2CatalogPromise = buildCs2Catalog()
                    .then(items => {
                        if (items?.length) {
                            cs2CatalogCache = { data: items, expires: Date.now() + CS2_CACHE_MS };
                            console.log('CS2.SH catalog preloaded/refreshed:', items.length);
                        }
                        return items;
                    })
                    .catch(e => { console.error('CS2.SH preload failed:', e.message || e); return []; })
                    .finally(() => { cs2CatalogPromise = null; });
                }
            }, 100);
        })().catch(e => console.error('CS2.SH cache bootstrap failed:', e.message || e));
        if(TG_TOKEN){ console.log('Admin Telegram bot enabled'); telegramStart(); } else { console.log('Admin Telegram bot disabled: TELEGRAM_BOT_TOKEN is missing'); }
        if(PAY_TG_TOKEN){ console.log('Payment Telegram bot enabled'); paymentTelegramStart(); } else { console.log('Payment Telegram bot disabled: TELEGRAM_PAYMENT_BOT_TOKEN is missing'); }
    }
));
