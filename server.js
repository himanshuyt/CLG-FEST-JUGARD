const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const D = __dirname;
const PORT = process.env.PORT || 3000;

const songs = JSON.parse(
  fs.readFileSync(path.join(D, 'music/library.json'))
);

const byId = Object.fromEntries(songs.map(s => [s.id, s]));

const app = express();

app.use('/music', express.static(path.join(D, 'music')));
app.use('/vendor', express.static(path.join(D, 'node_modules/qrcode/build')));
app.use(express.static(path.join(D, 'public')));

app.get('/api/songs', (_, r) => r.json(songs));

app.get('/join/:id', (_, r) => {
  r.sendFile(path.join(D, 'public/index.html'));
});

/*
  QR image generation.
  This avoids depending on the browser-side QR library.
*/
app.get('/api/qr/:id', async (req, res) => {
  const id = String(req.params.id || '').toUpperCase();

  if (!rooms.has(id)) {
    return res.status(404).json({
      error: 'Room not found'
    });
  }

  const url =
    `${req.protocol}://${req.get('host')}/join/${id}`;

  try {
    const dataUrl = await QRCode.toDataURL(url, {
      width: 260,
      margin: 2,
      errorCorrectionLevel: 'M'
    });

    res.json({
      url,
      dataUrl
    });
  } catch {
    res.status(500).json({
      error: 'Could not generate QR'
    });
  }
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 8192
});

const rooms = new Map();

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const newId = () => {
  let s;

  do {
    s = Array.from(
      crypto.randomBytes(6),
      b => ALPHA[b % ALPHA.length]
    ).join('');
  } while (rooms.has(s));

  return s;
};

/*
  Authoritative playback clock.

  position = position at server timestamp ts.
*/
const pos = r => {
  if (r.s.state !== 'playing') {
    return r.s.position;
  }

  return r.s.position +
    (Date.now() - r.s.ts) / 1000;
};

const snap = r => ({
  roomId: r.id,
  songId: r.s.songId,
  song: byId[r.s.songId],
  state: r.s.state,
  position: pos(r),
  serverTime: Date.now(),
  queue: r.queue,
  repeat: r.repeat,
  devices: r.members.size,
  commanderOnline: !!r.cmd
});

const send = (w, o) => {
  if (w.readyState === 1) {
    w.send(JSON.stringify(o));
  }
};

const bcast = r => {
  const message = {
    type: 'STATE_UPDATE',
    state: snap(r)
  };

  r.members.forEach(w => send(w, message));
};

const setSong = (r, id, play) => {
  r.s = {
    songId: id,
    state: play ? 'playing' : 'paused',
    position: 0,
    ts: Date.now()
  };
};

function step(r, d) {
  const q = r.queue;

  if (!q.length) return;

  const current = q.indexOf(r.s.songId);
  const next = current + d;

  if (next < 0) {
    return setSong(r, q[0], true);
  }

  if (next < q.length) {
    return setSong(r, q[next], true);
  }

  setSong(r, q[0], r.repeat === 'all');
}

function leave(ws) {
  const r = ws.room;

  if (!r) return;

  r.members.delete(ws);

  if (r.cmd === ws) {
    r.cmd = null;
  }

  ws.room = null;

  if (rooms.has(r.id)) {
    bcast(r);
  }
}

