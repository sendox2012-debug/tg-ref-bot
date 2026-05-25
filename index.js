const { Bot, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  BOT_TOKEN: '8530248644:AAHPg98XFrHtz0_ZDilhtIfPJYq7W6lLlDg',
  ADMIN_IDS: [7295281658, 5137860558],
  DB_PATH: './data.json',
  PIARFLOW_API_KEY: '-Fw-JokBjo-mmNfQsDyt82ZsKUXzSkE7',
  PIARFLOW_BASE_URL: 'https://piarflow.ru/v1'
};

// ==========================================
// 2. ЛЁГКАЯ АСИНХРОННАЯ БД
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
  db.transactions = (db.transactions || []).slice(-1000);
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
    } catch (e) { console.error('❌ DB Save Error:', e.message); }
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
  if (db.transactions.length > 1000) db.transactions = db.transactions.slice(-900);
  saveDB();
  return user;
};

const getPendingWithdrawals = () => Object.values(db.withdrawals).filter(w => w.status === 'pending').sort((a,b) => a.created_at - b.created_at);
const getStats = () => {
  const users = Object.values(db.users);
  return { total: users.length, balance: users.reduce((s,u) => s + (u.balance||0), 0), pending: getPendingWithdrawals().length };
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
    if (!res.ok) throw new Error(`API ${res.status}`);
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
// 4. УТИЛИТЫ
// ==========================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = v => `${parseFloat(v||0).toLocaleString('ru-RU')} GRAM`;
const isAdmin = id => CONFIG.ADMIN_IDS.map(String).includes(String(id));
const adminState = new Map();

const safeEdit = async (ctx, text, markup) => { 
  try { await ctx.editMessageText(text, { reply_markup: markup, parse_mode: 'HTML' }); } 
  catch { await ctx.reply(text, { reply_markup: markup, parse_mode: 'HTML' }); } 
};
const ack = async ctx => { try { await ctx.answerCallbackQuery(); } catch {} };

const kb = {
  main: () => new InlineKeyboard()
    .text('📊 Мой баланс','m_bal').text('📊 Статистика','m_stat').row()
    .text('👥 Мои рефералы','m_ref').text('💸 Вывод средств','m_wd').row()
    .text('📜 История операций','m_hist').row().text('🔐 Админ-панель','a_open'),
  back: () => new InlineKeyboard().text('🔙 Вернуться в главное меню','m_main'),
  sponsors: list => {
    const k = new InlineKeyboard();
    list.forEach((s, i) => k.url(`📢 Канал ${i+1}`, s.link).row());
    return k.text('✅ Я выполнил все условия','check_sponsors').row();
  },
  subs: chats => {
    const k = new InlineKeyboard();
    chats.forEach((c,i) => k.url(`📢 ${i+1}`, c.startsWith('-100') ? `https://t.me/c/${c.slice(4)}` : `https://t.me/${c.replace(/^@/,'')}`).row());
    return k.text('✅ Я подписался','check_subs').row();
  },
  adm: () => new InlineKeyboard()
    .text('🔍 Поиск пользователя','a_search').text('💰 Управление балансом','adm_bal').row()
    .text('🔄 Заявки на вывод','a_wd').text('📢 Массовая рассылка','a_brd').row()
    .text('⛓️ Обязательные каналы','a_subs').text('⚙️ Настройки бота','adm_set').row()
    .text('❌ Закрыть панель','a_close'),
  wdList: list => {
    const k = new InlineKeyboard();
    list.slice(0,10).forEach(w => k.text(`📋 #${w.id} | ${fmt(w.amount)}`, `wd_view_${w.id}`).row());
    if(list.length>10) k.text('📄 Показать следующие','a_wd_more').row();
    return k.text('🔙 В главное меню','a_main').row();
  },
  subsM: () => new InlineKeyboard()
    .text('➕ Добавить канал','a_sub_add').text('➖ Удалить канал','a_sub_del').row()
    .text('🔄 Проверить статус','a_sub_chk').text('🔙 Назад в настройки','a_main')
};

// ==========================================
// 5. БОТ
// ==========================================
const bot = new Bot(CONFIG.BOT_TOKEN);

async function startBotSafely() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(()=>{});
    await sleep(2000);
    await bot.start({ 
      onStart: () => console.log(`✅ @${bot.botInfo?.username || 'bot'} запущен | RAM: ${Math.round(process.memoryUsage().rss/1024/1024)}MB`),
      drop_pending_updates: true,
      timeout: 10,
      onError: (err) => { console.error('⚠️ Runtime:', err.message); return true; }
    });
  } catch (err) {
    if (err?.error_code === 409) { console.error('❌ 409 Conflict. Остановите дубликаты.'); process.exit(1); }
    else if (err?.error_code === 401) { console.error('❌ Неверный токен.'); process.exit(1); }
    else { console.error('❌ Startup:', err.message); process.exit(1); }
  }
}

