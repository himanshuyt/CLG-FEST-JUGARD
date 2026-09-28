# SYNCROOM
One Commander controls music; every phone that scans the QR code plays it in sync. **100% free stack:** Node.js, Express, `ws`, `qrcode` (all MIT/open source), plain HTML/JS (no build step), in-memory rooms (no paid database).

## Run locally
```
npm install
python3 tools/gen_demo_music.py   # optional: regenerates demo tracks (already included)
npm start
```
Open the **LAN address printed in the terminal** (e.g. `http://192.168.1.20:3000`) on the Commander device, not `localhost`, so the QR code points to an address phones can reach. Phones must be on the same Wi-Fi. Click *Create room*, scan the QR with other phones, tap *Enable audio*, then press Play. Add `?debug=1` to any URL for the debug panel (set `SYNCROOM_DEBUG_ENABLED=false` in `public/index.html` to remove it).

## Your own music
Put files in `music/audio/` and artwork in `music/artwork/`, then add entries to `music/library.json` (`id,title,artist,album,artwork,audio,duration` in seconds). Use only music you own or may distribute. Restart the server.

## How it works
- **Roles:** creating a room returns a random 192-bit Commander token (kept in `sessionStorage`). Only a socket that presented it can control playback; everyone else gets an error. Room IDs are 6 random characters.
- **QR:** the Commander page encodes `origin/join/ROOMID`; the server serves the same page there and it shows a Join button.
- **WebSocket:** only small JSON control/state messages. Audio is fetched over plain HTTP.
- **Server clock:** the server stores `{songId, state, position, ts}` = "at server time `ts` the song was at `position`". Play/seek/next reset it; pause freezes it. While playing, the position at any moment = `position + (now − ts)`. The server broadcasts a state snapshot on every action and every 5 s.
- **Clock offset:** a client sends `TIME_PING(t0)`, the server replies with its time `ts`. With round trip `rtt = t1 − t0`, `offset ≈ ts + rtt/2 − t1`. The client keeps the lowest-rtt sample of the last 10 (least network jitter) and uses `serverNow = clientNow + offset`.
- **Drift correction (every 250 ms):** `target = snapshot position + (serverNow − snapshot.serverTime)`; `drift = audio.currentTime − target`. Under 30 ms: play normally. 30–500 ms: change `playbackRate` by up to ±5% (inaudible catch-up/slow-down). Over 500 ms: one hard seek (with a cooldown). Late joiners and reconnecting phones use the same formula, so they start at the right spot.
- **Reconnect:** phones retry every 1.5 s and rejoin; the Commander rejoins with its token. If the Commander drops, listeners see "Waiting for Commander…" and nobody else is promoted. Empty-Commander rooms are deleted after 30 min.

## Limits (honest)
Browsers can't guarantee sample-accurate sync: audio output latency differs per device (Bluetooth can add 100–300 ms), the clock offset estimate has network-jitter error, and `currentTime` is coarse. Expect roughly tens of ms on good Wi-Fi, more on mobile data. Seeking and volume are per device (volume is local by design). iOS/Android may pause audio when the screen locks. Rooms live in memory, so a server restart ends them; for scaling, move the `rooms` map to Redis (free tiers exist) with pub/sub.

## Deploy free
- **Render / Koyeb / Fly.io free tiers:** create a web service from a GitHub repo, build `npm install`, start `npm start`; the platform sets `PORT` and gives HTTPS (WebSockets use `wss://` automatically). Free instances sleep when idle, so the first load is slow. Keep audio files small (repo size limits apply).
- **Quick test over the internet:** `cloudflared tunnel --url http://localhost:3000` (free) gives a public HTTPS link to scan from anywhere.

## Test plan
Setup 1, 2, then 5 phones. For each: Play, Pause, Resume, Seek, Next, Previous, join mid-song, leave mid-song, toggle airplane mode for 10 s (expect Reconnecting → Synchronizing → Synchronized), close Commander tab (expect "Waiting for Commander"), and try Android Chrome, iPhone Safari, desktop Chrome/Edge/Firefox on Wi-Fi and mobile data. Open `?debug=1` and watch drift (target ±150 ms after settling); for real measurement, play the same track from two phones next to a microphone and compare the echo.
