const { Bot } = require('grammy');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// 1. КОНФИГУРАЦИЯ
// ==========================================
const CONFIG = {
  BOT_TOKEN: '8530248644:AAHPcrOcK0UK4t7F7ZJw8G2b038DhqGrW0M',
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

const getPendingWithdrawals = () => Object.values(db.withdrawals).filter(w => w.status === 'pending');
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
const userStates = new Map();

const reply = async (ctx, text) => ctx.reply(text, { parse_mode: 'HTML' });
const edit = async (ctx, text) => { try { await ctx.editMessageText(text, { parse_mode: 'HTML' }); } catch { await reply(ctx, text); } };

// ==========================================
// 5. БОТ И КОМАНДЫ
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
  if (!user) {
    user = { id: uid, username: uName, first_name: fName, balance: 0, referrer_id: refId||null, pending_referral_id: refId, banned: false, totalEarned: 0, totalSpent: 0, created_at: Date.now(), lastActive: Date.now(), referral_count: 0, referral_list: [] };
    setUser(user);
    if (refId) {
      const ref = getUser(refId);
      if (ref) {
        ref.referral_count++;
        if(!ref.referral_list.includes(uid)) ref.referral_list.push(uid);
        if(ref.referral_list.length > 50) ref.referral_list.shift();
        setUser(ref);
        await reply(ctx, `✅ <b>Реферал активирован!</b>\n\n<i>Бонус начислится пригласившему после проверки подписок.</i>`);
      }
    }
  } else {
    user.username = uName; user.first_name = fName; setUser(user);
  }

  const sponsors = pf.enabled() ? await pf.getSponsors(uid, ctx.chat.id) : null;
  if (sponsors?.length) {
    const links = sponsors.map((s,i) => `${i+1}. ${s.link}`).join('\n');
    return reply(ctx, `🔒 <b>Доступ ограничен</b>\n\n📋 Подпишитесь на каналы:\n${links}\n\n⏳ После подписки отправьте: <b>/check</b>`);
  }
  if (db.settings.REQUIRED_CHATS?.length > 0) {
    const links = db.settings.REQUIRED_CHATS.map((c,i) => `${i+1}. ${c.startsWith('-100') ? `https://t.me/c/${c.slice(4)}` : `https://t.me/${c.replace(/^@/,'')}`}`).join('\n');
    return reply(ctx, `🔒 <b>Доступ ограничен</b>\n\n📋 Подпишитесь:\n${links}\n\n⏳ После подписки отправьте: <b>/check</b>`);
  }
  
  await reply(ctx, `🌟 <b>GRAM Bot</b>\n\n💰 Баланс: <code>${fmt(user.balance)}</code>\n🔗 Ссылка: <code>https://t.me/${ctx.me.username}?start=ref_${uid}</code>\n\n📌 <b>Доступные команды:</b>\n/profile — ваш аккаунт\n/withdraw — вывод средств\n/history — операции\n/check — проверить подписки\n${isAdmin(uid) ? '/admin — панель управления\n' : ''}/help — справка`);
});

bot.command('check', async (ctx) => {
  const uid = ctx.from.id;
  const sponsors = await pf.getSponsors(uid, ctx.chat.id);
  if (!sponsors?.length) {
    const req = db.settings.REQUIRED_CHATS;
    if (!req?.length) return reply(ctx, `✅ <b>Подписки не требуются</b>\n\n<i>Доступ открыт.</i>`);
    let ok = true;
    for (const c of req) { try { const m = await ctx.api.getChatMember(c.startsWith('-100')?parseInt(c,10):c.replace(/^@/,''), uid); if(!['member','administrator','creator'].includes(m.status)) ok=false; } catch { ok=false; } }
    if (!ok) return reply(ctx, `⛔ <b>Подписка не найдена</b>\n\n<i>Проверьте статус и повторите /check</i>`);
  } else {
    const results = await pf.checkSponsors(uid, sponsors.map(s => s.link));
    if (!results) return reply(ctx, `❌ <b>Ошибка проверки</b>\n\n<i>Попробуйте через минуту.</i>`);
    if (!results.every(r => r.status === 'subscribed')) return reply(ctx, `⛔ <b>Не все подписки найдены</b>\n\n<i>Подпишитесь и повторите /check</i>`);
  }

  const user = getUser(uid);
  if (user.pending_referral_id) {
    const ref = getUser(user.pending_referral_id);
    if (ref) {
      adjustBalance(ref.id, db.settings.refReward, 'referral_approved', `Реферал @${user.username||uid}`);
      try { await bot.api.sendMessage(ref.id, `🎉 <b>Реферал выполнил условия!</b>\n💰 +${fmt(db.settings.refReward)}`, {parse_mode:'HTML'}); } catch {}
    }
    user.pending_referral_id = null; setUser(user);
  }
  await reply(ctx, `✅ <b>Подписки подтверждены!</b>\n\n🎉 <i>Вам открыт полный доступ.</i>`);
});

