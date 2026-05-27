const { Bot, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  BOT_TOKEN: '8859814892:AAHAq_JqxynxYifwOnF3rB3Tas8PakSVQIU',
  ADMIN_IDS: [7295281658, 5137860558],
  DB_PATH: './data.json',
  PIARFLOW_API_KEY: '-Fw-JokBjo-mmNfQsDyt82ZsKUXzSkE7',
  PIARFLOW_BASE_URL: 'https://piarflow.ru/v1'
};

// ==========================================
// 2. БД И УТИЛИТЫ
// ==========================================
const DEFAULT_DB = { 
  users: {}, withdrawals: {}, transactions: [], 
  settings: { REQUIRED_CHATS: [], refReward: 10000, minWithdraw: 50000 }, 
  nextWdId: 1 
};
const dbPath = path.resolve(__dirname, CONFIG.DB_PATH);
let db = null;
let saveTimer = null;

async function loadDB() {
  try { const raw = await fs.readFile(dbPath, 'utf8'); db = JSON.parse(raw); } 
  catch { db = JSON.parse(JSON.stringify(DEFAULT_DB)); }
  db.settings = { ...DEFAULT_DB.settings, ...(db.settings || {}) };
  db.transactions = (db.transactions || []).slice(-500);
  for (const id in db.users) {
    const u = db.users[id];
    u.referral_count = u.referral_count || 0;
    u.referral_list = u.referral_list || [];
    u.totalEarned = u.totalEarned || 0;
    u.totalSpent = u.totalSpent || 0;
  }
  return db;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    try {
      const tmp = dbPath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(db));
      await fs.rename(tmp, dbPath);
    } catch (e) { console.error('❌ DB Save:', e.message); }
    saveTimer = null;
  }, 1500);
}
const saveDB = scheduleSave;

const getUser = id => db.users[String(id)] || null;
const setUser = user => { 
  user.banned = !!user.banned; 
  user.referral_count = user.referral_count || 0;
  user.referral_list = user.referral_list || [];
  user.lastActive = Date.now();
  db.users[String(user.id)] = user; 
  saveDB(); 
  return user; 
};

const adjustBalance = (id, amount, type, desc) => {
  const user = getUser(id);
  if (!user) throw new Error('User not found');
  user.balance = (user.balance || 0) + amount;
  user.totalEarned += amount > 0 ? amount : 0;
  user.totalSpent += amount < 0 ? Math.abs(amount) : 0;
  db.transactions.push({ user_id: user.id, amount, type, desc, created_at: Date.now() });
  if (db.transactions.length > 500) db.transactions = db.transactions.slice(-450);
  saveDB();
  return user;
};

const getPendingWithdrawals = () => Object.values(db.withdrawals).filter(w => w.status === 'pending').sort((a,b) => b.created_at - a.created_at);
const getStats = () => {
  const users = Object.values(db.users);
  return { total: users.length, balance: users.reduce((s,u) => s + (u.balance||0), 0), pending: getPendingWithdrawals().length, totalRefs: users.reduce((s,u) => s + (u.referral_count||0), 0) };
};

// ==========================================
// 3. PIARFLOW API
// ==========================================
const pf = {
  enabled: () => !!CONFIG.PIARFLOW_API_KEY && CONFIG.PIARFLOW_API_KEY.length > 10,
  async request(endpoint, body) {
    if (!this.enabled()) throw new Error('API_KEY_EMPTY');
    const res = await fetch(`${CONFIG.PIARFLOW_BASE_URL}${endpoint}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${CONFIG.PIARFLOW_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text().catch(()=>'')}`);
    return res.json();
  },
  async getSponsors(userId, chatId) {
    if (!this.enabled()) return null;
    try { const d = await this.request('/sponsors', { user_id: userId, chat_id: chatId, max_sponsors: 10 }); return d.sponsors || []; } 
    catch { return null; }
  },
  async checkSponsors(userId, links) {
    if (!this.enabled()) return null;
    try { const d = await this.request('/sponsors/check', { user_id: userId, links }); return d.sponsors || []; } 
    catch { return null; }
  }
};