bot.command('start', async (ctx) => {
  const uid = ctx.from.id; const uName = ctx.from.username; const fName = ctx.from.first_name || 'Участник';
  const refMatch = (ctx.message?.text||'').match(/ref_(\d+)/);
  let refId = refMatch ? parseInt(refMatch[1],10) : null;
  if (refId && refId === uid) refId = null;

  let user = getUser(uid);
  const isNew = !user;
  const refLink = `https://t.me/${ctx.me.username}?start=ref_${uid}`;

  if (isNew) {
    user = { id: uid, username: uName, first_name: fName, balance: 0, referrer_id: refId||null, pending_referral_id: refId, banned: false, totalEarned: 0, totalSpent: 0, created_at: Date.now(), lastActive: Date.now(), referral_count: 0, referral_list: [] };
    setUser(user);
    if (refId) {
      const ref = getUser(refId);
      if (ref) {
        ref.referral_count++;
        if(!ref.referral_list.includes(uid)) ref.referral_list.push(uid);
        if(ref.referral_list.length > 50) ref.referral_list.shift();
        setUser(ref);
        await ctx.reply(`✅ <b>Реферальная ссылка активирована!</b>\n\n<i>Вы перешли по приглашению от @${ref.username || `ID ${ref.id}`}.\nПосле выполнения обязательных условий на его баланс будет начислен бонус.</i>`, { parse_mode: 'HTML' });
      }
    }
  } else {
    user.username = uName; user.first_name = fName; setUser(user);
    await ctx.reply(`👋 <b>С возвращением, ${user.first_name}!</b>\n\n<i>Ваш профиль синхронизирован.</i>`, { reply_markup: kb.main(), parse_mode: 'HTML' });
    return;
  }

  const mainTxt = `🌟 <b>Добро пожаловать в экосистему GRAM!</b>\n\n<i>Вы успешно подключились к системе автоматизированного заработка внутренней валюты.</i>\n\n━━━━━━━━━━━━━━━━━━━━\n📊 <b>Ваш финансовый профиль:</b>\n💰 Текущий баланс: <code>${fmt(user.balance)}</code>\n📈 Всего начислено: <code>${fmt(user.totalEarned)}</code>\n📤 Всего выведено: <code>${fmt(user.totalSpent)}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n🎁 <b>Реферальная программа:</b>\nПриглашайте друзей и получайте <b>${fmt(db.settings.refReward)}</b> за каждого активного участника.\n\n🔗 <b>Ваша персональная ссылка:</b>\n<code>${refLink}</code>`;

  const sponsors = pf.enabled() ? await pf.getSponsors(uid, ctx.chat.id) : null;
  if (sponsors?.length) {
    return ctx.reply(`🔒 <b>Доступ ограничен</b>\n\n📋 Активные задания (${sponsors.length}):\n${sponsors.map((s,i)=>`🔹 ${i+1}. ${s.link}`).join('\n')}\n\n⏳ <i>После подписки нажмите кнопку проверки ниже.</i>`, { reply_markup: kb.sponsors(sponsors), parse_mode: 'HTML' });
  }
  if (db.settings.REQUIRED_CHATS?.length > 0) {
    return ctx.reply(`🔒 <b>Доступ ограничен</b>\n\n<i>Подпишитесь на официальные каналы.</i>`, { reply_markup: kb.subs(db.settings.REQUIRED_CHATS), parse_mode: 'HTML' });
  }
  return ctx.reply(mainTxt, { reply_markup: kb.main(), parse_mode: 'HTML' });
});

