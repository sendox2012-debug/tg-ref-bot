const { Bot, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  BOT_TOKEN: '8530248644:AAEBHNNjdK5CrNEcjToJiYT-Y2TpNwQTFKg',
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
// 4. УТИЛИТЫ И СОСТОЯНИЯ
// ==========================================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = v => `${parseFloat(v||0).toLocaleString('ru-RU')} GRAM`;
const isAdmin = id => CONFIG.ADMIN_IDS.map(String).includes(String(id));
const userStates = new Map();

const safeEdit = async (ctx, text, kb) => {
  try { await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' }); }
  catch { await ctx.reply(text, { reply_markup: kb, parse_mode: 'HTML' }); }
};
const ack = async ctx => { try { await ctx.answerCallbackQuery(); } catch {} };

// ==========================================
// 5. КЛАВИАТУРЫ
// ==========================================
const kb = {
  main: (isAdminUser) => {
    const k = new InlineKeyboard();
    k.text('👤 Профиль', 'p_profile').text('💰 Баланс', 'p_balance').row();
    k.text('👥 Рефералы', 'p_ref').text('💸 Вывод средств', 'p_withdraw').row();
    k.text('📜 История', 'p_history').row();
    if (isAdminUser) k.text('🔐 Админ-панель', 'a_main').row();
    return k;
  },
  back: () => new InlineKeyboard().text('🔙 Главное меню', 'p_main'),
  backAdmin: () => new InlineKeyboard().text('🔙 В админку', 'a_main'),
  refList: (page, total) => new InlineKeyboard()
    .text('⬅️ Назад', `p_ref_prev:${page}`)
    .text(`📄 ${page+1}`, 'p_ref_page')
    .text('Вперёд ➡️', `p_ref_next:${page}`)
    .row().text('🔙 Главное меню', 'p_main'),
  wdAmount: () => new InlineKeyboard().text('💸 Ввести сумму', 'p_wd_input').row().text('🔙 Назад', 'p_main'),
  adminMain: () => new InlineKeyboard()
    .text('🔍 Поиск юзера', 'a_search').text('👥 Все пользователи', 'a_users').row()
    .text('📋 Заявки на вывод', 'a_wd').text('⚙️ Настройки', 'a_settings').row()
    .text('📢 Рассылка', 'a_broadcast').text('🔙 Закрыть', 'p_main'),
  adminUser: (uid) => new InlineKeyboard()
    .text('💰 Изменить баланс', `a_bal:${uid}`).row()
    .text('🚫 Забанить', `a_ban:${uid}`).text('🔙 Назад', 'a_main'),
  adminWd: (id) => new InlineKeyboard()
    .text('✅ Одобрить', `a_wd_ap:${id}`).text('❌ Отклонить', `a_wd_rj:${id}`).row()
    .text('🔙 К списку', 'a_wd')
};

// ==========================================
// 6. БОТ И ОБРАБОТЧИКИ
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

// /START & ПРОВЕРКА ПОДПИСОК
bot.command('start', async (ctx) => {
  const uid = ctx.from.id; const uName = ctx.from.username; const fName = ctx.from.first_name || 'Участник';
  const refMatch = (ctx.message?.text||'').match(/ref_(\d+)/);
  let refId = refMatch ? parseInt(refMatch[1],10) : null;
  if (refId && refId === uid) refId = null;

  let user = getUser(uid);
  if (!user) {
    user = { id: uid, username: uName, first_name: fName, balance: 0, referrer_id: refId||null, pending_referral_id: refId, banned: false, totalEarned: 0, totalSpent: 0, created_at: Date.now(), lastActive: Date.now(), referral_count: 0, referral_list: [] };
    setUser(user);
    if (refId) {
      const ref = getUser(refId);
      if (ref) { ref.referral_count++; if(!ref.referral_list.includes(uid)) ref.referral_list.push(uid); if(ref.referral_list.length>50) ref.referral_list.shift(); setUser(ref); }
    }
  } else { user.username = uName; user.first_name = fName; setUser(user); }

  const sponsors = pf.enabled() ? await pf.getSponsors(uid, ctx.chat.id) : null;
  if (sponsors?.length) {
    const txt = `🔒 <b>Доступ временно ограничен</b>\n\n<i>Для получения полного функционала необходимо подтвердить подписку на партнёрские ресурсы.</i>\n\n📋 <b>Активные задания (${sponsors.length}):</b>\n${sponsors.map((s,i)=>`🔹 ${i+1}. ${s.link}`).join('\n')}\n\n⏳ <i>После подписки нажмите кнопку проверки ниже.</i>`;
    const k = new InlineKeyboard(); sponsors.forEach(s=>k.url(`📢 Канал`, s.link).row()); k.text('✅ Я выполнил все условия', 'check_sponsors').row();
    return ctx.reply(txt, { reply_markup: k, parse_mode: 'HTML' });
  }
  if (db.settings.REQUIRED_CHATS?.length > 0) {
    const k = new InlineKeyboard(); db.settings.REQUIRED_CHATS.forEach((c,i)=>k.url(`📢 ${i+1}`, c.startsWith('-100')?`https://t.me/c/${c.slice(4)}`:`https://t.me/${c.replace(/^@/,'')}`).row()); k.text('✅ Подписался', 'check_subs').row();
    return ctx.reply(`🔒 <b>Подпишитесь на каналы</b>`, { reply_markup: k, parse_mode: 'HTML' });
  }
  return ctx.reply(`👋 <b>Добро пожаловать, ${user.first_name}!</b>`, { reply_markup: kb.main(isAdmin(uid)), parse_mode: 'HTML' });
});

// ПРОВЕРКА ПОДПИСОК
['check_sponsors', 'check_subs'].forEach(cb => {
  bot.callbackQuery(cb, async ctx => {
    await ack(ctx);
    const uid = ctx.from.id;
    let ok = false;
    if (cb === 'check_sponsors') {
      const s = await pf.getSponsors(uid, ctx.chat.id);
      if (s?.length) { const r = await pf.checkSponsors(uid, s.map(x=>x.link)); ok = r?.every(x=>x.status==='subscribed') || false; }
      else ok = true;
    } else {
      ok = true;
      for (const c of db.settings.REQUIRED_CHATS||[]) { try { const m = await ctx.api.getChatMember(c.startsWith('-100')?parseInt(c,10):c.replace(/^@/,''), uid); if(!['member','administrator','creator'].includes(m.status)) ok=false; } catch { ok=false; } }
    }
    if (ok) {
      const u = getUser(uid);
      if (u.pending_referral_id) { const ref = getUser(u.pending_referral_id); if(ref){adjustBalance(ref.id, db.settings.refReward, 'referral_approved', `Реферал @${u.username||uid}`); try{await bot.api.sendMessage(ref.id, `🎉 <b>Реферал активирован!</b>\n💰 +${fmt(db.settings.refReward)}`, {parse_mode:'HTML'});}catch{}} u.pending_referral_id=null; setUser(u); }
      await ctx.editMessageText(`✅ <b>Подписки подтверждены!</b>\n\n🎉 <i>Вам открыт полный доступ к экосистеме GRAM.\nТеперь вы можете участвовать в реферальной программе, выводить средства и отслеживать статистику в реальном времени.</i>`, {parse_mode:'HTML'});
      await ctx.reply(`👋 <b>Главное меню:</b>`, {reply_markup: kb.main(isAdmin(uid)), parse_mode:'HTML'});
    } else await ctx.editMessageText(`⛔ <b>Подписки не обнаружены</b>\n\n<i>Убедитесь, что вы действительно подписались на все каналы из списка и попробуйте нажать кнопку проверки повторно.</i>`, {parse_mode:'HTML'});
  });
});

// ГЛАВНОЕ МЕНЮ И РАЗДЕЛЫ
const screens = {
  'p_main': (ctx, u) => {
    const refLink = `https://t.me/${ctx.me.username}?start=ref_${u.id}`;
    return safeEdit(ctx, `🌟 <b>Главное меню экосистемы GRAM</b>\n\n💰 Текущий баланс: <code>${fmt(u.balance)}</code>\n📈 Всего начислено: <code>${fmt(u.totalEarned)}</code>\n📤 Всего выведено: <code>${fmt(u.totalSpent)}</code>\n\n🔗 <b>Ваша персональная ссылка:</b>\n<code>${refLink}</code>\n\n<i>💡 Выберите нужный раздел ниже для управления аккаунтом или отслеживания статистики.</i>`, kb.main(isAdmin(u.id)));
  },
  'p_profile': (ctx, u) => {
    return safeEdit(ctx, `👤 <b>Ваш профиль пользователя</b>\n\n🆔 Идентификатор: <code>${u.id}</code>\n👤 Имя: ${u.first_name} ${u.username ? `(@${u.username})` : '<i>не указано</i>'}\n📅 Регистрация: <i>${new Date(u.created_at).toLocaleString('ru-RU')}</i>\n🟢 Последняя активность: <i>${new Date(u.lastActive).toLocaleString('ru-RU')}</i>\n\n💰 <b>Финансовая сводка:</b>\n• Текущий баланс: <code>${fmt(u.balance)}</code>\n• Всего заработано: <code>${fmt(u.totalEarned)}</code>\n• Всего потрачено: <code>${fmt(u.totalSpent)}</code>\n\n👥 <b>Реферальная сеть:</b>\n• Приглашено участников: <b>${u.referral_count || 0}</b>\n• Ожидает активации: <b>${u.pending_referral_id ? '✅ 1' : '0'}</b>`, kb.back());
  },
  'p_balance': (ctx, u) => {
    return safeEdit(ctx, `💰 <b>Детальная финансовая информация</b>\n\n📊 Текущий доступный баланс:\n<code>${fmt(u.balance)}</code>\n\n📈 Всего начислено за всё время:\n<code>${fmt(u.totalEarned)}</code>\n\n📤 Всего выведено или потрачено:\n<code>${fmt(u.totalSpent)}</code>\n\n<i>🔹 Для увеличения баланса приглашайте новых участников по вашей ссылке или участвуйте в специальных акциях бота. Минимальная сумма для вывода: ${fmt(db.settings.minWithdraw)}</i>`, kb.back());
  },
  'p_ref': (ctx, u) => {
    const refs = (u.referral_list || []).slice(0, 10);
    const list = refs.length ? refs.map((id, i) => { const r = getUser(id); return `${i+1}. ${r?.username ? `@${r.username}` : `ID <code>${id}</code>`} <i>(${fmt(r?.balance||0)})</i>`; }).join('\n') : '📭 <i>У вас пока нет приглашённых участников. Начните делиться ссылкой прямо сейчас!</i>';
    return safeEdit(ctx, `👥 <b>Ваша реферальная сеть</b>\n\n🔹 Приглашено всего: <b>${u.referral_count || 0}</b>\n💰 Награда за каждого активного: <b>${fmt(db.settings.refReward)}</b>\n\n📋 <b>Последние 10 участников:</b>\n${list}\n\n🔗 <b>Ваша ссылка для приглашений:</b>\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>\n\n<i>💡 Размещайте ссылку в социальных сетях, тематических чатах или на личных страницах для максимального охвата аудитории и пассивного дохода.</i>`, kb.back());
  },
  'p_withdraw': (ctx, u) => {
    if (u.balance < db.settings.minWithdraw) return safeEdit(ctx, `💸 <b>Лимит вывода средств не достигнут</b>\n\n❌ Минимальная сумма для заявки: <code>${fmt(db.settings.minWithdraw)}</code>\n📊 Ваш текущий баланс: <code>${fmt(u.balance)}</code>\n\n<i>🔹 Приглашайте рефералов или ожидайте начислений, чтобы достичь минимального порога. Как только баланс станет достаточным, эта кнопка откроет форму создания заявки.</i>`, kb.back());
    return safeEdit(ctx, `📤 <b>Оформление заявки на вывод средств</b>\n\n💰 Доступно для вывода: <code>${fmt(u.balance)}</code>\n📉 Минимальная сумма: <code>${fmt(db.settings.minWithdraw)}</code>\n\n<i>📝 Для создания заявки нажмите кнопку ниже и введите желаемую сумму в следующем сообщении. Система автоматически проверит доступный баланс и создаст обращение в очередь на обработку администратором.</i>`, new InlineKeyboard().text('💸 Создать заявку', 'p_wd_input').row().text('🔙 Назад', 'p_main'));
  },
  'p_history': (ctx, u) => {
    const t = db.transactions.filter(x => x.user_id === u.id).slice(-8).reverse();
    const m = t.length ? t.map(x => `▫️ <code>${x.type}</code> | <b>${x.amount>0?'+':''}${fmt(x.amount)}</b>\n   📝 ${x.desc}\n   🕒 <i>${new Date(x.created_at).toLocaleString('ru-RU')}</i>`).join('\n\n') : '📭 <b>История ваших операций пуста.</b>\n\n<i>Все транзакции будут отображаться здесь после первых начислений, выводов или изменений баланса администратором.</i>';
    return safeEdit(ctx, `📜 <b>История ваших транзакций</b>\n\n${m}`, kb.back());
  }
};
Object.entries(screens).forEach(([id, fn]) => {
  bot.callbackQuery(id, async ctx => { ack(ctx); const u=getUser(ctx.from.id); if(!u) return ctx.answerCallbackQuery({text:'⚠️ Сначала нажмите /start',show_alert:true}); try { await fn(ctx, u); } catch { await ctx.reply('⚠️ Ошибка загрузки раздела. Попробуйте позже.', {reply_markup:kb.main(isAdmin(u.id)), parse_mode:'HTML'}); } });
});

// ВВОД СУММЫ ВЫВОДА
bot.callbackQuery('p_wd_input', async ctx => {
  await ack(ctx);
  userStates.set(ctx.from.id, { act: 'wd' });
  return ctx.editMessageText(`📤 <b>Ввод суммы для вывода</b>\n\n💰 Введите точное числовое значение:\n(Минимум: <code>${fmt(db.settings.minWithdraw)}</code>, Максимум: <code>${fmt(getUser(ctx.from.id).balance)}</code>)\n\n<i>💡 Пример: 50000</i>`, { reply_markup: new InlineKeyboard().text('❌ Отменить', 'p_main'), parse_mode: 'HTML' });
});

// ==========================================
// 7. АДМИН ПАНЕЛЬ (ИНЛАЙН)
// ==========================================
bot.callbackQuery('a_main', async ctx => {
  await ack(ctx);
  if(!isAdmin(ctx.from.id)) return ctx.answerCallbackQuery({text:'🔒 Доступ только для администрации',show_alert:true});
  return safeEdit(ctx, `🛠 <b>Панель администратора</b>\n\n👥 Всего пользователей: <b>${getStats().total}</b>\n💎 Общий баланс системы: <b>${fmt(getStats().balance)}</b>\n🔄 Ожидают выплат: <b>${getStats().pending}</b>\n\n<i>Выберите нужный раздел для управления ботом, пользователями или финансами:</i>`, kb.adminMain());
});
bot.callbackQuery('a_users', async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  const list = Object.values(db.users).slice(0, 15).map((u,i)=>`${i+1}. <code>${u.id}</code> | ${u.username?`@${u.username}`:'Без ника'} | 💰${fmt(u.balance)}`).join('\n') || '📭 Пусто';
  return safeEdit(ctx, `👥 <b>Список пользователей (первые 15)</b>\n\n${list}\n\n<i>🔍 Для поиска конкретного юзера используйте кнопку "Поиск юзера" выше.</i>`, kb.backAdmin());
});
bot.callbackQuery('a_search', async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  userStates.set(ctx.from.id, { act: 'search' });
  return ctx.editMessageText(`🔍 <b>Поиск пользователя по ID</b>\n\n<i>Введите числовой идентификатор пользователя в следующем сообщении. Система откроет его полный профиль с рефералами, балансом и статусом.</i>`, { reply_markup: kb.backAdmin(), parse_mode: 'HTML' });
});
bot.callbackQuery('a_wd', async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  const p = getPendingWithdrawals();
  if(!p.length) return safeEdit(ctx, `📭 <b>Нет активных заявок</b>\n\n<i>Все выплаты обработаны. Очередь пуста. Как только пользователи создадут новые заявки, они появятся в этом списке автоматически.</i>`, kb.backAdmin());
  const k = new InlineKeyboard();
  p.slice(0,10).forEach(w => k.text(`📋 #${w.id} | ${fmt(w.amount)}`, `a_wd_view:${w.id}`).row());
  return safeEdit(ctx, `📋 <b>Заявки на вывод средств</b>\n\n🔹 Всего в обработке: <b>${p.length}</b>\n\n<i>Выберите заявку для просмотра деталей и принятия решения (одобрить/отклонить):</i>`, k);
});
bot.callbackQuery(/^a_wd_view:(\d+)$/, async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match[1], 10);
  const wd = db.withdrawals[id];
  if(!wd || wd.status!=='pending') return ctx.answerCallbackQuery({text:'❌ Заявка не найдена',show_alert:true});
  const u = getUser(wd.user_id);
  if(!u) return ctx.answerCallbackQuery({text:'❌',show_alert:true});
  return safeEdit(ctx, `📤 <b>Заявка на вывод #${id}</b>\n\n💰 Сумма: <code>${fmt(wd.amount)}</code>\n📅 Создана: <i>${new Date(wd.created_at).toLocaleString('ru-RU')}</i>\n\n👤 <b>Профиль пользователя:</b>\n🆔 <code>${u.id}</code> | ${u.first_name} ${u.username?`@${u.username}`:''}\n💰 Баланс: <code>${fmt(u.balance)}</code> | 👥 Рефералов: <b>${u.referral_count||0}</b>\n\n<i>Выберите действие для обработки:</i>`, kb.adminWd(id));
});
bot.callbackQuery(/^a_wd_(ap|rj):(\d+)$/, async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  const [,act,idStr]=ctx.match; const id=parseInt(idStr,10);
  const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending') return ctx.answerCallbackQuery({text:'❌',show_alert:true});
  if(act==='ap'){wd.status='approved';wd.comment='Одобрено администратором';}
  else{wd.status='rejected';wd.comment='Отклонено';adjustBalance(wd.user_id,wd.amount,'wd_return',`Возврат #${id}`);}
  saveDB(); try{await bot.api.sendMessage(wd.user_id,`💰 <b>Заявка #${id}</b>\n${act==='ap'?'✅ <b>Успешно одобрена</b> и будет обработана в ближайшее время.':'❌ <b>Отклонена</b>.\n\n📝 Причина: '+wd.comment}\n<i>Средства зачислены обратно на баланс (если отклонено).</i>`,{parse_mode:'HTML'});}catch{}
  return ctx.editMessageText(`✅ <b>Заявка #${id} обработана</b>\n\n📋 Осталось в очереди: <b>${getPendingWithdrawals().length}</b>`, {reply_markup: kb.adminWd(id), parse_mode:'HTML'});
});
bot.callbackQuery('a_settings', async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  userStates.set(ctx.from.id, { act: 'set_ref' });
  return safeEdit(ctx, `⚙️ <b>Глобальные настройки экономики</b>\n\n🎁 Награда за реферала: <b>${fmt(db.settings.refReward)}</b>\n💸 Минимальный вывод: <b>${fmt(db.settings.minWithdraw)}</b>\n\n<i>📝 Введите новое значение награды в следующем сообщении. Для изменения мин. вывода используйте команду /setmin.</i>`, kb.backAdmin());
});
bot.callbackQuery('a_broadcast', async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  userStates.set(ctx.from.id, { act: 'brd' });
  return ctx.editMessageText(`📢 <b>Массовая рассылка</b>\n\n<i>Отправьте текст, изображение или видео, которое нужно доставить всем пользователям бота.\n\n⚠️ Рассылка займёт несколько минут. Прогресс будет отображаться в реальном времени.\nДля отмены нажмите кнопку ниже.</i>`, { reply_markup: kb.backAdmin(), parse_mode: 'HTML' });
});

// ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ (АДМИН)
const openAdminUser = async (ctx, uid) => {
  const u = getUser(uid); if(!u) return ctx.editMessageText(`❌ <b>Пользователь не найден</b>\n\n<i>Проверьте правильность введённого ID.</i>`, {parse_mode:'HTML'});
  const refs = (u.referral_list || []).map((rid, i) => {
    const r = getUser(rid);
    return `${i+1}. <code>${rid}</code> | ${r?.username ? `@${r.username}` : '<i>без ника</i>'} | 💰 <code>${fmt(r?.balance||0)}</code>`;
  }).join('\n') || '📭 <i>Рефералов пока нет.</i>';
  return safeEdit(ctx, `📊 <b>Детальная статистика пользователя</b>\n\n🆔 ID: <code>${u.id}</code>\n👤 Имя: ${u.first_name} ${u.username?`(@${u.username})`:''}\n📅 Регистрация: <i>${new Date(u.created_at).toLocaleString('ru-RU')}</i>\n\n💰 <b>Финансы:</b>\n• Текущий баланс: <b>${fmt(u.balance)}</b>\n• Всего заработано: ${fmt(u.totalEarned)}\n• Всего потрачено: ${fmt(u.totalSpent)}\n\n👥 <b>Рефералы (${u.referral_count||0}):</b>\n${refs}\n\n🚫 Статус: ${u.banned ? '🔴 Заблокирован' : '🟢 Активен'}`, kb.adminUser(u.id));
};

