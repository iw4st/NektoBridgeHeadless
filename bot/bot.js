require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus, EndBehaviorType } = require('@discordjs/voice');
const WebSocket = require('ws');
const { Readable } = require('stream');
const prism = require('prism-media');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// WebSocket Server
const wss = new WebSocket.Server({ port: 8080 });
let browserWs = null;

// ========== ИСХОДЯЩИЙ ПОТОК (Nekto → Discord) ==========

class LiveAudioStream extends Readable {
    constructor() { super({ highWaterMark: 1024 * 64 }); }
    _read() { }
}
let audioStream = new LiveAudioStream();
const audioPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play }
});

process.on('uncaughtException', err => {
    console.error('Uncaught Exception caught:', err.message);
});

audioPlayer.on(AudioPlayerStatus.Idle, () => {
    recreateResource();
});

audioPlayer.on('error', error => {
    console.error('AudioPlayer Error:', error.message);
    recreateResource();
});

let currentResource = null;

function recreateResource() {
    if (audioStream.destroyed) {
        audioStream = new LiveAudioStream();
    }
    currentResource = createAudioResource(audioStream, {
        inputType: StreamType.Raw,
    });
    audioPlayer.play(currentResource);
}
recreateResource();

// ========== ВХОДЯЩИЙ ПОТОК (Discord → Nekto) ==========

// Буфер для микширования аудио от нескольких пользователей Discord
const activeListeners = new Map(); // userId -> { buffer: Buffer[] }

// Каждые 20мс берём все буферы, миксим, и отправляем в браузер
const MIX_INTERVAL = 20; // мс
const FRAME_SIZE = 960; // 48000Hz * 0.02s = 960 сэмплов
const BYTES_PER_FRAME = FRAME_SIZE * 2 * 2; // 960 samples * 2 bytes * 2 channels (stereo)

setInterval(() => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return;
    if (activeListeners.size === 0) return;

    // Собираем PCM данные от всех активных пользователей
    const mixBuffer = Buffer.alloc(BYTES_PER_FRAME, 0);
    let hasData = false;

    for (const [userId, listener] of activeListeners) {
        if (listener.pcmBuffer.length === 0) continue;

        // Берём один фрейм из буфера
        const chunk = listener.pcmBuffer.shift();
        if (!chunk || chunk.length === 0) continue;
        hasData = true;

        // Миксим: складываем сэмплы с клиппингом
        const len = Math.min(mixBuffer.length, chunk.length);
        for (let i = 0; i < len; i += 2) {
            const existing = mixBuffer.readInt16LE(i);
            const incoming = chunk.readInt16LE(i);
            let mixed = existing + incoming;
            // Клиппинг
            if (mixed > 32767) mixed = 32767;
            if (mixed < -32768) mixed = -32768;
            mixBuffer.writeInt16LE(mixed, i);
        }
    }

    if (hasData) {
        // Отправляем микшированный PCM всем подключенным Python клиентам
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(mixBuffer);
            }
        });
    }
}, MIX_INTERVAL);

function subscribeToUser(connection, userId) {
    if (activeListeners.has(userId)) return; // Уже подписаны

    console.log(`[Discord Receive] Подписка на аудио пользователя: ${userId}`);

    const opusStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
    });

    // Opus → PCM через prism-media
    const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
    });

    const listenerData = { pcmBuffer: [], opusStream, decoder };
    activeListeners.set(userId, listenerData);

    opusStream.pipe(decoder);

    decoder.on('data', (pcmChunk) => {
        // Храним максимум 50 фреймов (~1 секунда) чтобы не раздувать память
        if (listenerData.pcmBuffer.length < 50) {
            listenerData.pcmBuffer.push(Buffer.from(pcmChunk));
        }
    });

    decoder.on('error', (err) => {
        console.error(`[Discord Receive] Decoder error for ${userId}:`, err.message);
    });

    opusStream.on('end', () => {
        console.log(`[Discord Receive] Поток завершён для ${userId}`);
        cleanupListener(userId);
    });

    opusStream.on('error', (err) => {
        console.error(`[Discord Receive] Stream error for ${userId}:`, err.message);
    });
}

function cleanupListener(userId) {
    const listener = activeListeners.get(userId);
    if (listener) {
        try { listener.decoder.destroy(); } catch (e) { }
        try { listener.opusStream.destroy(); } catch (e) { }
        activeListeners.delete(userId);
        console.log(`[Discord Receive] Очищен слушатель: ${userId}`);
    }
}

// ========== WebSocket (связь с браузером) ==========

wss.on('connection', (ws) => {
    console.log('Headless Client connected to Nexus Bridge WebSocket!');

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            // Nekto audio → Discord voice
            audioStream.push(message);
        } else {
            try {
                const data = JSON.parse(message);
                if (data.event === 'tokensList') {
                    client.emit('tokensList', data.tokens);
                } else {
                    console.log('Received status from client:', data);
                }
            } catch (e) { }
        }
    });

    ws.on('close', () => {
        console.log('Headless Client disconnected');
    });
});

// ========== Discord Bot ==========

let currentConnection = null;