bot.callbackQuery('check_sponsors', async ctx => {
  await ack(ctx);
  const uid = ctx.from.id;
  const sponsors = await pf.getSponsors(uid, ctx.chat.id);
  if (!sponsors?.length) return ctx.editMessageText(`⚠️ <b>Задания отсутствуют</b>\n\n<i>Вам открыт полный доступ.</i>`, { parse_mode: 'HTML' });
  const results = await pf.checkSponsors(uid, sponsors.map(s => s.link));
  if (!results) return ctx.editMessageText(`❌ <b>Ошибка проверки</b>\n\n<i>Попробуйте через минуту.</i>`, { parse_mode: 'HTML' });
  if (results.every(r => r.status === 'subscribed')) {
    const user = getUser(uid);
    if (user.pending_referral_id) {
      const ref = getUser(user.pending_referral_id);
      if (ref) {
        adjustBalance(ref.id, db.settings.refReward, 'referral_approved', `Реферал @${user.username||uid} выполнил условия`);
        try { await bot.api.sendMessage(ref.id, `🎉 <b>Реферал активирован!</b>\n💰 Начислено: <code>${fmt(db.settings.refReward)}</code>`, {parse_mode:'HTML'}); } catch {}
      }
      user.pending_referral_id = null; setUser(user);
    }
    await ctx.editMessageText(`✅ <b>Подписки подтверждены!</b>\n🎉 <i>Доступ открыт.</i>`, { parse_mode: 'HTML' });
    return ctx.reply(`👋 <b>Главное меню:</b>`, { reply_markup: kb.main(), parse_mode: 'HTML' });
  }
  await ctx.editMessageText(`⛔ <b>Не все подписки найдены</b>\n<i>Проверьте и нажмите снова.</i>`, { parse_mode: 'HTML' });
});

bot.callbackQuery('check_subs', async ctx => {
  await ack(ctx);
  let ok = true;
  for (const c of db.settings.REQUIRED_CHATS || []) { try { const m = await ctx.api.getChatMember(c.startsWith('-100')?parseInt(c,10):c.replace(/^@/,''), ctx.from.id); if(!['member','administrator','creator'].includes(m.status)) ok=false; } catch { ok=false; } }
  if (ok) { await ctx.editMessageText(`✅ <b>Доступ открыт!</b>`, { parse_mode: 'HTML' }).catch(()=>{}); await ctx.reply(`👋 <b>Меню:</b>`,{reply_markup:kb.main(), parse_mode: 'HTML'}); } 
  else { await ctx.editMessageText(`⛔ <b>Подписка не обнаружена</b>`, { parse_mode: 'HTML' }); }
});

