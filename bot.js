// bot.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

const bot = new Telegraf(process.env.BOT_TOKEN);
const COOLDOWN = {}; // { userId: { command: timestamp } }
const ROOM_TYPES = { '100': [], '300': [], '500': [], '1000': [] };
const withdrawSessions = {}; // FSM для вывода

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Schemas
const { Schema, model } = mongoose;

const userSchema = new Schema({
    userId: { type: Number, required: true, unique: true },
    balance: { type: Number, default: 0 }
});
const txSchema = new Schema({ userId: Number, txHash: String });

const User = model('User', userSchema);
const TxHash = model('TxHash', txSchema);

async function getBalance(userId) {
    if (typeof userId === 'string' && userId.startsWith('bot_')) return 0;
    const user = await User.findOne({ userId });
    return user ? user.balance : 0;
}

async function updateBalance(userId, amount) {
    if (typeof userId === 'string' && userId.startsWith('bot_')) return 0;
    const user = await User.findOneAndUpdate(
        { userId },
        { $inc: { balance: amount } },
        { new: true, upsert: true }
    );
    return user.balance;
}

async function isTxProcessed(userId, txHash) {
    const exists = await TxHash.findOne({ userId, txHash });
    if (exists) return true;
    await TxHash.create({ userId, txHash });
    return false;
}

function checkCooldown(userId, command, ctx) {
    const now = Date.now();
    if (!COOLDOWN[userId]) COOLDOWN[userId] = {};
    if (!COOLDOWN[userId][command] || now - COOLDOWN[userId][command] > 30000) {
        COOLDOWN[userId][command] = now;
        return false;
    }
    ctx.reply('⏳ Подождите немного перед повторной попыткой.');
    return true;
}

function createRoom(stake) {
    const list = ROOM_TYPES[stake];
    const id = `${stake}_room_${list.length + 1}`;
    const room = { id, stake: parseInt(stake), green: [], red: [], joined: [], inProgress: false, timeout: null, timerStarted: false };
    list.push(room);
    return room;
}

function findAvailableRoom(stake) {
    const list = ROOM_TYPES[stake];
    return list.find(r => !r.inProgress) || createRoom(stake);
}

function notifyRoomPlayers(room, text) {
    room.joined.forEach(id => {
        if (!id.toString().startsWith('bot_')) {
            bot.telegram.sendMessage(id, text)
        }
    });
}

async function endGame(room) {
    if (!room.inProgress) return;
    const greenCount = room.green.length;
    const redCount = room.red.length;
    const total = (greenCount + redCount) * room.stake;
    const fee = Math.floor(total * 0.2);
    const rewardPool = total - fee;

    let winners = [], winColor = '';
    if (greenCount < redCount) { winners = room.green; winColor = 'Green'; }
    else if (redCount < greenCount) { winners = room.red; winColor = 'Red'; }
    else {
        await Promise.all(room.green.concat(room.red)
            .filter(id => !id.toString().startsWith('bot_'))
            .map(id => updateBalance(id, room.stake)));
        notifyRoomPlayers(room, `[${room.id}] Ничья! Ставки возвращены.`);
        return resetRoom(room);
    }

    const reward = Math.floor(rewardPool / (winners.length || 1));
    await Promise.all(winners
        .filter(id => !id.toString().startsWith('bot_'))
        .map(id => updateBalance(id, reward)));
    notifyRoomPlayers(room, `[${room.id}] Победила команда ${winColor === 'Green' ? '🟢 Зелёная' : '🔴 Красная'}. Выигрыш: ${reward} монет каждому. Победителей: ${winners.filter(id => !id.toString().startsWith('bot_')).length || 1}`);
    resetRoom(room);
}

function resetRoom(room) {
    room.green = [];
    room.red = [];
    room.joined.forEach(id => {
        if (!id.toString().startsWith('bot_')) {
            bot.telegram.sendMessage(id, `Вы покинули комнату [${room.id}].`);
        }
    });
    room.joined = [];
    room.inProgress = false;
    room.timeout = null;
    room.timerStarted = false;
}

