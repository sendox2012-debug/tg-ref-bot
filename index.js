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

// 🔒 СТРОГАЯ ПРОВЕРКА ПОДПИСКИ ПЕРЕД ЛЮБЫМ ДЕЙСТВИЕМ
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
    const txt = `🔒 <b>Доступ к функционалу временно ограничен</b>\n\n<i>Для получения полного доступа к боту по заработку GRAM необходимо подтвердить активную подписку на наших партнёров-спонсоров. Это обязательное условие использования платформы, гарантирующее честность начислений и стабильность выплат.</i>\n\n📋 <b>Список обязательных каналов (${links.length}):</b>\n${links.map((s,i)=>`🔹 ${i+1}. ${typeof s === 'string' ? s : s.link}`).join('\n')}\n\n<i>💡 После выполнения условия нажмите кнопку проверки ниже. Система мгновенно обновит ваш статус и откроет доступ ко всем разделам.</i>`;
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
    k.text('👤 Мой профиль', 'p_profile').text('💰 Баланс', 'p_balance').row();
    k.text('👥 Рефералы', 'p_ref').text('📊 Статистика проекта', 'p_stats').row();
    k.text('💸 Вывод средств', 'p_withdraw').text('📜 История операций', 'p_history').row();
    if (isAdminUser) k.text('🔐 Админ-панель', 'a_main').row();
    return k;
  },
  back: () => new InlineKeyboard().text('🔙 Вернуться в главное меню', 'p_main'),
  backAdmin: () => new InlineKeyboard().text('🔙 В панель администратора', 'a_main'),
  adminMain: () => new InlineKeyboard()
    .text('🔍 Поиск пользователя', 'a_search').text('👥 Все участники', 'a_users').row()
    .text('📋 Заявки на вывод', 'a_wd').text('⚙️ Настройки бота', 'a_settings').row()
    .text('📢 Массовая рассылка', 'a_broadcast').text('🔙 Закрыть панель', 'p_main'),
  adminUser: (uid) => new InlineKeyboard()
    .text('💰 Изменить баланс', `a_bal:${uid}`).row()
    .text('🚫 Заблокировать', `a_ban:${uid}`).text('🔙 Назад в админку', 'a_main'),
  adminWd: (id) => new InlineKeyboard()
    .text('✅ Одобрить выплату', `a_wd_ap:${id}`).text('❌ Отклонить заявку', `a_wd_rj:${id}`).row()
    .text('🔙 К списку заявок', 'a_wd')
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
        console.log(`🔗 Реферал записан: Пригласил ${refId} -> Новый ${uid}`);
        try { await bot.api.sendMessage(refId, `🔔 <b>Новый участник по вашей ссылке!</b>\n\n👤 Пользователь: @${uName || `ID ${uid}`}\n📝 Перешёл и подтвердил подписку на спонсоров.\n\n<i>💰 Бонус будет начислен на ваш баланс автоматически, как только новый участник откроет свой профиль.</i>`, { parse_mode: 'HTML' }); } catch {}
      }
    }
    return ctx.reply(`🌟 <b>Добро пожаловать в экосистему заработка GRAM!</b>\n\n<i>Мы рады приветствовать вас в нашем боте. Здесь вы можете накапливать внутреннюю валюту, приглашать друзей по реферальной программе и выводить заработанные средства в удобном формате.</i>\n\n━━━━━━━━━━━━━━━━━━━━\n📊 <b>Ваш стартовый профиль:</b>\n💰 Текущий баланс: <code>${fmt(user.balance)}</code>\n🎁 Награда за приглашение: <code>${fmt(db.settings.refReward)}</code>\n📈 Всего начислено: <code>${fmt(user.totalEarned)}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n🔗 <b>Ваша персональная ссылка для приглашений:</b>\n<code>https://t.me/${ctx.me.username}?start=ref_${uid}</code>\n\n<i>💡 Совет: Размещайте ссылку в социальных сетях, тематических чатах или на личных страницах. За каждого активного друга, открывшего профиль после подписки на спонсоров, вы получите мгновенное начисление на баланс.</i>`, { reply_markup: kb.main(isAdmin(uid)), parse_mode: 'HTML' });
  } else {
    user.username = uName; user.first_name = fName; db.users[String(uid)] = user; saveDB();
    return ctx.reply(`👋 <b>С возвращением, ${user.first_name}!</b>\n\n<i>Ваш профиль успешно синхронизирован с сервером. Все настройки, история операций и реферальные связи сохранены. Приятного использования платформы!</i>`, { reply_markup: kb.main(isAdmin(uid)), parse_mode: 'HTML' });
  }
}));

// ✅ ПРОВЕРКА ПОДПИСКИ
bot.callbackQuery('check_sponsors', async (ctx) => {
  await ack(ctx);
  await requireSub(ctx, async () => {
    await ctx.editMessageText(`✅ <b>Подписка успешно подтверждена!</b>\n\n🎉 <i>Вам открыт полный доступ к экосистеме GRAM.\nТеперь вы можете управлять балансом, выводить средства, отслеживать историю операций и участвовать в реферальной программе. Приятного заработка!</i>`, {parse_mode:'HTML'});
    await ctx.reply(`👋 <b>Главное меню платформы:</b>`, {reply_markup: kb.main(isAdmin(ctx.from.id)), parse_mode:'HTML'});
  });
});

