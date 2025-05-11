require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const bot = new Telegraf(process.env.BOT_TOKEN);
const TON_WALLET = process.env.TON_WALLET;
const ROOM_TYPES = { '100': [], '300': [], '500': [], '1000': [] };

let balances = {};
let processedTxs = {};
const TXHASH_FILE = 'txhashes.json';
const BALANCE_FILE = 'balances.json';
const COOLDOWN = {}; // { userId: timestamp }

try {
    if (fs.existsSync(TXHASH_FILE)) {
        processedTxs = JSON.parse(fs.readFileSync(TXHASH_FILE));
    }
} catch (err) {
    console.error('Ошибка загрузки txhashes.json:', err);
}

try {
    if (fs.existsSync(BALANCE_FILE)) {
        balances = JSON.parse(fs.readFileSync(BALANCE_FILE));
    }
} catch (err) {
    console.error('Ошибка загрузки balances.json:', err);
}

function saveBalances() {
    fs.writeFileSync(BALANCE_FILE, JSON.stringify(balances, null, 2));
}

function getBalance(userId) {
    return balances[userId] || 0;
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
    room.joined.forEach(id => bot.telegram.sendMessage(id, text));
}

function endGame(room, ctx) {
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
        room.green.concat(room.red).forEach(userId => {
            balances[userId] += room.stake;
        });
        saveBalances();
        notifyRoomPlayers(room, `[${room.id}] Ничья! Ставки возвращены.`);
        return resetRoom(room);
    }

    const reward = Math.floor(rewardPool / (winners.length || 1));
    winners.forEach(userId => {
        balances[userId] += reward;
    });
    saveBalances();
    notifyRoomPlayers(room, `[${room.id}] Победила команда ${winColor}. Выигрыш: ${reward} монет каждому победителю. Победителей: ${winners.length}`);
    resetRoom(room);
}

function resetRoom(room) {
    room.green = [];
    room.red = [];
    room.joined.forEach(id => bot.telegram.sendMessage(id, `Вы покинули комнату [${room.id}].`));
    room.joined = [];
    room.inProgress = false;
    room.timeout = null;
    room.timerStarted = false;
}

function checkCooldown(userId, command, ctx) {
    const now = Date.now();
    if (!COOLDOWN[userId]) COOLDOWN[userId] = {};
    if (!COOLDOWN[userId][command] || now - COOLDOWN[userId][command] > 60000) {
        COOLDOWN[userId][command] = now;
        return false;
    }
    ctx.reply('⏳ Подождите немного перед повторной попыткой.');
    return true;
}

bot.start((ctx) => {
    ctx.reply('🎮 Добро пожаловать в LuckyClick \n1 TON = 1000 монет\nВыберите действие:',
        Markup.keyboard([
            ['🟢 Войти в комнату', '💰 Баланс'],
            ['➕ Пополнить', '📤 Вывести']
        ]).resize()
    );
});