// ==========================================
// 4. УТИЛИТЫ И ПРОВЕРКА ДОСТУПА
// ==========================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = v => `${parseFloat(v||0).toLocaleString('ru-RU')} GRAM`;
const isAdmin = id => CONFIG.ADMIN_IDS.map(String).includes(String(id));
const userStates = new Map();

const safeEdit = async (ctx, text, kb) => {
  try { await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' }); }
  catch (err) {
    if (err.description?.includes('not modified') || err.description?.includes('can\'t be edited')) {
      await ctx.reply(text, { reply_markup: kb, parse_mode: 'HTML' }).catch(()=>{});
    } else await ctx.reply(text, { reply_markup: kb, parse_mode: 'HTML' }).catch(()=>{});
  }
};
const ack = async ctx => { try { await ctx.answerCallbackQuery(); } catch {} };

const requireSub = async (ctx, action) => {
  const uid = ctx.from.id;
  let isSubscribed = true;
  let sponsors = null;

  if (pf.enabled()) {
    sponsors = await pf.getSponsors(uid, ctx.chat.id);
    if (sponsors?.length) {
      const res = await pf.checkSponsors(uid, sponsors.map(s => s.link));
      isSubscribed = res?.every(r => r.status === 'subscribed') || false;
    }
  } else if (db.settings.REQUIRED_CHATS?.length > 0) {
    for (const c of db.settings.REQUIRED_CHATS) {
      try {
        const chatId = c.startsWith('-100') ? parseInt(c, 10) : c.replace(/^@/, '');
        const m = await ctx.api.getChatMember(chatId, uid);
        if (!['member', 'administrator', 'creator'].includes(m.status)) isSubscribed = false;
      } catch { isSubscribed = false; }
    }
  }

  if (!isSubscribed) {
    const links = sponsors?.length ? sponsors : db.settings.REQUIRED_CHATS;
    const txt = `🔒 <b>Доступ временно ограничен</b>\n\n<i>Для использования бота подтвердите подписку на спонсоров.</i>\n\n📋 <b>Каналы:</b>\n${links.map((s,i)=>`🔹 ${i+1}. ${typeof s === 'string' ? s : s.link}`).join('\n')}\n\n<i>Нажмите кнопку проверки после подписки.</i>`;
    const k = new InlineKeyboard();
    links.forEach(l => k.url(`📢 Подписаться`, typeof l === 'string' ? (l.startsWith('-100')?`https://t.me/c/${l.slice(4)}`:`https://t.me/${l.replace(/^@/,'')}`) : l.link).row());
    k.text('✅ Проверить подписку', 'check_sponsors').row();
    return ctx.reply(txt, { reply_markup: k, parse_mode: 'HTML' });
  }
  return action();
};

// ==========================================
// 5. КЛАВИАТУРЫ
// ==========================================
const kb = {
  main: (isAdminUser) => {
    const k = new InlineKeyboard();
    k.text('👤 Профиль', 'p_profile').text('💰 Баланс', 'p_balance').row();
    k.text('👥 Рефералы', 'p_ref').text('📊 Статистика', 'p_stats').row();
    k.text('💸 Вывод', 'p_withdraw').text('📜 История', 'p_history').row();
    if (isAdminUser) k.text('🔐 Админ', 'a_main').row();
    return k;
  },
  back: () => new InlineKeyboard().text('🔙 Назад', 'p_main'),
  backAdmin: () => new InlineKeyboard().text('🔙 В админку', 'a_main'),
  adminMain: () => new InlineKeyboard()
    .text('🔍 Поиск', 'a_search').text('👥 Юзеры', 'a_users').row()
    .text('📋 Заявки', 'a_wd').text('⚙️ Настройки', 'a_settings').row()
    .text('📢 Рассылка', 'a_broadcast').text('🔙 Закрыть', 'p_main'),
  adminUser: (uid) => new InlineKeyboard()
    .text('💰 Баланс', `a_bal:${uid}`).row()
    .text('🚫 Бан/Разбан', `a_ban:${uid}`).text('🔙 Назад', 'a_main'),
  adminWd: (id) => new InlineKeyboard()
    .text('✅ Одобрить', `a_wd_ap:${id}`).text('❌ Отклонить', `a_wd_rj:${id}`).row()
    .text('🔙 Назад', 'a_wd')
};

// ==========================================
// 6. БОТ И ЗАПУСК
// ==========================================
const bot = new Bot(CONFIG.BOT_TOKEN);

async function startBotSafely() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});
    await sleep(2000);
    await bot.start({ 
      onStart: () => console.log(`✅ @${bot.botInfo?.username || 'bot'} запущен | RAM: ${Math.round(process.memoryUsage().rss/1024/1024)}MB`),
      drop_pending_updates: true, timeout: 10,
      onError: (err) => { console.error('⚠️ Runtime:', err.message); return true; }
    });
  } catch (err) {
    if (err?.error_code === 409) { console.error('❌ 409 Conflict. Остановите дубликаты.'); process.exit(1); }
    else if (err?.error_code === 401) { console.error('❌ Неверный токен.'); process.exit(1); }
    else { console.error('❌ Startup:', err.message); process.exit(1); }
  }
}