// ==========================================
// 8. ОБРАБОТКА ТЕКСТА (ВВОД ПО СОСТОЯНИЯМ)
// ==========================================
bot.on('message:text', async ctx => {
  const uid = ctx.from.id; const txt = ctx.message.text.trim(); const st = userStates.get(uid);
  
  if (st?.act === 'wd') {
    const u = getUser(uid); const amt = parseFloat(txt.replace(/\s/g,''));
    if(isNaN(amt)||amt<db.settings.minWithdraw||amt>u.balance) return ctx.reply(`❌ <b>Некорректная сумма</b>\n\nМинимум: <code>${fmt(db.settings.minWithdraw)}</code>\nМаксимум: <code>${fmt(u.balance)}</code>\n\n<i>Введите точное значение в указанном диапазоне.</i>`,{reply_markup:kb.main(isAdmin(uid)), parse_mode:'HTML'});
    const id=db.nextWdId++; db.withdrawals[id]={id,user_id:uid,amount:amt,status:'pending',comment:'',created_at:Date.now()};
    adjustBalance(uid,-amt,'wd_pending',`Заявка #${id}`); userStates.delete(uid); saveDB();
    return ctx.reply(`✅ <b>Заявка #${id} успешно создана!</b>\n\n💰 Сумма: <code>${fmt(amt)}</code>\n📝 Статус: <i>Ожидает проверки администратором.</i>\n\n<i>Как только заявка будет обработана, вы получите уведомление в этот чат.</i>`,{reply_markup:kb.main(isAdmin(uid)), parse_mode:'HTML'});
  }
  if(!isAdmin(uid)) return;
  if(txt==='/admin') { userStates.delete(uid); return ctx.editMessageText(`🛠 <b>Панель администратора</b>`, kb.adminMain()); }
  if(!st) return;

  if(st.act==='search'){const id=parseInt(txt,10); if(isNaN(id)||!getUser(id))return ctx.reply('❌ <b>Пользователь не найден</b>\n\n<i>Введите корректный числовой ID из базы данных.</i>',{parse_mode:'HTML'}); userStates.delete(uid); return openAdminUser(ctx, id); }
  if(st.act==='set_ref'){const val=parseFloat(txt.replace(/\s/g,'')); if(isNaN(val)||val<0)return ctx.reply('❌ <b>Некорректное значение</b>\n\n<i>Укажите число >= 0.</i>',{parse_mode:'HTML'}); db.settings.refReward=val; saveDB(); userStates.delete(uid); return ctx.reply(`✅ <b>Награда обновлена</b>\n\n🎁 Новое значение: <code>${fmt(val)}</code>\n<i>Будет применяться ко всем новым рефералам автоматически.</i>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
  if(st.act==='brd'){const users=Object.values(db.users); const msg=await ctx.reply(`📢 <b>Запуск массовой рассылки...</b>\n\n👥 Получателей: <b>${users.length}</b>\n⏳ <i>Пожалуйста, ожидайте завершения процесса. Прогресс будет обновляться автоматически.</i>`,{parse_mode:'HTML'}); let s=0,f=0,b=0; for(let i=0;i<users.length;i++){try{await ctx.copyMessage(users[i].id);s++;}catch(e){e.description?.includes('blocked')?b++:f++;}if((i+1)%50===0)await ctx.api.editMessageText(msg.chat.id,msg.message_id,`📤 <b>Прогресс рассылки: ${Math.round(((i+1)/users.length)*100)}%</b>\n\n✅ Доставлено: <b>${s}</b>\n❌ Ошибки: <b>${f}</b>\n🚫 Заблокировали: <b>${b}</b>`,{parse_mode:'HTML'});await sleep(250);} userStates.delete(uid); await ctx.api.editMessageText(msg.chat.id,msg.message_id,`✅ <b>Рассылка успешно завершена!</b>\n\n📊 <b>Итоги:</b>\n👥 Всего получателей: <b>${users.length}</b>\n✅ Доставлено: <b>${s}</b>\n❌ Ошибки сети: <b>${f}</b>\n🚫 Заблокировали бота: <b>${b}</b>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); return; }
  if(/^a_bal:(\d+)$/.test(st.act)) { const uidT = parseInt(st.act.split(':')[1],10); const amt=parseFloat(txt.replace(/\s/g,'')); if(isNaN(amt))return ctx.reply('❌ <b>Введите число</b>',{parse_mode:'HTML'}); adjustBalance(uidT,amt,'adm_balance',`Админ ${uid}`); userStates.delete(uid); const u=getUser(uidT); return ctx.reply(`✅ <b>Баланс изменён</b>\n👤 <code>${uidT}</code> | 📊 ${amt>0?'+':''}${fmt(amt)} | 💰 Новый: <code>${fmt(u.balance)}</code>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
});

// Обработка кнопок изменения баланса админа
bot.callbackQuery(/^a_bal:(\d+)$/, async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  const uidT = parseInt(ctx.match[1], 10);
  userStates.set(ctx.from.id, { act: `a_bal:${uidT}` });
  return ctx.editMessageText(`💰 <b>Изменение баланса пользователя #${uidT}</b>\n\n<i>Введите сумму:\nИспользуйте + для начисления (например, 50000)\nИспользуйте - для списания (например, -10000)</i>`, { reply_markup: kb.backAdmin(), parse_mode: 'HTML' });
});
bot.callbackQuery(/^a_ban:(\d+)$/, async ctx => {
  await ack(ctx); if(!isAdmin(ctx.from.id)) return;
  const uidT = parseInt(ctx.match[1], 10); const u=getUser(uidT); if(!u) return ctx.answerCallbackQuery({text:'❌',show_alert:true});
  u.banned = !u.banned; setUser(u);
  await ctx.answerCallbackQuery({text:u.banned?'🚫 Забанен':'✅ Разбанен',show_alert:true});
  return openAdminUser(ctx, uidT);
});

// ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК
bot.catch((err, ctx) => { console.error(`❌ [Global] ${err.message}`); if(ctx) ctx.reply('⚠️ Произошла техническая ошибка. Попробуйте повторить действие через несколько секунд.', { parse_mode: 'HTML' }).catch(()=>{}); });

// ЗАПУСК
console.log('🚀 Инициализация бота...');
loadDB().then(() => startBotSafely()).catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