wss.on('connection', ws => {
  ws.alive = true;

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', raw => {
    let m;

    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    /*
      Clock synchronization.
    */
    if (m.type === 'TIME_PING') {
      return send(ws, {
        type: 'TIME_PONG',
        t0: m.t0,
        ts: Date.now()
      });
    }

    /*
      CREATE ROOM
    */
    if (m.type === 'ROOM_CREATE') {
      leave(ws);

      const r = {
        id: newId(),
        token: crypto.randomBytes(24).toString('hex'),
        cmd: ws,
        members: new Set([ws]),
        queue: songs.map(s => s.id),
        repeat: 'off',
        tick: 0,
        seen: Date.now()
      };

      setSong(r, r.queue[0], false);

      rooms.set(r.id, r);

      ws.room = r;
      ws.role = 'commander';

      send(ws, {
        type: 'ROOM_CREATED',
        roomId: r.id,
        token: r.token
      });

      return bcast(r);
    }

    /*
      JOIN ROOM
    */
    if (m.type === 'ROOM_JOIN') {
      const r = rooms.get(
        String(m.roomId || '').toUpperCase()
      );

      if (!r) {
        return send(ws, {
          type: 'ERROR',
          message: 'Room not found. Check the code and try again.'
        });
      }

      leave(ws);

      ws.room = r;
      r.members.add(ws);

      const isC =
        typeof m.token === 'string' &&
        m.token.length === r.token.length &&
        crypto.timingSafeEqual(
          Buffer.from(m.token),
          Buffer.from(r.token)
        );

      ws.role = isC ? 'commander' : 'participant';

      if (isC) {
        r.cmd = ws;
      }

      send(ws, {
        type: 'JOINED',
        roomId: r.id,
        role: ws.role
      });

      return bcast(r);
    }

    const r = ws.room;

    if (!r) return;

    /*
      Synchronization request.
    */
    if (m.type === 'SYNC_REQUEST') {
      return send(ws, {
        type: 'SYNC_RESPONSE',
        state: snap(r)
      });
    }

    /*
      Leave room.
    */
    if (m.type === 'ROOM_LEAVE') {
      return leave(ws);
    }

    /*
      Only Commander controls playback.
    */
    if (
      ws.role !== 'commander' ||
      r.cmd !== ws
    ) {
      return send(ws, {
        type: 'ERROR',
        message: 'Only the Commander can control playback.'
      });
    }

    const s = r.s;

    switch (m.type) {

      case 'PLAY': {
        const id = byId[m.songId]
          ? m.songId
          : s.songId;

        if (!r.queue.includes(id)) {
          r.queue.push(id);
        }

        if (id !== s.songId) {
          setSong(r, id, true);
        } else if (s.state !== 'playing') {
          r.s = {
            ...s,
            state: 'playing',
            ts: Date.now()
          };
        }

        break;
      }

      case 'PAUSE': {
        r.s = {
          ...s,
          state: 'paused',
          position: pos(r),
          ts: Date.now()
        };

        break;
      }

      case 'SEEK': {
        const p = Number(m.position);

        if (!Number.isFinite(p)) return;

        const duration =
          byId[s.songId]?.duration || 0;

        r.s = {
          ...s,
          position: Math.max(
            0,
            Math.min(p, duration - 0.5)
          ),
          ts: Date.now()
        };

        break;
      }

      case 'NEXT':
        step(r, 1);
        break;

      case 'PREVIOUS':
        step(r, -1);
        break;

      case 'SET_REPEAT':
        if (
          ['off', 'all', 'one'].includes(m.mode)
        ) {
          r.repeat = m.mode;
        }
        break;

      case 'SHUFFLE': {
        const i = r.queue.indexOf(s.songId);

        const rest = r.queue
          .filter((_, j) => j !== i)
          .sort(() => Math.random() - 0.5);

        r.queue =
          i < 0
            ? rest
            : [r.queue[i], ...rest];

        break;
      }

      case 'QUEUE_UPDATE': {
        if (
          Array.isArray(m.queue) &&
          m.queue.length &&
          m.queue.every(x => byId[x])
        ) {
          r.queue = [
            ...new Set(m.queue)
          ].slice(0, 100);
        }

        break;
      }

      case 'ROOM_END': {
        r.members.forEach(w => {
          send(w, {
            type: 'ROOM_ENDED'
          });

          w.room = null;
        });

        rooms.delete(r.id);

        return;
      }

      default:
        return;
    }

    bcast(r);
  });

  ws.on('close', () => {
    leave(ws);
  });
});

/*
  Server clock / song completion / periodic state.
*/
setInterval(() => {
  const t = Date.now();

  rooms.forEach(r => {

    if (r.cmd) {
      r.seen = t;
    } else if (t - r.seen > 30 * 60e3) {

      r.members.forEach(w => {
        send(w, {
          type: 'ROOM_ENDED'
        });

        w.room = null;
      });

      rooms.delete(r.id);

      return;
    }

    if (
      r.s.state === 'playing' &&
      pos(r) >= byId[r.s.songId].duration
    ) {

      if (r.repeat === 'one') {
        setSong(r, r.s.songId, true);
      } else {
        step(r, 1);
      }

      bcast(r);

    } else if (++r.tick % 5 === 0) {
      bcast(r);
    }
  });

}, 1000);

/*
  Dead WebSocket detection.
*/
setInterval(() => {

  wss.clients.forEach(w => {

    if (!w.alive) {
      return w.terminate();
    }

    w.alive = false;
    w.ping();

  });

}, 15000);

server.listen(PORT, '0.0.0.0', () => {

  console.log(
    `SYNCROOM running. Open the Commander on one of:`
  );

  console.log(
    `  http://localhost:${PORT}`
  );

  Object.values(os.networkInterfaces())
    .flat()
    .filter(
      i =>
        i.family === 'IPv4' &&
        !i.internal
    )
    .forEach(i => {

      console.log(
        `  http://${i.address}:${PORT}   <- use this one so phones can join`
      );

    });

});