// ОБЁРТКА ДЛЯ ЭКРАНОВ ПОЛЬЗОВАТЕЛЯ (ВСЕ ЧЕРЕЗ requireSub)
const wrap = (id, fn) => bot.callbackQuery(id, async ctx => await requireSub(ctx, async () => {
  await ack(ctx); const u = getUser(ctx.from.id);
  if(!u) return ctx.answerCallbackQuery({text:'⚠️ Пожалуйста, отправьте /start для регистрации в системе.',show_alert:true});
  try { await fn(ctx, u); } catch { await ctx.reply('⚠️ Произошла временная ошибка загрузки раздела. Пожалуйста, попробуйте позже.', {reply_markup:kb.main(isAdmin(u.id)),parse_mode:'HTML'}); }
}));

// ПРОФИЛЬ + НАЧИСЛЕНИЕ РЕФЕРАЛЬНОЙ НАГРАДЫ
bot.callbackQuery('p_profile', async ctx => await requireSub(ctx, async () => {
  await ack(ctx);
  const uid = ctx.from.id; const u = getUser(uid);
  if(!u) return ctx.answerCallbackQuery({text:'⚠️ Сначала /start',show_alert:true});

  // 💰 СТРОГОЕ НАЧИСЛЕНИЕ ПРИ ОТКРЫТИИ ПРОФИЛЯ
  if (u.pending_referral_id) {
    const ref = getUser(u.pending_referral_id);
    if (ref) {
      console.log(`💰 ВЫПЛАТА РЕФЕРАЛА: ${ref.id} <- ${uid} | Сумма: ${db.settings.refReward}`);
      adjustBalance(ref.id, db.settings.refReward, 'referral_approved', `Реферал @${u.username||uid} активировал профиль`);
      try { await bot.api.sendMessage(ref.id, `🎉 <b>Реферальный бонус успешно получен!</b>\n\n👤 Пользователь: @${u.username || `ID ${uid}`}\n💰 На баланс зачислено: <b>${fmt(db.settings.refReward)}</b>\n📈 Всего заработано: <code>${fmt(ref.totalEarned)}</code>\n\n<i>Средства мгновенно доступны для вывода. Продолжайте привлекать новых участников для увеличения пассивного дохода!</i>`, { parse_mode: 'HTML' }); } catch {}
    }
    u.pending_referral_id = null;
    db.users[String(uid)] = u; saveDB();
    console.log(`🔄 Флаг реферала сброшен для ${uid}. Защита от дублей активна.`);
  }

  const txt = `👤 <b>Ваш личный профиль пользователя</b>\n\n🆔 Уникальный идентификатор: <code>${u.id}</code>\n👤 Отображаемое имя: ${u.first_name} ${u.username ? `(@${u.username})` : '<i>не указано</i>'}\n📅 Дата регистрации: <i>${new Date(u.created_at).toLocaleString('ru-RU')}</i>\n🟢 Последняя активность: <i>${new Date(u.lastActive).toLocaleString('ru-RU')}</i>\n\n━━━━━━━━━━━━━━━━━━━━\n💰 <b>Финансовая сводка аккаунта:</b>\n• Текущий доступный баланс: <code>${fmt(u.balance)}</code>\n• Всего начислено за всё время: <code>${fmt(u.totalEarned)}</code>\n• Всего выведено или потрачено: <code>${fmt(u.totalSpent)}</code>\n━━━━━━━━━━━━━━━━━━━━\n\n👥 <b>Реферальная статистика:</b>\n• Приглашено активных участников: <b>${u.referral_count || 0}</b>\n<i>💡 Каждый новый пользователь, перешедший по вашей ссылке и открывший профиль после проверки подписок, приносит вам гарантированную награду.</i>`;
  return safeEdit(ctx, txt, kb.back());
}));