// /START
bot.command('start', async (ctx) => await requireSub(ctx, async () => {
  const uid = ctx.from.id; const uName = ctx.from.username; const fName = ctx.from.first_name || 'Участник';
  const refMatch = (ctx.message?.text||'').match(/ref_(\d+)/);
  let refId = refMatch ? parseInt(refMatch[1],10) : null;
  if (refId === uid) refId = null;

  let user = getUser(uid);
  if (!user) {
    user = { id: uid, username: uName, first_name: fName, balance: 0, referrer_id: refId||null, pending_referral_id: refId||null, banned: false, totalEarned: 0, totalSpent: 0, created_at: Date.now(), lastActive: Date.now(), referral_count: 0, referral_list: [] };
    db.users[String(uid)] = user; saveDB();

    if (refId) {
      const ref = getUser(refId);
      if (ref) {
        ref.referral_count = (ref.referral_count || 0) + 1;
        const list = ref.referral_list || []; if (!list.includes(uid)) list.push(uid);
        ref.referral_list = list.length > 50 ? list.slice(-50) : list;
        db.users[String(refId)] = ref; saveDB();
        try { await bot.api.sendMessage(refId, `🔔 <b>Новый переход!</b>\n👤 @${uName || uid}\n💰 Бонус начислится, когда реферал откроет профиль.`, { parse_mode: 'HTML' }); } catch {}
      }
    }
    return ctx.reply(`🌟 <b>Добро пожаловать в GRAM!</b>\n\n💰 Баланс: <code>${fmt(0)}</code>\n🔗 Ссылка:\n<code>https://t.me/${ctx.me.username}?start=ref_${uid}`, { reply_markup: kb.main(isAdmin(uid)), parse_mode: 'HTML' });
  } else {
    user.username = uName; user.first_name = fName; db.users[String(uid)] = user; saveDB();
    return ctx.reply(`👋 <b>С возвращением!</b>`, { reply_markup: kb.main(isAdmin(uid)), parse_mode: 'HTML' });
  }
}));

// ПРОВЕРКА
bot.callbackQuery('check_sponsors', async (ctx) => {
  await ack(ctx);
  await requireSub(ctx, async () => {
    await ctx.editMessageText(`✅ <b>Подписка подтверждена!</b>\n🎉 Доступ открыт.`, {parse_mode:'HTML'});
    await ctx.reply(`👋 <b>Меню:</b>`, {reply_markup: kb.main(isAdmin(ctx.from.id)), parse_mode:'HTML'});
  });
});