const menuHandlers = {
  'm_main': (ctx, u) => safeEdit(ctx, `🌟 <b>Главное меню</b>\n\n💰 Баланс: <code>${fmt(u.balance)}</code>\n🔗 Ваша ссылка:\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>`, kb.main()),
  'm_bal': (ctx, u) => safeEdit(ctx, `💰 <b>Финансы</b>\n\n📊 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n📤 Выведено: <code>${fmt(u.totalSpent)}</code>`, kb.back()),
  'm_stat': (ctx) => safeEdit(ctx, `🌍 <b>Статистика</b>\n\n👥 Участников: <b>${getStats().total}</b>\n💎 В обороте: <b>${fmt(getStats().balance)}</b>\n🔄 Заявок: <b>${getStats().pending}</b>`, kb.back()),
  'm_ref': (ctx, u) => {
    const list = (u.referral_list || []).slice(0, 10).map((id, i) => { const r = getUser(id); return `${i+1}. ${r?.username ? `@${r.username}` : `ID ${id}`}`; }).join('\n') || '📭 <i>Пока нет.</i>';
    safeEdit(ctx, `👥 <b>Рефералы</b>\n\n🔹 Всего: <b>${u.referral_count||0}</b>\n💰 Награда: <b>${fmt(db.settings.refReward)}</b>\n\n📋 Последние:\n${list}\n\n🔗 Ссылка:\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>`, kb.back());
  },
  'm_wd': (ctx, u) => {
    if(u.balance<db.settings.minWithdraw) return safeEdit(ctx, `💸 <b>Лимит не достигнут</b>\n\n❌ Мин: <code>${fmt(db.settings.minWithdraw)}</code>\n📊 Ваш: <code>${fmt(u.balance)}</code>`, kb.back());
    adminState.set(ctx.from.id,{act:'wd'}); safeEdit(ctx, `📤 <b>Вывод</b>\n\n💰 Введите сумму (мин. <code>${fmt(db.settings.minWithdraw)}</code>):`, kb.back());
  },
  'm_hist': (ctx) => {
    const t=db.transactions.filter(x=>x.user_id===ctx.from.id).slice(-8).reverse();
    const m=t.length?t.map(x=>`▫️ <code>${x.type}</code> | <b>${x.amount>0?'+':''}${fmt(x.amount)}</b>\n   <i>${x.desc}</i>`).join('\n\n'):'📭 <i>История пуста.</i>';
    safeEdit(ctx, `📜 <b>История</b>\n\n${m}`, kb.back());
  }
};
Object.entries(menuHandlers).forEach(([id, fn]) => {
  bot.callbackQuery(id, async ctx => { ack(ctx); const u=getUser(ctx.from.id); if(!u) return ctx.answerCallbackQuery({text:'⚠️ Сначала /start',show_alert:true}); try { await fn(ctx, u); } catch { await ctx.reply('⚠️ Ошибка.', {reply_markup:kb.main(), parse_mode: 'HTML'}); } });
});

bot.callbackQuery('a_open', async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({text:'🔒',show_alert:true}); safeEdit(ctx, `🛠 <b>Админ-панель</b>\n\n👥 ${getStats().total} | 💎 ${fmt(getStats().balance)}\n🔄 Заявок: ${getPendingWithdrawals().length}`, kb.adm()); });
bot.command('admin', async ctx => { if(!isAdmin(ctx.from.id)) return ctx.reply('🔒 Только админ.', { parse_mode: 'HTML' }); safeEdit(ctx, `🛠 <b>Админ-панель</b>`, kb.adm()); });
['a_main','a_close'].forEach(id=>{ bot.callbackQuery(id, async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; adminState.delete(ctx.from.id); if(id==='a_close') return safeEdit(ctx,'✅ Закрыто.',kb.main()); safeEdit(ctx, `🛠 <b>Админ</b>`, kb.adm()); }); });

const adminTextHandlers = {
  'a_search': '🔍 <b>Поиск</b>\n\n<i>Введите ID:</i>', 
  'adm_bal': '💰 <b>Баланс</b>\n\n<i>Введите ID:</i>', 
  'adm_set_ref': '🎁 <b>Награда</b>\n\n<i>Число:</i>', 
  'adm_set_min': '💸 <b>Мин. вывод</b>\n\n<i>Число:</i>',
  'a_sub_add': '📝 <b>Добавить</b>\n\n<i>@username или -100...:</i>', 
  'a_sub_del': '📝 <b>Удалить</b>\n\n<i>Точное значение:</i>'
};
Object.entries(adminTextHandlers).forEach(([id, prompt]) => {
  bot.callbackQuery(id, async ctx => { 
    ack(ctx); if(!isAdmin(ctx.from.id)) return; 
    const act = id.includes('search')?'search':id.includes('bal')?'adm_bal_id':id.includes('sub_add')?'sub_add':id.includes('sub_del')?'sub_del':id.includes('set_ref')?'set_ref':id.includes('set_min')?'set_min':id;
    adminState.set(ctx.from.id, {act}); 
    safeEdit(ctx, prompt, new InlineKeyboard().text('🔙 Отмена','a_main')); 
  });
});

