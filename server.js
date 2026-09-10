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

// Серверный бросок апгрейда: использует ровно переданный шанс.
// Здесь нет скрытого персонального коэффициента — результат одинаково
// рассчитывается для всех игроков при одинаковом отображаемом шансе.
function upgrade(chance){
  chance=Number(chance);
  if(!Number.isFinite(chance))return false;
  chance=Math.max(0,Math.min(100,chance));
  return Math.random()*100<chance;
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
    }, 30000);

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

async function buildCs2Catalog() {
    console.log('Loading CS2.SH schema + prices in batches...');

    // Не скачиваем огромный полный snapshot: на Render это может занимать
    // слишком долго. Берём схему (~47.5k предметов), равномерно выбираем
    // несколько тысяч обычных weapon skins и запрашиваем цены батчами по 100.
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

    // Важно: не режем каталог просто по алфавиту. Иначе дорогие Covert/ножи
    // могут вообще не попасть в выборку. Собираем каталог по ценовым классам:
    // high-tier предметы + ножи/перчатки + обычные дешёвые серии.
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

    // Сначала гарантируем дорогие категории.
    for (const x of high) add(x);
    for (const x of knives) add(x);
    for (const x of priority) add(x);

    // Затем равномерно добираем низкие/средние редкости, чтобы не пропали
    // дешёвые скины примерно от 10–20 ₽.
    const rest = cheapPool.filter(x => !selectedSet.has(x.name));
    const need = 7000 - selected.length;
    if (need > 0 && rest.length) {
        for (let i=0; i<Math.min(need, rest.length); i++) {
            const idx=Math.floor(i * rest.length / Math.min(need, rest.length));
            add(rest[idx]);
        }
    }
    // Если после этого осталось место — добираем весь остальной каталог равномерно.
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
        // Не отдаём микроскины дешевле примерно 8 ₽ (курс сайта около 80 ₽/$).
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
    console.log('Priced weapon items:', result.length, 'batches:', batches.length);
    return result.slice(0, 7000);
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

const server = http.createServer(
    async (req, res) => {

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
        } else {
            const signedSteam=steamFromSessionCookie(cookies.session_id);
            if(signedSteam){
                const stored=ensureUser(signedSteam);
                if(stored){
                    sessionUser={steamid:signedSteam,username:stored.username||'Игрок Zenodrop',avatar:stored.avatar||''};
                    ensureZenodropId(stored);
                }
            }
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

                        const sessionId = makeSessionCookie(steamId);

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
        // ===========================
        // SERVER-AUTHORITATIVE UPGRADE ROLL
        // ===========================
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
            const result=upgrade(chance);
            res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({ok:true,success:result,chance}));
          }catch(e){
            console.error('Upgrade roll error:',e.message);
            res.writeHead(400,{'Content-Type':'application/json','Cache-Control':'no-store'});
            return res.end(JSON.stringify({error:'invalid_json'}));
          }
        }

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

                // Обновляем каталог
                const items =
                    await buildCs2Catalog();

                if (
                    !items.length
                ) {
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
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
          Promise.resolve(processPaymentTelegramUpdate(update)).catch(e=>console.error('Payment Telegram webhook:',e.message));
          return;
        }

        // ===========================
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
            <h2>2. Аккаунт</h2><p>Для использования функций аккаунта требуется авторизация через Steam. Пользователь отвечает за сохранность доступа к своему Steam-аккаунту.</p>
            <h2>3. Пополнение</h2><p>Перед оплатой пользователь видит выбранный тариф и конкретную сумму. Доступны тарифы 100 ₽, 500 ₽, 1 000 ₽, 5 000 ₽ и другие суммы. Если платёжный шлюз временно не подключён, кнопка остаётся доступной и сообщает о временной недоступности оплаты.</p>
            <h2>4. Вывод</h2><p>Заявки на вывод обрабатываются в соответствии с правилами сервиса и могут проходить дополнительную проверку.</p>
            <h2>5. Поддержка</h2><p>${SUPPORT_CONTACT}</p>` : `
            <h1>Zenodrop — информация</h1><p><b>Актуально на 9 сентября 2026 года.</b></p>
            <p><a href="/privacy">Политика конфиденциальности</a></p><p><a href="/terms">Пользовательское соглашение</a></p>
            <h2>Тарифы и оплата</h2><p>100 ₽ · 500 ₽ · 1 000 ₽ · 5 000 ₽ · и другие суммы.</p><p>СБП — 14%; криптоплатежи — 5% по предложенному формату подключения.</p><p>До подключения платёжного шлюза кнопка «Оплатить» работает как заглушка и сообщает, что оплата временно недоступна.</p>`;
          const page=`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:Arial,sans-serif;background:#0d0f17;color:#e8ecf4;max-width:820px;margin:0 auto;padding:32px;line-height:1.6}h1{color:#f59e0b}h2{color:#fff;margin-top:28px}a{color:#f7b32b}code{background:#1b2130;padding:3px 7px;border-radius:6px}</style></head><body>${body}<hr><p><a href="/info">← Вернуться к информации</a></p></body></html>`;
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(page);
        }

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

server.listen(
    PORT,
    () => {

        console.log(
            'Zenodrop running on port ' +
            PORT
        );

        console.log('CS2.SH proxy enabled');
        if(TG_TOKEN){ console.log('Admin Telegram bot enabled'); telegramStart(); } else { console.log('Admin Telegram bot disabled: TELEGRAM_BOT_TOKEN is missing'); }
        if(PAY_TG_TOKEN){ console.log('Payment Telegram bot enabled'); paymentTelegramStart(); } else { console.log('Payment Telegram bot disabled: TELEGRAM_PAYMENT_BOT_TOKEN is missing'); }
    }
);