bot.command('profile', async (ctx) => {
  const u = getUser(ctx.from.id);
  if (!u) return reply(ctx, `⚠️ <b>Сначала отправьте /start</b>`);
  if (u.banned) return reply(ctx, `🚫 <b>Аккаунт заблокирован</b>\n\n<i>Обратитесь в поддержку.</i>`);

  const refs = (u.referral_list || []).slice(0, 5).map((id, i) => { const r = getUser(id); return `${i+1}. ${r?.username ? `@${r.username}` : `ID ${id}`}`; }).join('\n') || '📭 <i>Пока нет рефералов.</i>';
  const txt = `👤 <b>Ваш профиль</b>\n\n💰 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n📤 Выведено: <code>${fmt(u.totalSpent)}</code>\n👥 Рефералов: <b>${u.referral_count||0}</b>\n\n📋 Последние:\n${refs}\n\n🔗 Ваша ссылка:\n<code>https://t.me/${ctx.me.username}?start=ref_${u.id}</code>`;
  await reply(ctx, txt);
});

bot.command('withdraw', async (ctx) => {
  const u = getUser(ctx.from.id);
  if (!u) return reply(ctx, `⚠️ <b>Сначала /start</b>`);
  const args = ctx.match?.trim();
  if (!args) return reply(ctx, `💸 <b>Формат:</b>\n<code>/withdraw сумма</code>\n\n💰 Минимум: <code>${fmt(db.settings.minWithdraw)}</code>`);
  const amt = parseFloat(args.replace(/\s/g,''));
  if (isNaN(amt) || amt < db.settings.minWithdraw || amt > u.balance) return reply(ctx, `❌ <b>Ошибка</b>\n\n💰 Доступно: <code>${fmt(u.balance)}</code>\n📉 Мин: <code>${fmt(db.settings.minWithdraw)}</code>`);

  const id = db.nextWdId++;
  db.withdrawals[id] = { id, user_id: u.id, amount: amt, status: 'pending', comment: '', created_at: Date.now() };
  adjustBalance(u.id, -amt, 'wd_pending', `Заявка #${id}`);
  await reply(ctx, `✅ <b>Заявка #${id} создана</b>\n\n💰 Сумма: <code>${fmt(amt)}</code>\n📝 Статус: <i>Ожидает проверки.</i>`);
});

bot.command('history', async (ctx) => {
  const uid = ctx.from.id;
  const t = db.transactions.filter(x => x.user_id === uid).slice(-10).reverse();
  if (!t.length) return reply(ctx, `📭 <b>История операций пуста</b>`);
  const txt = `📜 <b>История</b>\n\n${t.map(x => `▫️ <code>${x.type}</code> | <b>${x.amount>0?'+':''}${fmt(x.amount)}</b>\n   <i>${x.desc}</i>`).join('\n\n')}`;
  await reply(ctx, txt);
});

// ==========================================
// 6. АДМИН ПАНЕЛЬ (ТЕКСТОВЫЕ КОМАНДЫ)
// ==========================================
bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return reply(ctx, `🔒 <b>Доступ запрещён</b>`);
  await reply(ctx, `🛠 <b>Панель администратора</b>\n\n👥 /users — список всех\n/user <id> — профиль юзера\n/ref <id> — рефералы юзера\n/bal <id> <сумма> — баланс\n/setreward <сумма> — награда за рефа\n/setmin <сумма> — мин вывод\n/broadcast <текст> — рассылка\n/addch <@username> — добавить канал\n/delch <@username> — удалить канал\n/pending — заявки на вывод\n/help — справка`);
});

bot.command('users', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const u = Object.values(db.users);
  const list = u.slice(0, 20).map((x, i) => `${i+1}. <code>${x.id}</code> | ${x.username?`@${x.username}`:'Без ника'} | 💰${fmt(x.balance)}`).join('\n');
  await reply(ctx, `👥 <b>Пользователи (первые 20 из ${u.length})</b>\n\n${list || '📭 Пусто'}`);
});