// ОБЁРТКА ЭКРАНОВ
const wrap = (id, fn) => bot.callbackQuery(id, async ctx => await requireSub(ctx, async () => {
  await ack(ctx); const u = getUser(ctx.from.id);
  if(!u) return ctx.answerCallbackQuery({text:'⚠️ /start',show_alert:true});
  try { await fn(ctx, u); } catch { await ctx.reply('⚠️ Ошибка.', {reply_markup:kb.main(isAdmin(u.id)),parse_mode:'HTML'}); }
}));

// ПРОФИЛЬ + РЕФЕРАЛ
bot.callbackQuery('p_profile', async ctx => await requireSub(ctx, async () => {
  await ack(ctx);
  const uid = ctx.from.id; const u = getUser(uid);
  if(!u) return ctx.answerCallbackQuery({text:'⚠️ Сначала /start',show_alert:true});

  if (u.pending_referral_id) {
    const ref = getUser(u.pending_referral_id);
    if (ref) {
      console.log(`💰 Выплата: ${ref.id} <- ${uid} | ${db.settings.refReward}`);
      adjustBalance(ref.id, db.settings.refReward, 'referral_approved', `Реферал @${u.username||uid} открыл профиль`);
      try { await bot.api.sendMessage(ref.id, `✅ <b>Реферал активирован!</b>\n💰 Начислено: <b>${fmt(db.settings.refReward)}</b>`, { parse_mode: 'HTML' }); } catch {}
    }
    u.pending_referral_id = null;
    db.users[String(uid)] = u; saveDB();
  }

  const txt = `👤 <b>Профиль</b>\n\n🆔 <code>${u.id}</code>\n💰 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n👥 Рефералов: <b>${u.referral_count||0}</b>`;
  return safeEdit(ctx, txt, kb.back());
}));

// ОСТАЛЬНЫЕ ЭКРАНЫ
wrap('p_main', (ctx, u) => safeEdit(ctx, `🌟 <b>Главное меню</b>\n💰 <code>${fmt(u.balance)}</code>\n🔗 <code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>`, kb.main(isAdmin(u.id))));
wrap('p_balance', (ctx, u) => safeEdit(ctx, `💰 <b>Финансы</b>\n📊 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n📤 Выведено: <code>${fmt(u.totalSpent)}</code>`, kb.back()));
wrap('p_ref', (ctx, u) => {
  const list = (u.referral_list||[]).slice(0,10).map((id,i)=>{const r=getUser(id);return `${i+1}. ${r?.username?`@${r.username}`:`ID ${id}`} (${fmt(r?.balance||0)})`}).join('\n') || '📭 <i>Пока нет.</i>';
  return safeEdit(ctx, `👥 <b>Рефералы</b>\n🔹 Всего: <b>${u.referral_count||0}</b>\n\n📋 Последние:\n${list}`, kb.back());
});
wrap('p_stats', (ctx) => { const st=getStats(); return safeEdit(ctx, `📊 <b>Статистика</b>\n👥 ${st.total}\n💰 ${fmt(st.balance)}\n🤝 ${st.totalRefs}`, kb.back()); });
wrap('p_history', (ctx) => {
  const t=db.transactions.filter(x=>x.user_id===ctx.from.id).slice(-8).reverse();
  const m=t.length?t.map(x=>`▫️ <code>${x.type}</code> | <b>${x.amount>0?'+':''}${fmt(x.amount)}</b>`).join('\n'):'📭 Пусто.';
  return safeEdit(ctx, `📜 <b>История</b>\n\n${m}`, kb.back());
});
wrap('p_withdraw', (ctx, u) => {
  if(u.balance<db.settings.minWithdraw) return safeEdit(ctx, `💸 Мин: <code>${fmt(db.settings.minWithdraw)}</code>`, kb.back());
  userStates.set(ctx.from.id,{act:'wd'}); 
  return safeEdit(ctx, `📤 Введите сумму (мин. <code>${fmt(db.settings.minWithdraw)}</code>):`, new InlineKeyboard().text('💸 Ввести', 'p_wd_input').row().text('🔙 Назад','p_main'));
});
bot.callbackQuery('p_wd_input', async ctx => { await ack(ctx); userStates.set(ctx.from.id,{act:'wd'}); return ctx.editMessageText(`📤 Введите сумму:`, {reply_markup:new InlineKeyboard().text('❌ Отмена','p_main'),parse_mode:'HTML'}); });