// ОСТАЛЬНЫЕ ЭКРАНЫ
wrap('p_main', (ctx, u) => safeEdit(ctx, `🌟 <b>Главное меню экосистемы GRAM</b>\n\n<i>Добро пожаловать в центр управления вашим аккаунтом. Здесь вы можете отслеживать финансовые показатели, управлять реферальной сетью, создавать заявки на вывод средств и изучать историю транзакций.</i>\n\n💰 Текущий баланс: <code>${fmt(u.balance)}</code>\n📈 Всего начислено: <code>${fmt(u.totalEarned)}</code>\n📤 Всего выведено: <code>${fmt(u.totalSpent)}</code>\n\n🔗 <b>Ваша персональная ссылка:</b>\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>\n\n<i>💡 Выберите нужный раздел ниже для перехода.</i>`, kb.main(isAdmin(u.id))));
wrap('p_balance', (ctx, u) => safeEdit(ctx, `💰 <b>Детальная финансовая информация</b>\n\n📊 Текущий доступный баланс для операций:\n<code>${fmt(u.balance)}</code>\n\n📈 Сумма всех начислений за весь период использования:\n<code>${fmt(u.totalEarned)}</code>\n\n📤 Сумма всех выводов и транзакций:\n<code>${fmt(u.totalSpent)}</code>\n\n━━━━━━━━━━━━━━━━━━━━\n<i>🔹 Для увеличения баланса активно используйте реферальную программу или ожидайте автоматических начислений по акциям. Минимальная сумма для создания заявки на вывод: <b>${fmt(db.settings.minWithdraw)}</b>. Средства обрабатываются администрацией в ручном режиме для безопасности платформы.</i>`, kb.back()));
wrap('p_ref', (ctx, u) => {
  const list = (u.referral_list||[]).slice(0,10).map((id,i)=>{const r=getUser(id);return `${i+1}. ${r?.username?`@${r.username}`:`ID <code>${id}</code>`} <i>(Баланс: ${fmt(r?.balance||0)})`}).join('\n') || '📭 <i>У вас пока нет приглашённых участников. Начните делиться ссылкой прямо сейчас, чтобы запустить пассивный доход!</i>';
  return safeEdit(ctx, `👥 <b>Управление реферальной сетью</b>\n\n🔹 Приглашено всего участников: <b>${u.referral_count || 0}</b>\n💰 Гарантированная награда за каждого активного: <b>${fmt(db.settings.refReward)}</b>\n\n━━━━━━━━━━━━━━━━━━━━\n📋 <b>Список последних приглашённых (до 10):</b>\n${list}\n━━━━━━━━━━━━━━━━━━━━\n\n🔗 <b>Ваша ссылка для распространения:</b>\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>\n\n<i>💡 Размещайте ссылку в социальных сетях, тематических чатах или на личных страницах. Награда начисляется автоматически после того, как приглашённый подтвердит подписку и откроет свой профиль.</i>`, kb.back());
});
wrap('p_stats', (ctx) => { const st=getStats(); return safeEdit(ctx, `📊 <b>Глобальная статистика платформы</b>\n\n👥 Всего зарегистрированных пользователей: <b>${st.total}</b>\n💰 Общий баланс в обороте системы: <b>${fmt(st.balance)}</b>\n🤝 Всего активных реферальных связей: <b>${st.totalRefs}</b>\n📋 Заявок в очереди на обработку: <b>${st.pending}</b>\n\n━━━━━━━━━━━━━━━━━━━━\n<i>📈 Система работает стабильно и безопасно. Мы постоянно развиваем платформу, оптимизируем выплаты и расширяем список партнёрских каналов. Спасибо за ваше участие в экосистеме GRAM!</i>`, kb.back()); });
wrap('p_history', (ctx) => {
  const t=db.transactions.filter(x=>x.user_id===ctx.from.id).slice(-8).reverse();
  const m=t.length?t.map(x=>`▫️ <code>${x.type}</code> | <b>${x.amount>0?'+':''}${fmt(x.amount)}</b>\n   📝 ${x.desc}\n   🕒 <i>${new Date(x.created_at).toLocaleString('ru-RU')}</i>`).join('\n\n'):'📭 <b>История ваших операций пока пуста.</b>\n\n<i>Здесь будут отображаться все начисления, выводы, изменения баланса администратором и реферальные бонусы. Начните зарабатывать, чтобы увидеть первые записи!</i>';
  return safeEdit(ctx, `📜 <b>Полная история ваших транзакций</b>\n\n${m}`, kb.back());
});
wrap('p_withdraw', (ctx, u) => {
  if(u.balance<db.settings.minWithdraw) return safeEdit(ctx, `💸 <b>Лимит вывода средств не достигнут</b>\n\n❌ Минимальная сумма для создания заявки: <code>${fmt(db.settings.minWithdraw)}</code>\n📊 Ваш текущий доступный баланс: <code>${fmt(u.balance)}</code>\n\n━━━━━━━━━━━━━━━━━━━━\n<i>🔹 Для достижения порога приглашайте рефералов или участвуйте в акциях платформы. Как только баланс станет достаточным, вы сможете оформить заявку, которая будет рассмотрена администратором в ближайшее время.</i>`, kb.back());
  userStates.set(ctx.from.id,{act:'wd'}); 
  return safeEdit(ctx, `📤 <b>Оформление заявки на вывод средств</b>\n\n💰 Доступно для вывода: <code>${fmt(u.balance)}</code>\n📉 Минимальная допустимая сумма: <code>${fmt(db.settings.minWithdraw)}</code>\n\n<i>📝 Нажмите кнопку ниже и введите точное числовое значение в следующем сообщении. Система автоматически проверит баланс и создаст обращение в очередь на обработку.</i>`, new InlineKeyboard().text('💸 Перейти к оформлению', 'p_wd_input').row().text('🔙 Вернуться в меню','p_main'));
});
bot.callbackQuery('p_wd_input', async ctx => { await ack(ctx); userStates.set(ctx.from.id,{act:'wd'}); return ctx.editMessageText(`📤 <b>Ввод суммы для вывода</b>\n\n💰 Пожалуйста, введите точное числовое значение:\n(Минимум: <code>${fmt(db.settings.minWithdraw)}</code>, Максимум: ваш баланс)\n\n<i>💡 Пример: 100000</i>`, {reply_markup:new InlineKeyboard().text('❌ Отменить действие','p_main'),parse_mode:'HTML'}); });