client.on('ready', () => {
    console.log(`Discord Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const args = message.content.trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === '$join') {
        if (!message.member.voice.channel) {
            return message.reply('Вам нужно зайти в голосовой канал!');
        }

        // Очищаем старые подписки
        for (const [userId] of activeListeners) {
            cleanupListener(userId);
        }

        currentConnection = joinVoiceChannel({
            channelId: message.member.voice.channel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfDeaf: false // ВАЖНО: false чтобы бот мог слышать пользователей
        });
        currentConnection.subscribe(audioPlayer);
        
        // 1. Принудительно подписываемся на всех, кто уже сидит в канале
        const channel = message.member.voice.channel;
        channel.members.forEach(member => {
            if (member.id !== client.user.id) {
                subscribeToUser(currentConnection, member.id);
            }
        });

        // 2. Подписываемся на тех, кто начнет говорить (на случай если кто-то зайдет позже)
        currentConnection.receiver.speaking.on('start', (userId) => {
            if (userId === client.user.id) return;
            subscribeToUser(currentConnection, userId);
        });

        message.reply(`🔊 Подключился к **${message.member.voice.channel.name}** (двухсторонний мост)`);
    }

    if (command === '$leave') {
        if (currentConnection) {
            // Очищаем все подписки
            for (const [userId] of activeListeners) {
                cleanupListener(userId);
            }
            currentConnection.destroy();
            currentConnection = null;
            message.reply('Отключился от голосового канала');
        }
    }

    function broadcastCmd(cmdObj) {
        let sent = false;
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(cmdObj));
                sent = true;
            }
        });
        return sent;
    }

    if (command === '$start') {
        if (broadcastCmd({ cmd: 'startAll' })) {
            message.reply('Запущен поиск собеседников...');
        } else {
            message.reply('Python клиенты не подключены к мосту!');
        }
    }

    if (command === '$stop') {
        if (broadcastCmd({ cmd: 'stopAll' })) {
            message.reply('Все звонки остановлены.');
        } else {
            message.reply('Python клиенты не подключены к мосту!');
        }
    }

    if (command === '$skip') {
        const target = args[0] ? parseInt(args[0]) : null;
        if (broadcastCmd({ cmd: 'skipAll', target: target })) {
            if (target) {
                message.reply(`Ищу нового собеседника для токена №${target}...`);
            } else {
                message.reply('Ищу новых собеседников (сброс текущих)...');
            }
        } else {
            message.reply('Python клиенты не подключены к мосту!');
        }
    }

    if (command === '$addtoken') {
        const token = args[0];
        if (!token) {
            return message.reply('Пожалуйста, укажите токен! Пример: `$addtoken 849c179a-8a6f-46d5-8401-2e7851f7a2d6`');
        }
        if (broadcastCmd({ cmd: 'addToken', token: token })) {
            message.reply(`Токен отправлен мосту. Подключаю...`);
        } else {
            message.reply('Python клиенты не подключены к мосту!');
        }
    }
    if (command === '$help') {
        const embed = new EmbedBuilder()
            .setColor(Math.floor(Math.random() * 16777215))
            .setTitle('📖 Управление NektoBridge')
            .setDescription('Список доступных команд для управления аудио-мостом:')
            .addFields(
                { name: '🔊 Основные', value: '`$join` - подключить бота в канал\n`$leave` - отключить бота' },
                { name: '📞 Звонки', value: '`$start` - запустить поиск\n`$stop` - остановить поиск и сбросить\n`$skip [токен]` - сбросить и искать новых' },
                { name: '🔑 Токены', value: '`$tokens` - список всех токенов и их статус\n`$addtoken <токен>` - добавить токен на лету\n`$deltoken <токен>` - удалить токен из моста\n`$toggle <токен>` - включить/выключить поиск для токена' }
            )
            .setFooter({ text: 'NektoBridge Headless V2.1' });
        message.reply({ embeds: [embed] });
    }

    if (command === '$tokens') {
        if (broadcastCmd({ cmd: 'getTokens' })) {
            const onTokensList = (tokens) => {
                const embed = new EmbedBuilder()
                    .setColor(Math.floor(Math.random() * 16777215))
                    .setTitle('🔑 Активные токены')
                    .setDescription(tokens.map(t => `${t.active ? '✅' : '❌'} \`${t.token}\``).join('\n') || 'Токенов нет');
                message.reply({ embeds: [embed] });
            };
            client.once('tokensList', onTokensList);
            setTimeout(() => client.removeListener('tokensList', onTokensList), 2000);
        } else {
            message.reply('Python клиенты не подключены к мосту!');
        }
    }

    if (command === '$deltoken' || command === '$removetoken') {
        const token = args[0];
        if (!token) return message.reply('Укажите токен! Пример: `$deltoken 849c...`');
        if (broadcastCmd({ cmd: 'removeToken', token: token })) {
            message.reply(`🗑️ Токен \`${token}\` удален и звонок сброшен.`);
        } else {
            message.reply('Python клиенты не подключены!');
        }
    }

    if (command === '$toggle') {
        const token = args[0];
        if (!token) return message.reply('Укажите токен! Пример: `$toggle 849c...`');
        if (broadcastCmd({ cmd: 'toggleToken', token: token })) {
            message.reply(`🔄 Статус токена \`${token}\` переключен.`);
        } else {
            message.reply('Python клиенты не подключены!');
        }
    }
});

client.login(process.env.DISCORD_TOKEN || 'СЮДА_МОЖНО_ВСТАВИТЬ_ТОКЕН_ЕСЛИ_ЗАПУСКАЕТЕ_ЛОКАЛЬНО');