// АДМИНКА
bot.callbackQuery('a_main', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return ctx.answerCallbackQuery({text:'🔒',show_alert:true}); return safeEdit(ctx, `🛠 <b>Админ</b>\n👥 ${getStats().total} | 💎 ${fmt(getStats().balance)}`, kb.adminMain()); });
['a_main','a_close'].forEach(id=>{ bot.callbackQuery(id, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.delete(ctx.from.id); if(id==='a_close')return safeEdit(ctx,'✅ Закрыто.',kb.main()); return safeEdit(ctx, `🛠 <b>Админ</b>`, kb.adminMain()); }); });
bot.callbackQuery('a_search', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'search'}); return ctx.editMessageText('🔍 Введите ID:', {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery('a_wd', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const p=getPendingWithdrawals(); return safeEdit(ctx, p.length?`📋 Заявки: ${p.length}`:'📭 Нет заявок.', p.length?kb.adminMain():kb.backAdmin()); });
bot.callbackQuery('a_broadcast', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'brd'}); return ctx.editMessageText('📢 Отправьте текст. /admin отмена.', {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery('a_settings', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'set_ref'}); return safeEdit(ctx, `⚙️ Награда: <b>${fmt(db.settings.refReward)}</b>\nВведите новое:`, kb.backAdmin()); });

const openAdminUser = async (ctx, uid) => {
  const u = getUser(uid); if(!u) return ctx.editMessageText(`❌ Не найден`, {parse_mode:'HTML'});
  const refs = (u.referral_list||[]).map((rid,i)=>{const r=getUser(rid);return `${i+1}. <code>${rid}</code> | ${r?.username?`@${r.username}`:'без ника'} | 💰${fmt(r?.balance||0)}`}).join('\n') || '📭 Нет.';
  return safeEdit(ctx, `📊 <b>#${u.id}</b>\n💰 ${fmt(u.balance)} | 👥 ${u.referral_count||0} | 🚫 ${u.banned?'Бан':'Активен'}\n\n👥 Рефералы:\n${refs}`, kb.adminUser(u.id));
};