bot.callbackQuery('a_wd', async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; const p=getPendingWithdrawals(); safeEdit(ctx, p.length?`📋 <b>Заявки</b>\n🔹 ${p.length}`:'📭 <b>Нет заявок</b>', p.length?kb.wdList(p):kb.adm()); });
bot.callbackQuery('a_brd', async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; adminState.set(ctx.from.id,{act:'brd'}); safeEdit(ctx,'📢 <b>Рассылка</b>\n\n<i>Отправьте текст/фото. /admin для отмены.</i>', new InlineKeyboard().text('🔙 Отмена','a_main')); });
bot.callbackQuery('a_subs', async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; const chs = db.settings.REQUIRED_CHATS || []; safeEdit(ctx,`⛓️ <b>Каналы</b>\n\n${chs.length ? chs.map((c,i)=>`🔹 ${i+1}. <code>${c}</code>`).join('\n') : '📭 <i>Пусто.</i>'}`,kb.subsM()); });
bot.callbackQuery('a_sub_chk', async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; let v=0,i=0; const chs = db.settings.REQUIRED_CHATS || []; for(const c of chs){try{await ctx.api.getChat(c.startsWith('-100')?parseInt(c,10):c.replace(/^@/,''));v++;}catch{i++;}} safeEdit(ctx,`✅ <b>Проверка</b>\n🟢 ${v} | 🔴 ${i}`,kb.subsM()); });
bot.callbackQuery('adm_set', async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; safeEdit(ctx, `⚙️ <b>Настройки</b>\n🎁 ${fmt(db.settings.refReward)} | 💸 ${fmt(db.settings.minWithdraw)}`, new InlineKeyboard().text('🔄 Награда','adm_set_ref').text('🔄 Мин. вывод','adm_set_min').row().text('🔙 Назад','a_main')); });