// ==========================================
// 7. АДМИН ПАНЕЛЬ
// ==========================================
bot.callbackQuery('a_main', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return ctx.answerCallbackQuery({text:'🔒 Доступ только для авторизованных администраторов',show_alert:true}); return safeEdit(ctx, `🛠 <b>Панель управления администратора</b>\n\n👥 Всего зарегистрированных пользователей: <b>${getStats().total}</b>\n💎 Общий баланс в обороте системы: <b>${fmt(getStats().balance)}</b>\n🔄 Заявок в очереди на выплату: <b>${getStats().pending}</b>\n\n<i>Выберите нужный раздел для управления ботом, пользователями или финансами:</i>`, kb.adminMain()); });
['a_main','a_close'].forEach(id=>{ bot.callbackQuery(id, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.delete(ctx.from.id); if(id==='a_close')return safeEdit(ctx,'✅ <b>Панель администратора закрыта.</b>\n\n<i>Приятного использования платформы.</i>',kb.main()); return safeEdit(ctx, `🛠 <b>Панель управления</b>\n\n👥 ${getStats().total} | 💎 ${fmt(getStats().balance)}`, kb.adminMain()); }); });
bot.callbackQuery('a_search', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'search'}); return ctx.editMessageText('🔍 <b>Поиск пользователя по ID</b>\n\n<i>Введите числовой идентификатор аккаунта в следующем сообщении. Система откроет детальный профиль с полной статистикой и списком рефералов.</i>', {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery('a_wd', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const p=getPendingWithdrawals(); return safeEdit(ctx, p.length?`📋 <b>Заявки в обработке</b>\n\n🔹 Всего в очереди: <b>${p.length}</b>`:'📭 <b>Нет активных заявок</b>\n\n<i>Все выплаты успешно обработаны. Очередь пуста. Как только пользователи создадут новые обращения, они автоматически появятся в этом списке.</i>', p.length?kb.adminMain():kb.backAdmin()); });
bot.callbackQuery('a_broadcast', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'brd'}); return ctx.editMessageText('📢 <b>Запуск массовой рассылки</b>\n\n<i>Отправьте текст, изображение или видео, которое необходимо доставить всем активным пользователям бота.\n\n⚠️ Рассылка может занять несколько минут. Прогресс доставки будет отображаться в реальном времени.\nДля отмены процесса напишите /admin</i>', {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery('a_settings', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'set_ref'}); return safeEdit(ctx, `⚙️ <b>Глобальные настройки экономики</b>\n\n🎁 Текущая награда за реферала: <b>${fmt(db.settings.refReward)}</b>\n💸 Минимальная сумма для вывода: <b>${fmt(db.settings.minWithdraw)}</b>\n\n<i>Введите новое значение награды в следующем сообщении. Для изменения минимального порога вывода используйте соответствующую команду.</i>`, kb.backAdmin()); });

const openAdminUser = async (ctx, uid) => {
  const u = getUser(uid); if(!u) return ctx.editMessageText(`❌ <b>Пользователь не найден в базе данных</b>\n\n<i>Проверьте правильность введённого идентификатора и попробуйте снова.</i>`, {parse_mode:'HTML'});
  const refs = (u.referral_list||[]).map((rid,i)=>{const r=getUser(rid);return `${i+1}. <code>${rid}</code> | ${r?.username?`@${r.username}`:'<i>без ника</i>'} | 💰 <code>${fmt(r?.balance||0)}</code>`}).join('\n') || '📭 <i>Рефералов пока нет.</i>';
  return safeEdit(ctx, `📊 <b>Детальный профиль пользователя #${u.id}</b>\n👤 Имя: ${u.first_name} ${u.username?`(@${u.username})`:''}\n💰 Текущий баланс: <b>${fmt(u.balance)}</b>\n📈 Всего начислено: <code>${fmt(u.totalEarned)}</code>\n👥 Приглашено: <b>${u.referral_count||0}</b>\n🚫 Статус аккаунта: ${u.banned?'🔴 Заблокирован':'🟢 Активен'}\n\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Список рефералов (${u.referral_count||0}):</b>\n${refs}\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Выберите действие для управления аккаунтом:</i>`, kb.adminUser(u.id));
};