// Бот
bot.start(async (ctx) => {
    const userId = ctx.from.id;

    // если пользователь отсутствует — создаём с балансом 0
    const exists = await User.exists({ userId });
    if (!exists) {
        await User.create({ userId, balance: 100 });
    }

    ctx.reply(`
🎮 Добро пожаловать в LuckyClick!
🎯 Выбирай сторону и зарабатывай монеты, которые можно вывести в TON.
💰 1 TON = 1000 монет
🚀 Пополнение → Выбор → Результат!
    `,
        Markup.keyboard([
            ['🟢 Войти в комнату', '💰 Баланс'],
            ['➕ Пополнить', '📤 Вывести'],
            ['📜 Правила', '⚙️ Помощь']
        ]).resize()
    );

    ctx.reply(`🎉 Поздравляем, Вы получили 100 монет за первый вход.`);
});

bot.hears('⚙️ Помощь', (ctx) => {
    ctx.reply(
        `📘 Помощь по LuckyClick:

/start — запустить бота
⚙️ Помошь — показать эту справку
💰 Баланс — посмотреть ваш баланс
➕ Пополнить — инструкция по пополнению
📤 Вывести — вывести монеты на TON кошелёк
🟢 Войти в комнату — начать игру

💡 Как это работает:
➕ Пополнение: переведите TON на указанный кошелёк и укажите ваш Telegram ID в комментарии. После перевода введите /checkton — монеты зачислятся автоматически.
📤 Вывод: используйте команду /withdraw СУММА TON_АДРЕС. Заявка отправится администратору и будет обработана в течение 24 часов.

1 TON = 1000 монет
Выигрыши делятся между участниками победившей команды.`
    );
});

bot.hears('📜 Правила', (ctx) => {
    ctx.reply(
        `📜 Правила игры:

1. Выберите комнату со ставкой: 100, 300, 500 или 1000 монет.
        
2. Сделайте выбор на одну из сторон — зелёную или красную.
        
3. Игра начинается, когда в комнате минимум 3 участника.
        
4. Через 30 секунд определяется победившая сторона:
 — та, на которую выбрала меньше игроков
        
5. Победители делят общий приз (за вычетом 20% комиссии).
        
6. В случае ничьи — монеты возвращаются всем участникам.`
    );
});

bot.hears('💰 Баланс', async (ctx) => {
    const balance = await getBalance(ctx.from.id);
    ctx.reply(`Ваш баланс: ${balance} монет (1 TON = 1000 монет)`);
});

bot.hears('🟢 Войти в комнату', (ctx) => {
    ctx.reply('Выберите ставку для игры:',
        Markup.inlineKeyboard([
            [Markup.button.callback('100 монет', 'join_100')],
            [Markup.button.callback('300 монет', 'join_300')],
            [Markup.button.callback('500 монет', 'join_500')],
            [Markup.button.callback('1000 монет', 'join_1000')]
        ])
    );
});

function startRoomTimer(room) {
    room.timerStarted = true;
    room.endTime = Date.now() + 30000;

    notifyRoomPlayers(room, `[${room.id}] Игра началась! 30 сек до завершения ставок!`);

    // Обратный отсчёт с 5 до 1
    [5, 4, 3, 2, 1].forEach((sec) => {
        setTimeout(() => {
            notifyRoomPlayers(room, `⏳ Осталось ${sec} секунд${sec === 1 ? 'a' : sec >= 2 && sec <= 4 ? 'ы' : ''} на ставку!`);
        }, 30000 - sec * 1000);
    });

    room.timeout = setTimeout(() => {
        room.inProgress = true;
        endGame(room);
    }, 30000);
}