bot.callbackQuery('a_users', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const list=Object.values(db.users).slice(0,15).map((u,i)=>`${i+1}. <code>${u.id}</code> | ${u.username?`@${u.username}`:'Без ника'}`).join('\n')||'📭'; return safeEdit(ctx, `👥 Юзеры\n\n${list}`, kb.backAdmin()); });
bot.callbackQuery(/^a_wd_view:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const id=parseInt(ctx.match[1],10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return ctx.answerCallbackQuery({text:'❌',show_alert:true}); const u=getUser(wd.user_id); if(!u)return ctx.answerCallbackQuery({text:'❌',show_alert:true}); return safeEdit(ctx, `📤 #${id}\n💰 ${fmt(wd.amount)}\n👤 ${u.first_name} (@${u.username||u.id})`, kb.adminWd(id)); });
bot.callbackQuery(/^a_wd_(ap|rj):(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const [,act,idStr]=ctx.match; const id=parseInt(idStr,10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return ctx.answerCallbackQuery({text:'❌',show_alert:true}); if(act==='ap'){wd.status='approved';wd.comment='Одобрено';}else{wd.status='rejected';wd.comment='Отклонено';adjustBalance(wd.user_id,wd.amount,'wd_return',`Возврат #${id}`);}saveDB(); try{await bot.api.sendMessage(wd.user_id,`💰 #${id} ${act==='ap'?'✅':'❌'}`,{parse_mode:'HTML'});}catch{} return ctx.editMessageText(`✅ #${id} обработана.`, {reply_markup:kb.adminMain(),parse_mode:'HTML'}); });

bot.callbackQuery(/^a_bal:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:`a_bal:${ctx.match[1]}`}); return ctx.editMessageText(`💰 Сумма (+/-):`, {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery(/^a_ban:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const u=getUser(parseInt(ctx.match[1],10)); if(!u)return ctx.answerCallbackQuery({text:'❌',show_alert:true}); u.banned=!u.banned; db.users[String(u.id)]=u; saveDB(); await ctx.answerCallbackQuery({text:u.banned?'🚫 Бан':'✅ Разбан',show_alert:true}); return openAdminUser(ctx, u.id); });

// ТЕКСТ
bot.on('message:text', async ctx => {
  const uid=ctx.from.id; const txt=ctx.message.text.trim(); const st=userStates.get(uid);
  if(st?.act==='wd'){ 
    const u=getUser(uid); const amt=parseFloat(txt.replace(/\s/g,'')); 
    if(isNaN(amt)||amt<db.settings.minWithdraw||amt>u.balance) return ctx.reply(`❌ Мин: <code>${fmt(db.settings.minWithdraw)}</code>`,{reply_markup:kb.main(isAdmin(uid)),parse_mode:'HTML'}); 
    const id=db.nextWdId++; db.withdrawals[id]={id,user_id:uid,amount:amt,status:'pending',comment:'',created_at:Date.now()}; 
    adjustBalance(uid,-amt,'wd_pending',`Заявка #${id}`); userStates.delete(uid); saveDB(); 
    return ctx.reply(`✅ #${id} создана`,{reply_markup:kb.main(isAdmin(uid)),parse_mode:'HTML'}); 
  }
  if(!isAdmin(uid)) return;
  if(txt==='/admin'){userStates.delete(uid); return ctx.editMessageText(`🛠 <b>Админ</b>`, kb.adminMain()); }
  if(!st) return;
  if(st.act==='search'){const id=parseInt(txt,10); if(isNaN(id)||!getUser(id))return ctx.reply('❌ Не найден',{parse_mode:'HTML'}); userStates.delete(uid); return openAdminUser(ctx,id); }
  if(st.act==='set_ref'){const val=parseFloat(txt.replace(/\s/g,'')); if(isNaN(val)||val<0)return ctx.reply('❌ >= 0',{parse_mode:'HTML'}); db.settings.refReward=val; saveDB(); userStates.delete(uid); return ctx.reply(`✅ Награда: <code>${fmt(val)}</code>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
  if(st.act==='brd'){const users=Object.values(db.users); const msg=await ctx.reply(`📢 Рассылка... (${users.length})`,{parse_mode:'HTML'}); let s=0,f=0,b=0; for(let i=0;i<users.length;i++){try{await ctx.copyMessage(users[i].id);s++;}catch(e){e.description?.includes('blocked')?b++:f++;}if((i+1)%50===0)await ctx.api.editMessageText(msg.chat.id,msg.message_id,`📤 ${Math.round(((i+1)/users.length)*100)}% | ✅${s} ❌${f} 🚫${b}`,{parse_mode:'HTML'});await sleep(200);} userStates.delete(uid); await ctx.api.editMessageText(msg.chat.id,msg.message_id,`✅ Готово: ✅${s} ❌${f} 🚫${b}`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); return; }
  if(/^a_bal:(\d+)$/.test(st.act)){const uidT=parseInt(st.act.split(':')[1],10); const amt=parseFloat(txt.replace(/\s/g,'')); if(isNaN(amt))return ctx.reply('❌ Число',{parse_mode:'HTML'}); adjustBalance(uidT,amt,'adm_balance',`Админ ${uid}`); userStates.delete(uid); const u=getUser(uidT); return ctx.reply(`✅ +${fmt(amt)}\n💰 <code>${fmt(u.balance)}</code>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
});

bot.catch((err, ctx) => { console.error(`❌ [Global] ${err.message}`); if(ctx) ctx.reply('⚠️ Ошибка.', { parse_mode: 'HTML' }).catch(()=>{}); });

console.log('🚀 Запуск...');
loadDB().then(() => startBotSafely()).catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