bot.hears('💰 Баланс', (ctx) => {
    ctx.reply(`Ваш баланс: ${getBalance(ctx.from.id)} монет (1 TON = 1000 монет)`);
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

['100', '300', '500', '1000'].forEach(stake => {
    bot.action(`join_${stake}`, (ctx) => {
        const userId = ctx.from.id;
        const room = findAvailableRoom(stake);
        if (room.joined.includes(userId)) return ctx.answerCbQuery('Вы уже в этой комнате');
        room.joined.push(userId);
        bot.telegram.sendMessage(userId, `Вы вошли в комнату [${room.id}]. Сделайте ставку:`,
            Markup.inlineKeyboard([
                [Markup.button.callback('Зелёная', `bet_green_${room.id}`)],
                [Markup.button.callback('Красная', `bet_red_${room.id}`)],
                [Markup.button.callback('🚪 Выйти', `leave_${room.id}`)]
            ])
        );
        if (room.joined.length === 1 && !room.inProgress && !room.timerStarted) {
            bot.telegram.sendMessage(userId, `[${room.id}] Ожидаем других игроков. Игра начнётся, когда будет хотя бы 2 участника.`);
        } else if (room.joined.length >= 2 && !room.inProgress && !room.timerStarted) {
            room.timerStarted = true;
            notifyRoomPlayers(room, `[${room.id}] Таймер: 30 сек до завершения ставок! Сделайте вашу ставку.`);
            room.timeout = setTimeout(() => {
                room.inProgress = true;
                endGame(room, ctx);
            }, 30000);
        } else if (room.timerStarted) {
            const timeLeft = Math.ceil((room.timeout._idleStart + room.timeout._idleTimeout - Date.now()) / 1000);
            bot.telegram.sendMessage(userId, `[${room.id}] Игра скоро начнётся! У вас есть ${timeLeft} сек чтобы сделать ставку.`);
        }
    });
});

['green', 'red'].forEach(color => {
    bot.action(new RegExp(`^bet_${color}_(.+)$`), (ctx) => {
        const userId = ctx.from.id;
        const roomId = ctx.match[1];
        const stake = roomId.split('_')[0];
        const room = ROOM_TYPES[stake].find(r => r.id === roomId);
        if (!room || !room.joined.includes(userId)) return ctx.reply('Вы не в этой комнате.');
        if (room.inProgress) return ctx.reply('Игра уже началась.');
        if (room.green.includes(userId)) return ctx.reply('Вы уже выбрали зелёный. Нельзя изменить цвет.');
        if (room.red.includes(userId)) return ctx.reply('Вы уже выбрали красный. Нельзя изменить цвет.');
        if (getBalance(userId) < room.stake) return ctx.reply('Недостаточно монет для ставки.');
        balances[userId] -= room.stake;
        room[color].push(userId);
        saveBalances();
        ctx.reply(`[${room.id}] Ставка принята: ${color}`);
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
    ctx.reply(`Переведите TON на адрес:`).then(() => {
        ctx.reply(`${TON_WALLET}`).then(() => {
            ctx.reply(`В поле комментарий напишите: ${ctx.from.id}`).then(() => {
                ctx.reply(`После оплаты введите /checkton`);
            })
        })
    })
});

bot.command('checkton', async (ctx) => {
    const userId = ctx.from.id;
    if (checkCooldown(userId, 'checkton', ctx)) return;

    try {
        const response = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${TON_WALLET}&limit=20`, {
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        const txs = data.result;
        const found = txs.find(tx => tx.in_msg && tx.in_msg.source && tx.in_msg.message && tx.in_msg.message.includes(userId.toString()));
        if (found) {
            const tonAmount = found.in_msg.value / 1e9;
            if (tonAmount < 0.1) return ctx.reply('Минимальная сумма пополнения — 0.1 TON');

            const txHash = found.transaction_id.hash;
            if (!processedTxs[userId]) processedTxs[userId] = [];
            if (processedTxs[userId].includes(txHash)) return ctx.reply('Этот перевод уже был зачислен ранее.');
            const credit = Math.floor(tonAmount * 1000);
            balances[userId] = getBalance(userId) + credit;
            saveBalances();
            processedTxs[userId].push(txHash);
            fs.writeFileSync(TXHASH_FILE, JSON.stringify(processedTxs, null, 2));
            console.log(`✅ [${new Date().toISOString()}] Пользователь ${userId} пополнил баланс на ${credit} монет (≈ ${tonAmount} TON).`);
            return ctx.reply(`Баланс пополнен на ${credit} монет (≈ ${tonAmount} TON). Текущий баланс: ${balances[userId]}`);
        } else {
            return ctx.reply('Перевод не найден. Убедитесь, что вы указали комментарий и сумма соответствует.');
        }
    } catch (e) {
        console.error(e);
        return ctx.reply('Ошибка при проверке перевода. Попробуйте позже.');
    }
});

bot.hears('📤 Вывести', (ctx) => {
    ctx.reply('Введите команду /withdraw СУММА TON_АДРЕС (1 TON = 1000 монет)');
});

bot.command('withdraw', (ctx) => {
    const userId = ctx.from.id;
    if (checkCooldown(userId, 'withdraw', ctx)) return;

    const parts = ctx.message.text.trim().split(' ');
    const amount = parseInt(parts[1]);
    const tonAddress = parts[2];
    if (!amount || amount <= 0) return ctx.reply('❗ Укажите корректную сумму и Ваш TON адрес: /withdraw СУММА TON_АДРЕС');
    if (!tonAddress) return ctx.reply('❗ Укажите TON адрес: /withdraw СУММА TON_АДРЕС');
    if (getBalance(userId) < amount) return ctx.reply('Недостаточно средств.');
    balances[userId] -= amount;
    saveBalances();
    const log = `📤 [${new Date().toISOString()}] Пользователь ${userId} запросил вывод ${amount} монет (≈ ${amount / 1000} TON) на ${tonAddress}. Остаток: ${balances[userId]}\n`;
    fs.appendFileSync('transactions.log', log);
    console.log(log.trim());
    ctx.reply(`✅ Заявка на вывод ${amount / 1000} TON принята. Средства будут переведены на ${tonAddress} в течение 24 часов. Текущий баланс: ${balances[userId]} монет.`);
});

bot.launch();
console.log('Bot is running...');
