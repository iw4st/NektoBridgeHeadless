import asyncio
import json
import websockets
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceServer, RTCConfiguration, AudioStreamTrack
from av import AudioFrame
from fingerprint import generate_window_archi, generate_web_agent

NEKTO_WS_URL = "wss://audio.nekto.me/socket.io/?EIO=3&transport=websocket"
DISCORD_WS_URL = "ws://127.0.0.1:8080"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"

class DiscordAudioTrack(AudioStreamTrack):
    """
    Track that reads PCM audio from the Discord Node.js WebSocket
    and sends it to Nekto via aiortc.
    """
    kind = "audio"

    def __init__(self, discord_ws):
        super().__init__()
        self.discord_ws = discord_ws
        self.queue = asyncio.Queue()

    async def recv(self):
        # We need to construct an av.AudioFrame from PCM data
        try:
            pcm_data = await self.queue.get()
            # 960 samples, stereo, 16-bit, 48000Hz = 3840 bytes
            frame = AudioFrame(format='s16', layout='stereo', samples=len(pcm_data) // 4)
            frame.planes[0].update(pcm_data)
            frame.sample_rate = 48000
            
            pts, time_base = await self.next_timestamp()
            frame.pts = pts
            frame.time_base = time_base
            return frame
        except Exception as e:
            print(f"Error producing audio frame: {e}")
            raise

is_manager_assigned = False
active_clients = {}

class HeadlessNektoClient:
    def __init__(self, user_id):
        self.user_id = user_id
        self.ws = None
        self.discord_ws = None
        self.pc = None
        self.internal_id = ""
        self.archi = generate_window_archi()
        self.is_searching = False
        self.discord_track = None
        self.connection_id = None
        self.is_active = True
        
        global is_manager_assigned
        if not is_manager_assigned:
            self.is_manager = True
            is_manager_assigned = True
        else:
            self.is_manager = False

    async def connect_discord(self):
        try:
            self.discord_ws = await websockets.connect(DISCORD_WS_URL)
            print(f"[Discord] Подключено к локальному боту")
            self.discord_track = DiscordAudioTrack(self.discord_ws)
            asyncio.create_task(self.listen_discord())
        except Exception as e:
            print(f"[Discord] Ошибка подключения к боту: {e}")

    async def listen_discord(self):
        try:
            async for message in self.discord_ws:
                if isinstance(message, bytes):
                    # Incoming PCM from Discord
                    if self.discord_track:
                        # Put it in the queue for aiortc to consume
                        # Keep queue small to avoid latency
                        if self.discord_track.queue.qsize() < 5:
                            await self.discord_track.queue.put(message)
                else:
                    # JSON commands from Discord bot (like startAll, skipAll)
                    try:
                        data = json.loads(message)
                        cmd = data.get('cmd')
                        if cmd == 'startAll' and not self.is_searching:
                            await self.start_search()
                        elif cmd == 'skipAll':
                            await self.drop_call()
                            await asyncio.sleep(1)
                            await self.start_search()
                        elif cmd == 'addToken' and getattr(self, 'is_manager', False):
                            new_token = data.get('token')
                            if new_token and new_token not in active_clients:
                                new_client = HeadlessNektoClient(new_token)
                                active_clients[new_token] = new_client
                                asyncio.create_task(new_client.connect_discord())
                                asyncio.create_task(new_client.connect_nekto())
                        elif cmd == 'removeToken' and getattr(self, 'is_manager', False):
                            t = data.get('token')
                            if t in active_clients:
                                await active_clients[t].drop_call()
                                if active_clients[t].ws:
                                    asyncio.create_task(active_clients[t].ws.close())
                                del active_clients[t]
                        elif cmd == 'toggleToken' and getattr(self, 'is_manager', False):
                            t = data.get('token')
                            if t in active_clients:
                                active_clients[t].is_active = not active_clients[t].is_active
                                if not active_clients[t].is_active:
                                    await active_clients[t].drop_call()
                        elif cmd == 'getTokens' and getattr(self, 'is_manager', False):
                            t_list = [{"token": k, "active": v.is_active} for k, v in active_clients.items()]
                            await self.discord_ws.send(json.dumps({"event": "tokensList", "tokens": t_list}))
                        elif cmd == 'stopAll':
                            await self.drop_call()
                    except:
                        pass
        except Exception as e:
            print(f"[Discord] Соединение разорвано: {e}")

    async def connect_nekto(self):
        headers = {
            "User-Agent": USER_AGENT,
            "Origin": "https://nekto.me"
        }
        print(f"[Nekto] Подключение к {NEKTO_WS_URL}...")
        self.ws = await websockets.connect(NEKTO_WS_URL, additional_headers=headers)
        
        asyncio.create_task(self.listen_nekto())

    async def listen_nekto(self):
        try:
            async for message in self.ws:
                if message.startswith("0"):
                    # open event
                    await self.ws.send("40")
                    
                    reg_payload = [
                        "event",
                        {
                            "type": "register",
                            "android": False,
                            "version": 23,
                            "userId": self.user_id,
                            "firefox": False,
                            "isTouch": False,
                            "messengerNeedAuth": True,
                            "timeZone": "Europe/Kyiv",
                            "locale": "en"
                        }
                    ]
                    await self.ws.send("42" + json.dumps(reg_payload))
                
                elif message.startswith("2"):
                    # ping
                    await self.ws.send("3")

                elif message.startswith("42"):
                    data = json.loads(message[2:])
                    if isinstance(data, list) and len(data) == 2 and data[0] == "event":
                        await self.handle_event(data[1])
        except Exception as e:
            print(f"[Nekto] Соединение разорвано: {e}")

    async def handle_event(self, event):
        event_type = event.get("type")
        
        if event_type == "registered":
            self.internal_id = event.get("internal_id", "")
            web_agent = generate_web_agent(self.user_id, "BYdKPTYYGZ7ALwA", self.archi, self.internal_id)
            await self.ws.send("42" + json.dumps(["event", {"type": "web-agent", "data": web_agent}]))
            print(f"[Nekto] Успешно зарегистрировано. Готов к поиску.")

        elif event_type == "search.success":
            print(f"[Nekto] Поиск успешен. Ждем peer-connect...")

        elif event_type == "peer-connect":
            print(f"[Nekto] Собеседник найден! Настройка WebRTC...")
            self.connection_id = event.get("connectionId")
            await self.setup_webrtc(event)

        elif event_type == "peer-disconnect" or event_type == "dialog-closed":
            print(f"[Nekto] Собеседник отключился.")
            await self.cleanup_webrtc()
            # Авто-поиск
            await asyncio.sleep(1)
            if self.is_active:
                await self.start_search()

        elif event_type == "trickle-candidate":
            if self.pc and self.pc.remoteDescription:
                candidate_data = event.get("candidate")
                # Need to convert SDP candidate string to RTCIceCandidate object
                # But aiortc handles trickle ICE differently. Usually we need to parse it.
                # Since we generate a full answer, we might not strictly need it if we gather all locally.
                pass

    async def setup_webrtc(self, event):
        # 1. Get TURN servers
        turn_params = event.get("turnParams", "[]")
        turn_servers = json.loads(turn_params)
        ice_servers = [RTCIceServer(urls="stun:stun.l.google.com:19302")]
        for s in turn_servers:
            username = s.get("username", "").split(":")[1] if ":" in s.get("username", "") else s.get("username", "")
            ice_servers.append(RTCIceServer(urls=s.get("url"), username=username, credential=s.get("credential")))
        
        # 2. Setup PeerConnection
        config = RTCConfiguration(iceServers=ice_servers)
        self.pc = RTCPeerConnection(config)

        # 3. Add local track (from Discord)
        if self.discord_track:
            self.pc.addTrack(self.discord_track)

        # 4. Handle remote track (from Nekto)
        @self.pc.on("track")
        def on_track(track):
            print(f"[WebRTC] Получен медиа-поток от собеседника: {track.kind}")
            if track.kind == "audio":
                asyncio.create_task(self.route_audio_to_discord(track))

        # 5. Handle ICE connection state
        @self.pc.on("iceconnectionstatechange")
        async def on_iceconnectionstatechange():
            print(f"[WebRTC] ICE Состояние: {self.pc.iceConnectionState}")

        # 6. Set remote offer
        offer = event.get("offer")
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=offer.get("sdp"), type=offer.get("type")))

        # 7. Create answer
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)

        # 8. Send answer back to Nekto
        ans_payload = {
            "type": "peer-connect-answer",
            "connectionId": self.connection_id,
            "answer": {
                "type": self.pc.localDescription.type,
                "sdp": self.pc.localDescription.sdp
            }
        }
        await self.ws.send("42" + json.dumps(["event", ans_payload]))
        
        # Send required signals to un-mute the peer
        await self.ws.send("42" + json.dumps(["event", {"type": "peer-connection", "connectionId": self.connection_id}]))
        await self.ws.send("42" + json.dumps(["event", {"type": "peer-mute", "muted": False}]))
        await self.ws.send("42" + json.dumps(["event", {"type": "stream-received"}]))

    async def route_audio_to_discord(self, track):
        """Consume aiortc frames from Nekto, convert to PCM bytes, and send to Discord WS."""
        try:
            while True:
                frame = await track.recv()
                # Ensure it is stereo, 16-bit, 48kHz
                resampled = frame.reformat(format='s16', layout='stereo', rate=48000)
                pcm_data = resampled.planes[0].to_bytes()
                if self.discord_ws:
                    await self.discord_ws.send(pcm_data)
        except Exception as e:
            print(f"[WebRTC] Ошибка чтения аудио-потока: {e}")

    async def cleanup_webrtc(self):
        if self.pc:
            await self.pc.close()
            self.pc = None
        self.is_searching = False
        self.connection_id = None

    async def drop_call(self):
        if self.connection_id and self.ws:
            await self.ws.send("42" + json.dumps(["event", {"type": "peer-disconnect", "connectionId": self.connection_id}]))
        elif self.ws:
            await self.ws.send("42" + json.dumps(["event", {"type": "stop-scan"}]))
        await self.cleanup_webrtc()

    async def start_search(self):
        if not self.ws or not self.is_active: return
        self.is_searching = True
        print(f"[Nekto] Начинаем поиск собеседника...")
        payload = {
            "type": "scan-for-peer",
            "peerToPeer": True,
            "searchCriteria": {
                "mySex": "ANY",
                "myAge": [0, 100],
                "peerSex": "ANY",
                "peerAge": [0, 100]
            },
            "token": None
        }
        await self.ws.send("42" + json.dumps(["event", payload]))

import os

async def main():
    # Читаем токены из переменной окружения (или используем тестовый)
    tokens_env = os.environ.get("NEKTO_TOKENS", "849c179a-8a6f-46d5-8401-2e7851f7a2d6")
    tokens = [t.strip() for t in tokens_env.split(",") if t.strip()]
    
    print(f"Запуск {len(tokens)} токенов...")
    
    for user_id in tokens:
        client = HeadlessNektoClient(user_id)
        active_clients[user_id] = client
        await client.connect_discord()
        await client.connect_nekto()

    # Keep alive
    await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