['100', '300', '500', '1000'].forEach(stake => {
    bot.action(`join_${stake}`, async (ctx) => {
        const userId = ctx.from.id;
        const room = findAvailableRoom(stake);
        if (room.joined.includes(userId)) return ctx.answerCbQuery('Вы уже в этой комнате');

        room.joined.push(userId);
        await bot.telegram.sendMessage(userId, `Вы вошли в комнату [${room.id}]. Сделайте ставку:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('🟢 Зелёная', `bet_green_${room.id}`)],
                [Markup.button.callback('🔴 Красная', `bet_red_${room.id}`)],
                [Markup.button.callback('🚪 Выйти', `leave_${room.id}`)]
            ])
        );

        if (room.timerStarted && !room.inProgress) {
            const remaining = Math.ceil((room.endTime - Date.now()) / 1000);
            if (remaining > 0) {
                await bot.telegram.sendMessage(userId, `[${room.id}] Игра уже началась! Осталось ${remaining} секунд на ставку.`);
            }
            return await ctx.deleteMessage();
        }

        if (room.joined.length < 3 && !room.inProgress && !room.timerStarted) {
            await bot.telegram.sendMessage(userId, `[${room.id}] Ожидаем других игроков. Нужно хотя бы 3 участника.`);
            setTimeout(() => {
                if (room.joined.length < 3 && !room.inProgress) {
                    const bot1 = `bot_${Date.now()}_1`;
                    const bot2 = `bot_${Date.now()}_2`;
                    room.joined.push(bot1, bot2);
                    const color1 = Math.random() < 0.5 ? 'green' : 'red';
                    const color2 = Math.random() < 0.5 ? 'green' : 'red';
                    room[color1].push(bot1);
                    room[color2].push(bot2);
                    startRoomTimer(room);
                }
            }, 10000);
        } else if (room.joined.length >= 3 && !room.inProgress && !room.timerStarted) {
            startRoomTimer(room);
        }

        await ctx.deleteMessage();
    });
});

['green', 'red'].forEach(color => {
    bot.action(new RegExp(`^bet_${color}_(.+)$`), async (ctx) => {
        const userId = ctx.from.id;
        const roomId = ctx.match[1];
        const stake = roomId.split('_')[0];
        const room = ROOM_TYPES[stake].find(r => r.id === roomId);
        if (!room || !room.joined.includes(userId)) return ctx.reply('Вы не в этой комнате.');
        if (room.inProgress) return ctx.reply('Игра уже началась.');
        if (room.green.includes(userId)) return ctx.reply('Вы уже выбрали зелёный.');
        if (room.red.includes(userId)) return ctx.reply('Вы уже выбрали красный.');

        const balance = await getBalance(userId);
        if (balance < room.stake) return ctx.reply('Недостаточно монет.');

        await updateBalance(userId, -room.stake);
        room[color].push(userId);
        ctx.reply(`[${room.id}] Ставка принята: ${color === 'green' ? '🟢 Зелёная' : '🔴 Красная'}`);
        await ctx.deleteMessage();
    });
});

bot.action(/^leave_(.+)$/, (ctx) => {
    const userId = ctx.from.id;
    const roomId = ctx.match[1];
    const stake = roomId.split('_')[0];
    const room = ROOM_TYPES[stake].find(r => r.id === roomId);
    if (!room) return;
    room.joined = room.joined.filter(id => id !== userId);
    room.green = room.green.filter(id => id !== userId);
    room.red = room.red.filter(id => id !== userId);
    ctx.reply(`Вы покинули комнату [${room.id}].`);
});

bot.hears('➕ Пополнить', (ctx) => {
    const userId = ctx.from.id;
    ctx.reply(`💳 TON-адрес для пополнения:`).then(() => {
        ctx.reply(`*${process.env.TON_WALLET}*`, { parse_mode: 'Markdown' }).then(() => {
            ctx.reply(`*Важно*❗❗❗\nВ комментарии к переводу обязательно укажите ваш ID:`, { parse_mode: 'Markdown' }).then(() => {
                ctx.reply(`*${userId}*`, { parse_mode: 'Markdown' }).then(() => {
                    ctx.reply(`⏳ После перевода средства поступят в течение *2–3 минут*.`);
                })
            })
        })
    })
})

bot.command('confirmwithdraw', async (ctx) => {
    if (ctx.from.id.toString() !== process.env.ADMIN_ID) return ctx.reply('⛔ Только администратор может использовать эту команду.');

    const parts = ctx.message.text.split(' ');
    if (parts.length < 4) return ctx.reply('❗ Используй формат: /confirmwithdraw userId amount ton_address');

    const userId = parseInt(parts[1]);
    const amount = parseInt(parts[2]);
    const tonAddress = parts[3];

    if (!userId || !amount || !tonAddress) return ctx.reply('❗ Неверный формат. Пример: /confirmwithdraw 123456789 1000 EQ...');

    try {
        await bot.telegram.sendMessage(userId, `✅ На ваш TON-адрес ${tonAddress} выведено ${amount} монет (≈ ${amount / 1000} TON).`);
        ctx.reply('📬 Уведомление отправлено пользователю.');
    } catch (err) {
        console.error('Ошибка отправки сообщения пользователю:', err);
        ctx.reply('❌ Не удалось отправить сообщение пользователю.');
    }
});

// Автоматическая проверка пополнений
setInterval(async () => {
    try {
        const res = await fetch(`${process.env.TON_API}/getTransactions?address=${process.env.TON_WALLET}&limit=20`);
        const data = await res.json();
        const txs = data.result;

        for (const tx of txs) {
            const comment = tx.in_msg?.message;
            const userId = parseInt(comment);
            const txHash = tx.transaction_id.hash;

            if (!userId || isNaN(userId)) continue;

            const already = await isTxProcessed(userId, txHash);
            if (already) continue;

            const tonAmount = tx.in_msg.value / 1e9;
            if (tonAmount < 0.1) continue;

            const credit = Math.floor(tonAmount * 1000);
            const newBalance = await updateBalance(userId, credit);

            bot.telegram.sendMessage(userId, `✅ Пополнение успешно! Баланс пополнен на ${credit} монет. Текущий баланс: ${newBalance}`);
        }
    } catch (e) {
        console.error('Ошибка авто-пополнения:', e);
    }
}, 30000);

// FSM для вывода средств
bot.hears('📤 Вывести', (ctx) => {
    const userId = ctx.from.id;
    withdrawSessions[userId] = { step: 'awaiting_address' };
    ctx.reply('Введите ваш TON-адрес для вывода:');
});

function isValidTonAddress(address) {
    // Проверка длины (48 символов base64url)
    if (typeof address !== 'string' || address.length !== 48) return false;
  
    // Проверка на допустимые символы base64url
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    if (!base64urlRegex.test(address)) return false;
  
    // Адреса в TON обычно начинаются с EQ (externally owned) или UQ (smart contract)
    if (!address.startsWith('EQ') && !address.startsWith('UQ')) return false;
  
    return true;
  }

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;

    // Обработка FSM вывода (оставляем как есть)
    const session = withdrawSessions[userId];
    if (!session) return;

    const msg = ctx.message.text.trim();

    if (session.step === 'awaiting_address') {
        if (!isValidTonAddress(msg)) {
            return ctx.reply('❗ Похоже, это не валидный TON-адрес. Попробуйте снова.');
        }
        session.tonAddress = msg;
        session.step = 'awaiting_amount';
        return ctx.reply('Сколько монет вы хотите вывести?');
    }

    if (session.step === 'awaiting_amount') {
        const amount = parseInt(msg);
        if (isNaN(amount) || amount <= 0) return ctx.reply('❗ Введите корректное число монет.');

        const balance = await getBalance(userId);
        if (balance < amount) return ctx.reply('❗ Недостаточно средств на балансе.');

        await updateBalance(userId, -amount);

        ctx.reply(`✅ Заявка на вывод ${amount / 1000} TON создана. Ожидайте перевода в течение 24 часов.`);

        await bot.telegram.sendMessage(
            process.env.ADMIN_ID,
            `📤 Новая заявка на вывод:\n👤 ${ctx.from.first_name} (${userId})\n💸 ${amount} монет (≈ ${amount / 1000} TON)\n📮 ${session.tonAddress}`
        );

        delete withdrawSessions[userId];
    }
});

bot.launch();
console.log('🤖 Бот запущен...');