bot.command('user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match?.trim());
  if (!id) return reply(ctx, `🔍 <b>Формат:</b>\n<code>/user ID</code>`);
  const u = getUser(id);
  if (!u) return reply(ctx, `❌ <b>Пользователь не найден</b>`);
  await reply(ctx, `👤 <b>Профиль #${u.id}</b>\n\n👤 ${u.first_name} ${u.username?`(@${u.username})`:''}\n💰 Баланс: <code>${fmt(u.balance)}</code>\n📈 Заработано: <code>${fmt(u.totalEarned)}</code>\n📤 Выведено: <code>${fmt(u.totalSpent)}</code>\n👥 Рефералов: <b>${u.referral_count||0}</b>\n🚫 Статус: ${u.banned?'🔴 Бан':'🟢 Активен'}`);
});

bot.command('ref', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match?.trim());
  if (!id) return reply(ctx, `👥 <b>Формат:</b>\n<code>/ref ID</code>`);
  const u = getUser(id);
  if (!u) return reply(ctx, `❌ <b>Не найден</b>`);
  const refs = (u.referral_list || []).map((rid, i) => { const r = getUser(rid); return `${i+1}. <code>${rid}</code> | ${r?.username?`@${r.username}`:'Без ника'} | 💰${fmt(r?.balance||0)}`; }).join('\n');
  await reply(ctx, `👥 <b>Рефералы пользователя #${id}</b> (${u.referral_count||0})\n\n${refs || '📭 Пока нет рефералов.'}`);
});

bot.command('bal', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const args = ctx.match?.trim().split(/\s+/);
  if (!args || args.length !== 2) return reply(ctx, `💰 <b>Формат:</b>\n<code>/bal ID сумма</code>\n<i>+ начислить, - снять</i>`);
  const uid = parseInt(args[0]); const amt = parseFloat(args[1]);
  if (isNaN(uid) || isNaN(amt)) return reply(ctx, `❌ <b>Ошибка ввода</b>`);
  if (!getUser(uid)) return reply(ctx, `❌ <b>Не найден</b>`);
  adjustBalance(uid, amt, 'adm_balance', `Админ ${ctx.from.id}`);
  await reply(ctx, `✅ <b>Баланс изменён</b>\n👤 <code>${uid}</code> | 📊 ${amt>0?'+':''}${fmt(amt)} | 💰 Новый: <code>${fmt(getUser(uid).balance)}</code>`);
});

bot.command('setreward', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const val = parseFloat(ctx.match?.trim());
  if (isNaN(val) || val < 0) return reply(ctx, `🎁 <b>Формат:</b>\n<code>/setreward число</code>`);
  db.settings.refReward = val; saveDB();
  await reply(ctx, `✅ <b>Награда обновлена</b>\n🎁 Новое: <code>${fmt(val)}</code>`);
});

bot.command('setmin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const val = parseFloat(ctx.match?.trim());
  if (isNaN(val) || val < 0) return reply(ctx, `💸 <b>Формат:</b>\n<code>/setmin число</code>`);
  db.settings.minWithdraw = val; saveDB();
  await reply(ctx, `✅ <b>Мин. вывод обновлён</b>\n💸 Новое: <code>${fmt(val)}</code>`);
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const txt = ctx.match?.trim();
  if (!txt) return reply(ctx, `📢 <b>Формат:</b>\n<code>/broadcast текст</code>`);
  const users = Object.values(db.users);
  const msg = await reply(ctx, `📢 <b>Запуск рассылки...</b>\n👥 ${users.length}`);
  let s=0, f=0, b=0;
  for (let i=0; i<users.length; i++) {
    try { await bot.api.sendMessage(users[i].id, txt, {parse_mode:'HTML'}); s++; }
    catch (e) { e.description?.includes('blocked') ? b++ : f++; }
    if ((i+1)%50===0) await ctx.api.editMessageText(msg.chat.id, msg.message_id, `📤 Прогресс: ${Math.round(((i+1)/users.length)*100)}% | ✅${s} ❌${f} 🚫${b}`, {parse_mode:'HTML'});
    await sleep(200);
  }
  await ctx.api.editMessageText(msg.chat.id, msg.message_id, `✅ <b>Рассылка завершена</b>\n👥 Всего: ${users.length}\n✅ Доставлено: ${s}\n❌ Ошибки: ${f}\n🚫 Заблокировали: ${b}`, {parse_mode:'HTML'});
});