bot.callbackQuery(/^adm_bal_card_(\d+)$/, async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; adminState.set(ctx.from.id,{act:'adm_bal_amount',targetUid:parseInt(ctx.match[1],10)}); const u = getUser(parseInt(ctx.match[1],10)); safeEdit(ctx, `💰 <b>Изменение</b>\n👤 <code>${u?.username || u?.id}</code>\n💰 Текущий: <code>${fmt(u?.balance||0)}</code>\n\n<i>+ начислить, - снять:</i>`, new InlineKeyboard().text('🔙 Отмена','a_main')); });
bot.callbackQuery(/^adm_(unban|ban)_(\d+)$/, async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; const uid=parseInt(ctx.match[2],10); const u=getUser(uid); if(!u) return ctx.answerCallbackQuery({text:'❌',show_alert:true}); u.banned=ctx.match[1]==='unban'?false:true; setUser(u); await ctx.answerCallbackQuery({text:u.banned?'🚫 Забанен':'✅ Разбанен',show_alert:true}); return ctx.editMessageText(`👤 <code>${u.id}</code> | 💰 ${fmt(u.balance)} | 👥 ${u.referral_count||0} | ${u.banned?'🔴':'🟢'}`, new InlineKeyboard().text(u.banned?'✅ Разбанить':'🚫 Забанить',u.banned?`adm_unban_${uid}`:`adm_ban_${uid}`).row().text('💰 Баланс',`adm_bal_card_${uid}`).row().text('🔙 Назад','a_search')); });
bot.callbackQuery(/^wd_view_(\d+)$/, async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; const id=parseInt(ctx.match[1],10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending') return ctx.answerCallbackQuery({text:'❌',show_alert:true}); const u=getUser(wd.user_id); if(!u) return ctx.answerCallbackQuery({text:'❌',show_alert:true}); safeEdit(ctx, `📤 <b>Заявка #${id}</b>\n💰 ${fmt(wd.amount)}\n👤 @${u.username||u.id} | 💰 ${fmt(u.balance)}`, new InlineKeyboard().text('✅ Одобрить',`wd_ap_${id}`).text('❌ Отклонить',`wd_rj_${id}`).row().text('🔙 Назад','a_wd')); });
bot.callbackQuery(/^(wd_ap|wd_rj)_(\d+)$/, async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; const [,act,idStr]=ctx.match; const id=parseInt(idStr,10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending') return ctx.answerCallbackQuery({text:'❌',show_alert:true}); if(act==='wd_ap'){wd.status='approved';wd.comment='Одобрено';}else{wd.status='rejected';wd.comment='Отклонено';adjustBalance(wd.user_id,wd.amount,'wd_return',`Возврат #${id}`);} saveDB(); try{await bot.api.sendMessage(wd.user_id,`💰 Заявка #${id} ${act==='wd_ap'?'✅ одобрена':'❌ отклонена'}.\n${wd.comment}`,{parse_mode:'HTML'});}catch{} const p=getPendingWithdrawals(); safeEdit(ctx,`✅ #${id} обработана. Осталось: ${p.length}`, p.length?kb.wdList(p):kb.adm()); });
['a_wd_more','a_wd_prev'].forEach(id=>{ bot.callbackQuery(id, async ctx => { ack(ctx); if(!isAdmin(ctx.from.id)) return; const st=adminState.get(ctx.from.id)||{}; st.page=id==='a_wd_more'?(st.page||0)+1:Math.max(0,(st.page||0)-1); adminState.set(ctx.from.id,st); const p=getPendingWithdrawals(); const items=p.slice(st.page*10,st.page*10+10); const k=new InlineKeyboard(); items.forEach(w=>k.text(`📋 #${w.id}`,`wd_view_${w.id}`).row()); if(p.length>(st.page+1)*10)k.text('📄 Далее','a_wd_more').row(); if(st.page>0)k.text('📄 Назад','a_wd_prev').row(); k.text('🔙 Меню','a_main').row(); safeEdit(ctx,`📋 <b>Стр. ${st.page+1}</b>`,k); }); });

bot.on('message:text', async ctx => {
  const uid=ctx.from.id; const txt=ctx.message.text.trim(); const st=adminState.get(uid);
  if(st?.act==='wd'){ const u=getUser(uid); const amt=parseFloat(txt.replace(/\s/g,'')); if(isNaN(amt)||amt<db.settings.minWithdraw||amt>u.balance) return ctx.reply(`❌ <b>Ошибка</b>\n\nМин: <code>${fmt(db.settings.minWithdraw)}</code>`,{reply_markup:kb.main(), parse_mode: 'HTML'}); const id=db.nextWdId++; db.withdrawals[id]={id,user_id:uid,amount:amt,status:'pending',comment:'',created_at:Date.now()}; adjustBalance(uid,-amt,'wd_pending',`Заявка #${id}`); adminState.delete(uid); saveDB(); return ctx.reply(`✅ <b>Заявка #${id} создана</b>\n💰 <code>${fmt(amt)}</code>`,{reply_markup:kb.main(), parse_mode: 'HTML'}); }
  if(!isAdmin(uid)) return;
  if(txt==='/admin'){adminState.delete(uid); return ctx.reply('✅ <b>Закрыто.</b>',{reply_markup:kb.adm(), parse_mode: 'HTML'}); }
  if(!st) return;
  if(st.act==='search'){const id=parseInt(txt,10); if(isNaN(id)||!getUser(id))return ctx.reply('❌ <b>Не найден</b>', { parse_mode: 'HTML' }); const u=getUser(id); adminState.delete(uid); return ctx.reply(`👤 <code>${u.id}</code> | 💰 ${fmt(u.balance)} | 👥 ${u.referral_count||0}`, new InlineKeyboard().text(u.banned?'✅ Разбан':'🚫 Бан',u.banned?`adm_unban_${id}`:`adm_ban_${id}`).row().text('💰',`adm_bal_card_${id}`).row().text('🔙','a_search'), { parse_mode: 'HTML' }); }
  if(st.act==='adm_bal_id'){const id=parseInt(txt,10); if(isNaN(id)||!getUser(id))return ctx.reply('❌ <b>Не найден</b>', { parse_mode: 'HTML' }); adminState.set(uid,{act:'adm_bal_amount',targetUid:id}); return ctx.reply(`💰 <b>Сумма:</b>\n<i>+ начислить, - снять</i>`,{reply_markup:new InlineKeyboard().text('❌ Отмена','a_main'), parse_mode: 'HTML'}); }
  if(st.act==='adm_bal_amount'){const amt=parseFloat(txt.replace(/\s/g,'')); if(isNaN(amt))return ctx.reply('❌ <b>Введите число</b>', { parse_mode: 'HTML' }); adjustBalance(st.targetUid,amt,'adm_balance',`Админ ${uid}`); adminState.delete(uid); const u=getUser(st.targetUid); return ctx.reply(`✅ <b>Изменено на ${amt>0?'+':''}${fmt(amt)}</b>\n💰 Новый: <code>${fmt(u.balance)}</code>`,{reply_markup:kb.adm(), parse_mode: 'HTML'}); }
  if(st.act==='brd'){const users=Object.values(db.users); const msg=await ctx.reply(`📢 <b>Рассылка</b>\n👥 ${users.length}`,{ parse_mode: 'HTML' }); let s=0,f=0,b=0; for(let i=0;i<users.length;i++){try{await ctx.copyMessage(users[i].id);s++;}catch(e){e.description?.includes('blocked')?b++:f++;}if((i+1)%50===0)await ctx.api.editMessageText(msg.chat.id,msg.message_id,`📤 ${Math.round(((i+1)/users.length)*100)}% | ✅${s} ❌${f} 🚫${b}`,{ parse_mode: 'HTML' });await sleep(250);} adminState.delete(uid); await ctx.api.editMessageText(msg.chat.id,msg.message_id,`✅ <b>Готово</b>\n✅${s} ❌${f} 🚫${b}`,{reply_markup:kb.adm(), parse_mode: 'HTML'}); return; }
  if(st.act==='sub_add'){const val=txt.replace(/\s/g,'').replace(/^@/,''); if(!val)return ctx.reply('❌ <b>Пусто</b>', { parse_mode: 'HTML' }); if((db.settings.REQUIRED_CHATS||[]).includes(val))return ctx.reply('❌ <b>Уже есть</b>', { parse_mode: 'HTML' }); if(!db.settings.REQUIRED_CHATS) db.settings.REQUIRED_CHATS=[]; db.settings.REQUIRED_CHATS.push(val); saveDB(); adminState.delete(uid); return ctx.reply(`✅ <b>Добавлено:</b> <code>${val}</code>`,{reply_markup:kb.subsM(),parse_mode:'HTML'}); }
  if(st.act==='sub_del'){const val=txt.replace(/\s/g,'').replace(/^@/,''); const idx=(db.settings.REQUIRED_CHATS||[]).indexOf(val); if(idx===-1)return ctx.reply('❌ <b>Не найдено</b>', { parse_mode: 'HTML' }); db.settings.REQUIRED_CHATS.splice(idx,1); saveDB(); adminState.delete(uid); return ctx.reply(`✅ <b>Удалено:</b> <code>${val}</code>`,{reply_markup:kb.subsM(),parse_mode:'HTML'}); }
  if(st.act==='set_ref'){const val=parseFloat(txt.replace(/\s/g,'')); if(isNaN(val)||val<0)return ctx.reply('❌ <b>Число >= 0</b>', { parse_mode: 'HTML' }); db.settings.refReward=val; saveDB(); adminState.delete(uid); return ctx.reply(`✅ <b>Награда:</b> <code>${fmt(val)}</code>`,{reply_markup:new InlineKeyboard().text('⚙️ Настройки','adm_set'),parse_mode:'HTML'}); }
  if(st.act==='set_min'){const val=parseFloat(txt.replace(/\s/g,'')); if(isNaN(val)||val<0)return ctx.reply('❌ <b>Число >= 0</b>', { parse_mode: 'HTML' }); db.settings.minWithdraw=val; saveDB(); adminState.delete(uid); return ctx.reply(`✅ <b>Мин. вывод:</b> <code>${fmt(val)}</code>`,{reply_markup:new InlineKeyboard().text('⚙️ Настройки','adm_set'),parse_mode:'HTML'}); }
});

bot.catch((err, ctx) => { console.error(`❌ [Global] ${err.message}`); if(ctx) ctx.reply('⚠️ Ошибка.', { parse_mode: 'HTML' }).catch(()=>{}); });

console.log('🚀 Запуск...');
loadDB().then(() => startBotSafely()).catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