bot.callbackQuery('a_users', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const list=Object.values(db.users).slice(0,15).map((u,i)=>`${i+1}. <code>${u.id}</code> | ${u.username?`@${u.username}`:'Без ника'} | 💰${fmt(u.balance)}`).join('\n')||'📭 <b>База пользователей пуста.</b>'; return safeEdit(ctx, `👥 <b>Список активных пользователей</b>\n\n${list}\n\n<i>🔍 Для просмотра детальной статистики конкретного аккаунта используйте раздел "Поиск пользователя".</i>`, kb.backAdmin()); });
bot.callbackQuery(/^a_wd_view:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const id=parseInt(ctx.match[1],10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return ctx.answerCallbackQuery({text:'❌ Заявка не найдена или уже обработана',show_alert:true}); const u=getUser(wd.user_id); if(!u)return ctx.answerCallbackQuery({text:'❌ Пользователь не найден',show_alert:true}); return safeEdit(ctx, `📤 <b>Детали заявки на вывод #${id}</b>\n\n💰 Запрошенная сумма: <code>${fmt(wd.amount)}</code>\n📅 Дата создания: <i>${new Date(wd.created_at).toLocaleString('ru-RU')}</i>\n\n━━━━━━━━━━━━━━━━━━━━\n👤 <b>Профиль заявителя:</b>\n🆔 <code>${u.id}</code> | ${u.first_name} ${u.username?`@${u.username}`:''}\n💰 Текущий баланс: <code>${fmt(u.balance)}</code>\n👥 Рефералов: <b>${u.referral_count||0}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n<i>Выберите действие для обработки обращения:</i>`, kb.adminWd(id)); });
bot.callbackQuery(/^a_wd_(ap|rj):(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const [,act,idStr]=ctx.match; const id=parseInt(idStr,10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return ctx.answerCallbackQuery({text:'❌ Уже обработана',show_alert:true}); if(act==='ap'){wd.status='approved';wd.comment='Одобрено администратором';}else{wd.status='rejected';wd.comment='Отклонено. Средства возвращены на баланс.';adjustBalance(wd.user_id,wd.amount,'wd_return',`Возврат по заявке #${id}`);}saveDB(); try{await bot.api.sendMessage(wd.user_id,`💰 <b>Статус заявки #${id}</b>\n\n${act==='ap'?'✅ <b>Успешно одобрена</b> и будет обработана в ближайшее время.':'❌ <b>Отклонена администрацией.</b>\n\n📝 Причина: '+wd.comment}\n<i>Средства будут зачислены обратно на баланс (в случае отклонения). Благодарим за понимание!</i>`,{parse_mode:'HTML'});}catch{} return ctx.editMessageText(`✅ <b>Заявка #${id} успешно обработана</b>\n\n📋 Осталось в очереди: <b>${getPendingWithdrawals().length}</b>`, {reply_markup:kb.adminMain(),parse_mode:'HTML'}); });

bot.callbackQuery(/^a_bal:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:`a_bal:${ctx.match[1]}`}); return ctx.editMessageText(`💰 <b>Ручное изменение баланса</b>\n\n<i>Введите сумму для корректировки:\nИспользуйте знак + для начисления (например, 50000)\nИспользуйте знак - для списания (например, -10000)</i>`, {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery(/^a_ban:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const u=getUser(parseInt(ctx.match[1],10)); if(!u)return ctx.answerCallbackQuery({text:'❌ Пользователь не найден',show_alert:true}); u.banned=!u.banned; db.users[String(u.id)]=u; saveDB(); await ctx.answerCallbackQuery({text:u.banned?'🚫 Аккаунт заблокирован':'✅ Доступ восстановлен',show_alert:true}); return openAdminUser(ctx, u.id); });

// ==========================================
// 8. ОБРАБОТКА ТЕКСТОВЫХ ВВОДОВ
// ==========================================
bot.on('message:text', async ctx => {
  const uid=ctx.from.id; const txt=ctx.message.text.trim(); const st=userStates.get(uid);
  if(st?.act==='wd'){ 
    const u=getUser(uid); const amt=parseFloat(txt.replace(/\s/g,'')); 
    if(isNaN(amt)||amt<db.settings.minWithdraw||amt>u.balance) return ctx.reply(`❌ <b>Некорректная сумма</b>\n\nМинимум для заявки: <code>${fmt(db.settings.minWithdraw)}</code>\nВаш доступный баланс: <code>${fmt(u.balance)}</code>\n\n<i>Введите точное числовое значение в указанном диапазоне.</i>`,{reply_markup:kb.main(isAdmin(uid)),parse_mode:'HTML'}); 
    const id=db.nextWdId++; db.withdrawals[id]={id,user_id:uid,amount:amt,status:'pending',comment:'',created_at:Date.now()}; 
    adjustBalance(uid,-amt,'wd_pending',`Заявка на вывод #${id}`); userStates.delete(uid); saveDB(); 
    return ctx.reply(`✅ <b>Заявка #${id} успешно создана!</b>\n\n💰 Сумма перевода: <code>${fmt(amt)}</code>\n📝 Текущий статус: <i>Ожидает проверки администрацией.</i>\n\n<i>Как только обращение будет обработано, вы получите уведомление в этот чат с деталями операции.</i>`,{reply_markup:kb.main(isAdmin(uid)),parse_mode:'HTML'}); 
  }
  if(!isAdmin(uid)) return;
  if(txt==='/admin'){userStates.delete(uid); return ctx.editMessageText(`🛠 <b>Панель администратора закрыта</b>\n\n<i>Все несохранённые действия отменены. Возвращаемся в главный интерфейс.</i>`, kb.adminMain()); }
  if(!st) return;
  if(st.act==='search'){const id=parseInt(txt,10); if(isNaN(id)||!getUser(id))return ctx.reply('❌ <b>Пользователь не найден</b>\n\n<i>Введите корректный числовой идентификатор из базы данных.</i>',{parse_mode:'HTML'}); userStates.delete(uid); return openAdminUser(ctx,id); }
  if(st.act==='set_ref'){const val=parseFloat(txt.replace(/\s/g,'')); if(isNaN(val)||val<0)return ctx.reply('❌ <b>Некорректное значение</b>\n\n<i>Укажите число >= 0. Награда не может быть отрицательной.</i>',{parse_mode:'HTML'}); db.settings.refReward=val; saveDB(); userStates.delete(uid); return ctx.reply(`✅ <b>Награда за реферала обновлена</b>\n\n🎁 Новое значение: <code>${fmt(val)}</code>\n<i>Будет автоматически применяться ко всем новым активациям профилей.</i>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
  if(st.act==='brd'){const users=Object.values(db.users); const msg=await ctx.reply(`📢 <b>Запуск массовой рассылки...</b>\n\n👥 Всего получателей: <b>${users.length}</b>\n⏳ <i>Пожалуйста, ожидайте завершения процесса. Прогресс доставки будет обновляться автоматически каждые 50 сообщений.</i>`,{parse_mode:'HTML'}); let s=0,f=0,b=0; for(let i=0;i<users.length;i++){try{await ctx.copyMessage(users[i].id);s++;}catch(e){e.description?.includes('blocked')?b++:f++;}if((i+1)%50===0)await ctx.api.editMessageText(msg.chat.id,msg.message_id,`📤 <b>Прогресс рассылки: ${Math.round(((i+1)/users.length)*100)}%</b>\n\n✅ Успешно доставлено: <b>${s}</b>\n❌ Ошибки сети: <b>${f}</b>\n🚫 Заблокировали бота: <b>${b}</b>`,{parse_mode:'HTML'});await sleep(200);} userStates.delete(uid); await ctx.api.editMessageText(msg.chat.id,msg.message_id,`✅ <b>Массовая рассылка успешно завершена!</b>\n\n📊 <b>Итоги отправки:</b>\n👥 Всего получателей: <b>${users.length}</b>\n✅ Доставлено без ошибок: <b>${s}</b>\n❌ Технические сбои: <b>${f}</b>\n🚫 Заблокировали бота: <b>${b}</b>\n\n<i>Благодарим за использование инструментов администратора!</i>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); return; }
  if(/^a_bal:(\d+)$/.test(st.act)){const uidT=parseInt(st.act.split(':')[1],10); const amt=parseFloat(txt.replace(/\s/g,'')); if(isNaN(amt))return ctx.reply('❌ <b>Ошибка ввода</b>\n\n<i>Пожалуйста, укажите корректное числовое значение.</i>',{parse_mode:'HTML'}); adjustBalance(uidT,amt,'adm_balance',`Ручное изменение баланса админом ${uid}`); userStates.delete(uid); const u=getUser(uidT); return ctx.reply(`✅ <b>Баланс пользователя успешно изменён</b>\n\n👤 Идентификатор: <code>${uidT}</code>\n📊 Сумма корректировки: <b>${amt>0?'+':''}${fmt(amt)}</b>\n💰 Новый доступный баланс: <code>${fmt(u.balance)}</code>\n\n<i>Изменение отражено в системе мгновенно. Транзакция записана в историю.</i>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
});

bot.catch((err, ctx) => { console.error(`❌ [Global Error] ${err.message}`); if(ctx) ctx.reply('⚠️ Произошла временная техническая ошибка. Пожалуйста, повторите действие через несколько секунд или обратитесь в поддержку.', { parse_mode: 'HTML' }).catch(()=>{}); });

console.log('🚀 Инициализация бота по заработку GRAM...');
loadDB().then(() => startBotSafely()).catch(err => { console.error('❌ Fatal Error:', err.message); process.exit(1); });const { Bot, InlineKeyboard } = require('grammy');
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
// 4. УТИЛИТЫ И ПРОВЕРКА ДОСТУПА (СТРОГАЯ)
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

// 🔒 ГЛОБАЛЬНАЯ ПРОВЕРКА ПОДПИСКИ ПЕРЕД ЛЮБЫМ ДЕЙСТВИЕМ
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
    const txt = `🔒 <b>Доступ ограничен</b>\n\nДля использования бота необходимо подписаться на спонсоров:\n${links.map((s,i)=>`🔹 ${i+1}. ${typeof s === 'string' ? s : s.link}`).join('\n')}`;
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
    if (isAdminUser) k.text('🔐 Админ-панель', 'a_main').row();
    return k;
  },
  back: () => new InlineKeyboard().text('🔙 Главное меню', 'p_main'),
  backAdmin: () => new InlineKeyboard().text('🔙 В админку', 'a_main'),
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

// /START (с проверкой подписки)
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
        console.log(`🔗 Реферал: ${refId} -> ${uid}`);
        try { await bot.api.sendMessage(refId, `🔔 <b>Новый переход!</b>\n👤 @${uName || uid}\n<i>Бонус начислится при открытии профиля.</i>`, { parse_mode: 'HTML' }); } catch {}
      }
    }
  } else {
    user.username = uName; user.first_name = fName; db.users[String(uid)] = user; saveDB();
  }
  return ctx.reply(`🌟 <b>Добро пожаловать в GRAM!</b>`, { reply_markup: kb.main(isAdmin(uid)), parse_mode: 'HTML' });
}));

// ✅ ПРОВЕРКА ПОДПИСКИ (кнопка)
bot.callbackQuery('check_sponsors', async (ctx) => {
  await ack(ctx);
  // Просто вызываем любую функцию с requireSub, она сама проверит и пустит дальше
  await requireSub(ctx, async () => {
    await ctx.editMessageText(`✅ <b>Подписка подтверждена!</b>\n\n🎉 Доступ к боту открыт.`, {parse_mode:'HTML'});
    await ctx.reply(`👋 <b>Главное меню:</b>`, {reply_markup: kb.main(isAdmin(ctx.from.id)), parse_mode:'HTML'});
  });
});

// ЭКРАНЫ ПОЛЬЗОВАТЕЛЯ (все через requireSub)
const wrap = (id, fn) => bot.callbackQuery(id, async ctx => await requireSub(ctx, async () => {
  await ack(ctx); const u = getUser(ctx.from.id);
  if(!u) return ctx.answerCallbackQuery({text:'⚠️ Сначала /start',show_alert:true});
  try { await fn(ctx, u); } catch { await ctx.reply('⚠️ Ошибка.', {reply_markup:kb.main(isAdmin(u.id)),parse_mode:'HTML'}); }
}));

wrap('p_main', (ctx, u) => safeEdit(ctx, `🌟 <b>Главное меню</b>\n💰 Баланс: <code>${fmt(u.balance)}</code>\n🔗 Ссылка:\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>`, kb.main(isAdmin(u.id))));
wrap('p_balance', (ctx, u) => safeEdit(ctx, `💰 <b>Финансы</b>\n📊 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n📤 Выведено: <code>${fmt(u.totalSpent)}</code>`, kb.back()));
wrap('p_ref', (ctx, u) => {
  const list = (u.referral_list||[]).slice(0,10).map((id,i)=>{const r=getUser(id);return `${i+1}. ${r?.username?`@${r.username}`:`ID ${id}`} (${fmt(r?.balance||0)})`}).join('\n') || '📭 <i>Пока нет.</i>';
  return safeEdit(ctx, `👥 <b>Рефералы</b>\n🔹 Всего: <b>${u.referral_count||0}</b>\n💰 Награда: <b>${fmt(db.settings.refReward)}</b>\n\n📋 Последние:\n${list}`, kb.back());
});
wrap('p_stats', (ctx) => { const st=getStats(); return safeEdit(ctx, `📊 <b>Статистика бота</b>\n👥 Пользователей: <b>${st.total}</b>\n💰 В обороте: <b>${fmt(st.balance)}</b>\n🤝 Реф. связей: <b>${st.totalRefs}</b>`, kb.back()); });
wrap('p_history', (ctx) => {
  const t=db.transactions.filter(x=>x.user_id===ctx.from.id).slice(-8).reverse();
  const m=t.length?t.map(x=>`▫️ <code>${x.type}</code> | <b>${x.amount>0?'+':''}${fmt(x.amount)}</b>`).join('\n'):'📭 Пусто.';
  return safeEdit(ctx, `📜 <b>История</b>\n\n${m}`, kb.back());
});

// 🔑 ПРОФИЛЬ + НАЧИСЛЕНИЕ РЕФЕРАЛЬНОЙ НАГРАДЫ
bot.callbackQuery('p_profile', async ctx => await requireSub(ctx, async () => {
  await ack(ctx);
  const uid = ctx.from.id; const u = getUser(uid);
  if(!u) return ctx.answerCallbackQuery({text:'⚠️ Сначала /start',show_alert:true});

  // 💰 НАЧИСЛЕНИЕ ТОЛЬКО ЗДЕСЬ (подписка гарантирована requireSub)
  if (u.pending_referral_id) {
    const ref = getUser(u.pending_referral_id);
    if (ref) {
      console.log(`💰 Выплата: ${ref.id} <- ${uid} | ${db.settings.refReward}`);
      adjustBalance(ref.id, db.settings.refReward, 'referral_approved', `Реферал @${u.username||uid} подтвердил подписку`);
      try { await bot.api.sendMessage(ref.id, `✅ <b>Реферал активирован!</b>\n👤 @${u.username || uid}\n💰 Начислено: <b>${fmt(db.settings.refReward)}</b>`, { parse_mode: 'HTML' }); } catch {}
    }
    u.pending_referral_id = null;
    db.users[String(uid)] = u; saveDB();
  }

  const txt = `👤 <b>Ваш профиль</b>\n\n🆔 ID: <code>${u.id}</code>\n👤 Имя: ${u.first_name} ${u.username?`(@${u.username})`:'<i>не указано</i>'}\n💰 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n👥 Рефералов: <b>${u.referral_count||0}</b>`;
  return safeEdit(ctx, txt, kb.back());
}));

// ВВОД СУММЫ ВЫВОДА
bot.callbackQuery('p_withdraw', async ctx => await requireSub(ctx, async () => {
  await ack(ctx); const u = getUser(ctx.from.id); if(!u)return;
  if(u.balance<db.settings.minWithdraw) return safeEdit(ctx, `💸 Мин: <code>${fmt(db.settings.minWithdraw)}</code>\n💰 У вас: <code>${fmt(u.balance)}</code>`, kb.back());
  userStates.set(ctx.from.id,{act:'wd'}); 
  return safeEdit(ctx, `📤 Введите сумму (мин. <code>${fmt(db.settings.minWithdraw)}</code>):`, new InlineKeyboard().text('💸 Создать', 'p_wd_input').row().text('🔙 Назад','p_main'));
}));
bot.callbackQuery('p_wd_input', async ctx => { await ack(ctx); userStates.set(ctx.from.id,{act:'wd'}); return ctx.editMessageText(`📤 Введите сумму:`, {reply_markup:new InlineKeyboard().text('❌ Отмена','p_main'),parse_mode:'HTML'}); });

// ==========================================
// 7. АДМИН ПАНЕЛЬ
// ==========================================
bot.callbackQuery('a_main', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return ctx.answerCallbackQuery({text:'🔒',show_alert:true}); return safeEdit(ctx, `🛠 <b>Админ-панель</b>\n👥 ${getStats().total} | 💎 ${fmt(getStats().balance)}`, kb.adminMain()); });
['a_main','a_close'].forEach(id=>{ bot.callbackQuery(id, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.delete(ctx.from.id); if(id==='a_close')return safeEdit(ctx,'✅ Закрыто.',kb.main()); return safeEdit(ctx, `🛠 <b>Админ</b>`, kb.adminMain()); }); });
bot.callbackQuery('a_search', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'search'}); return ctx.editMessageText('🔍 Введите ID:', {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery('a_wd', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const p=getPendingWithdrawals(); return safeEdit(ctx, p.length?`📋 Заявки: ${p.length}`:'📭 Нет заявок.', p.length?kb.adminMain():kb.backAdmin()); });
bot.callbackQuery('a_broadcast', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'brd'}); return ctx.editMessageText('📢 Отправьте текст/фото. /admin для отмены.', {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery('a_settings', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:'set_ref'}); return safeEdit(ctx, `⚙️ Награда: <b>${fmt(db.settings.refReward)}</b>\nВведите новое значение:`, kb.backAdmin()); });

const openAdminUser = async (ctx, uid) => {
  const u = getUser(uid); if(!u) return ctx.editMessageText(`❌ Не найден`, {parse_mode:'HTML'});
  const refs = (u.referral_list||[]).map((rid,i)=>{const r=getUser(rid);return `${i+1}. <code>${rid}</code> | ${r?.username?`@${r.username}`:'без ника'} | 💰${fmt(r?.balance||0)}`}).join('\n') || '📭 Нет.';
  return safeEdit(ctx, `📊 <b>Профиль #${u.id}</b>\n💰 ${fmt(u.balance)} | 👥 ${u.referral_count||0} | 🚫 ${u.banned?'Бан':'Активен'}\n\n👥 Рефералы:\n${refs}`, kb.adminUser(u.id));
};

bot.callbackQuery('a_users', async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const list=Object.values(db.users).slice(0,15).map((u,i)=>`${i+1}. <code>${u.id}</code> | ${u.username?`@${u.username}`:'Без ника'}`).join('\n')||'📭'; return safeEdit(ctx, `👥 Пользователи\n\n${list}`, kb.backAdmin()); });
bot.callbackQuery(/^a_wd_view:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const id=parseInt(ctx.match[1],10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return ctx.answerCallbackQuery({text:'❌',show_alert:true}); const u=getUser(wd.user_id); if(!u)return ctx.answerCallbackQuery({text:'❌',show_alert:true}); return safeEdit(ctx, `📤 Заявка #${id}\n💰 ${fmt(wd.amount)}\n👤 ${u.first_name} (@${u.username||u.id})`, kb.adminWd(id)); });
bot.callbackQuery(/^a_wd_(ap|rj):(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const [,act,idStr]=ctx.match; const id=parseInt(idStr,10); const wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return ctx.answerCallbackQuery({text:'❌',show_alert:true}); if(act==='ap'){wd.status='approved';wd.comment='Одобрено';}else{wd.status='rejected';wd.comment='Отклонено';adjustBalance(wd.user_id,wd.amount,'wd_return',`Возврат #${id}`);}saveDB(); try{await bot.api.sendMessage(wd.user_id,`💰 Заявка #${id} ${act==='ap'?'✅ одобрена':'❌ отклонена'}.`,{parse_mode:'HTML'});}catch{} return ctx.editMessageText(`✅ #${id} обработана.`, {reply_markup:kb.adminMain(),parse_mode:'HTML'}); });

bot.callbackQuery(/^a_bal:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; userStates.set(ctx.from.id,{act:`a_bal:${ctx.match[1]}`}); return ctx.editMessageText(`💰 Введите сумму (+/-):`, {reply_markup:kb.backAdmin(),parse_mode:'HTML'}); });
bot.callbackQuery(/^a_ban:(\d+)$/, async ctx => { await ack(ctx); if(!isAdmin(ctx.from.id))return; const u=getUser(parseInt(ctx.match[1],10)); if(!u)return ctx.answerCallbackQuery({text:'❌',show_alert:true}); u.banned=!u.banned; db.users[String(u.id)]=u; saveDB(); await ctx.answerCallbackQuery({text:u.banned?'🚫 Бан':'✅ Разбан',show_alert:true}); return openAdminUser(ctx, u.id); });

// ==========================================
// 8. ОБРАБОТКА ТЕКСТА
// ==========================================
bot.on('message:text', async ctx => {
  const uid=ctx.from.id; const txt=ctx.message.text.trim(); const st=userStates.get(uid);
  if(st?.act==='wd'){ 
    const u=getUser(uid); const amt=parseFloat(txt.replace(/\s/g,'')); 
    if(isNaN(amt)||amt<db.settings.minWithdraw||amt>u.balance) return ctx.reply(`❌ Мин: <code>${fmt(db.settings.minWithdraw)}</code>`,{reply_markup:kb.main(isAdmin(uid)),parse_mode:'HTML'}); 
    const id=db.nextWdId++; db.withdrawals[id]={id,user_id:uid,amount:amt,status:'pending',comment:'',created_at:Date.now()}; 
    adjustBalance(uid,-amt,'wd_pending',`Заявка #${id}`); userStates.delete(uid); saveDB(); 
    return ctx.reply(`✅ Заявка #${id} создана`,{reply_markup:kb.main(isAdmin(uid)),parse_mode:'HTML'}); 
  }
  if(!isAdmin(uid)) return;
  if(txt==='/admin'){userStates.delete(uid); return ctx.editMessageText(`🛠 <b>Админ-панель</b>`, kb.adminMain()); }
  if(!st) return;
  if(st.act==='search'){const id=parseInt(txt,10); if(isNaN(id)||!getUser(id))return ctx.reply('❌ Не найден',{parse_mode:'HTML'}); userStates.delete(uid); return openAdminUser(ctx,id); }
  if(st.act==='set_ref'){const val=parseFloat(txt.replace(/\s/g,'')); if(isNaN(val)||val<0)return ctx.reply('❌ Число >= 0',{parse_mode:'HTML'}); db.settings.refReward=val; saveDB(); userStates.delete(uid); return ctx.reply(`✅ Награда: <code>${fmt(val)}</code>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
  if(st.act==='brd'){const users=Object.values(db.users); const msg=await ctx.reply(`📢 Рассылка... (${users.length})`,{parse_mode:'HTML'}); let s=0,f=0,b=0; for(let i=0;i<users.length;i++){try{await ctx.copyMessage(users[i].id);s++;}catch(e){e.description?.includes('blocked')?b++:f++;}if((i+1)%50===0)await ctx.api.editMessageText(msg.chat.id,msg.message_id,`📤 ${Math.round(((i+1)/users.length)*100)}% | ✅${s} ❌${f} 🚫${b}`,{parse_mode:'HTML'});await sleep(200);} userStates.delete(uid); await ctx.api.editMessageText(msg.chat.id,msg.message_id,`✅ Готово: ✅${s} ❌${f} 🚫${b}`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); return; }
  if(/^a_bal:(\d+)$/.test(st.act)){const uidT=parseInt(st.act.split(':')[1],10); const amt=parseFloat(txt.replace(/\s/g,'')); if(isNaN(amt))return ctx.reply('❌ Введите число',{parse_mode:'HTML'}); adjustBalance(uidT,amt,'adm_balance',`Админ ${uid}`); userStates.delete(uid); const u=getUser(uidT); return ctx.reply(`✅ Изменено на ${amt>0?'+':''}${fmt(amt)}\n💰 Новый: <code>${fmt(u.balance)}</code>`,{reply_markup:kb.backAdmin(),parse_mode:'HTML'}); }
});

bot.catch((err, ctx) => { console.error(`❌ [Global] ${err.message}`); if(ctx) ctx.reply('⚠️ Ошибка.', { parse_mode: 'HTML' }).catch(()=>{}); });

console.log('🚀 Запуск...');
loadDB().then(() => startBotSafely()).catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