bot.command('addch', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const val = ctx.match?.trim().replace(/^@/,'').replace(/\s/g,'');
  if (!val) return reply(ctx, `⛓️ <b>Формат:</b>\n<code>/addch @username или -100...</code>`);
  if (!db.settings.REQUIRED_CHATS) db.settings.REQUIRED_CHATS = [];
  if (db.settings.REQUIRED_CHATS.includes(val)) return reply(ctx, `❌ <b>Уже в списке</b>`);
  db.settings.REQUIRED_CHATS.push(val); saveDB();
  await reply(ctx, `✅ <b>Канал добавлен</b>\n📌 <code>${val}</code>`);
});

bot.command('delch', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const val = ctx.match?.trim().replace(/^@/,'').replace(/\s/g,'');
  if (!val) return reply(ctx, `⛓️ <b>Формат:</b>\n<code>/delch @username</code>`);
  const idx = (db.settings.REQUIRED_CHATS||[]).indexOf(val);
  if (idx === -1) return reply(ctx, `❌ <b>Не найден</b>`);
  db.settings.REQUIRED_CHATS.splice(idx,1); saveDB();
  await reply(ctx, `✅ <b>Канал удалён</b>\n📌 <code>${val}</code>`);
});

bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const p = getPendingWithdrawals();
  if (!p.length) return reply(ctx, `📭 <b>Заявок нет</b>`);
  const list = p.map(w => `📋 #${w.id} | 💰 ${fmt(w.amount)} | 👤 <code>${w.user_id}</code>`).join('\n');
  await reply(ctx, `📋 <b>Заявки на вывод</b> (${p.length})\n\n${list}\n\n📌 <b>Обработка:</b>\n<code>/approve ID</code> или <code>/reject ID</code>`);
});

bot.command('approve', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match?.trim());
  if (!id) return reply(ctx, `✅ <b>Формат:</b>\n<code>/approve ID</code>`);
  const wd = db.withdrawals[id];
  if (!wd || wd.status !== 'pending') return reply(ctx, `❌ <b>Не найдена или уже обработана</b>`);
  wd.status = 'approved'; wd.comment = 'Одобрено'; saveDB();
  try { await bot.api.sendMessage(wd.user_id, `💰 <b>Заявка #${id}</b>\n✅ Одобрена и в обработке.`, {parse_mode:'HTML'}); } catch {}
  await reply(ctx, `✅ <b>#${id} одобрена</b>`);
});

bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match?.trim());
  if (!id) return reply(ctx, `❌ <b>Формат:</b>\n<code>/reject ID</code>`);
  const wd = db.withdrawals[id];
  if (!wd || wd.status !== 'pending') return reply(ctx, `❌ <b>Не найдена</b>`);
  wd.status = 'rejected'; wd.comment = 'Отклонено';
  adjustBalance(wd.user_id, wd.amount, 'wd_return', `Возврат #${id}`);
  try { await bot.api.sendMessage(wd.user_id, `💰 <b>Заявка #${id}</b>\n❌ Отклонена. Средства возвращены.`, {parse_mode:'HTML'}); } catch {}
  await reply(ctx, `❌ <b>#${id} отклонена</b>\n💰 Средства возвращены.`);
});

bot.command('help', async (ctx) => {
  const txt = `📖 <b>Справка по командам</b>\n\n/start — регистрация\n/profile — аккаунт\n/withdraw <сумма> — вывод\n/history — операции\n/check — проверить подписки\n${isAdmin(ctx.from.id) ? '\n🛠 Админ:\n/admin — меню\n/users /user /ref /bal\n/setreward /setmin\n/broadcast /addch /delch\n/pending /approve /reject' : ''}`;
  await reply(ctx, txt);
});

// Глобальный обработчик ошибок
bot.catch((err, ctx) => { console.error(`❌ [Global] ${err.message}`); if(ctx) ctx.reply('⚠️ Ошибка. Попробуйте позже.', { parse_mode: 'HTML' }).catch(()=>{}); });

console.log('🚀 Запуск...');
loadDB().then(() => startBotSafely()).catch(err => { console.error('❌ Fatal:', err.message); process.exit(1); });
