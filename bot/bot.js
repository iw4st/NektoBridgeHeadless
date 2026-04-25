require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
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
        // Отправляем микшированный PCM в браузер
        browserWs.send(mixBuffer);
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
    console.log('Browser connected to Nexus Bridge WebSocket!');
    browserWs = ws;

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            // Nekto audio → Discord voice
            audioStream.push(message);
        } else {
            try {
                const data = JSON.parse(message);
                console.log('Received status from browser:', data);
            } catch (e) { }
        }
    });

    ws.on('close', () => {
        console.log('Browser disconnected');
        browserWs = null;
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

    if (command === '$start') {
        if (browserWs) {
            browserWs.send(JSON.stringify({ cmd: 'startAll' }));
            message.reply('Запущен поиск собеседников...');
        } else {
            message.reply('Браузер не подключен к мосту!');
        }
    }

    if (command === '$stop') {
        if (browserWs) {
            browserWs.send(JSON.stringify({ cmd: 'stopAll' }));
            message.reply('Все звонки остановлены.');
        } else {
            message.reply('Браузер не подключен к мосту!');
        }
    }

    if (command === '$skip') {
        if (browserWs) {
            const target = args[0] ? parseInt(args[0]) : null;
            browserWs.send(JSON.stringify({ cmd: 'skipAll', target: target }));
            if (target) {
                message.reply(`Ищу нового собеседника для токена №${target}...`);
            } else {
                message.reply('Ищу новых собеседников (сброс текущих)...');
            }
        } else {
            message.reply('Браузер не подключен к мосту!');
        }
    }
});

client.login(process.env.DISCORD_TOKEN || 'СЮДА_МОЖНО_ВСТАВИТЬ_ТОКЕН_ЕСЛИ_ЗАПУСКАЕТЕ_ЛОКАЛЬНО');
