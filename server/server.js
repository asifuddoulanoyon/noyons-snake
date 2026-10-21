// Room relay server for the worm game. No dependencies (Node 18+).
// One player (the host) runs the game; this server only forwards messages
// between the host and the other players in the same room.
//
// Protocol (JSON text frames):
//   client -> server  {t:'create'}                      -> {t:'created', code, id}
//   client -> server  {t:'join', code}                  -> {t:'joined', id} | {t:'error', msg}
//   host   -> server  {t:'to', id|null, m}              forward m to one player (id) or everyone (null)
//   player -> server  {t:'up', m}                       forward m to the host as {t:'from', id, m}
//   server -> host    {t:'peer', id} / {t:'left', id}   a player joined / left
//   server -> players {t:'hostgone'}                    host left, room closed
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const rooms = new Map(); // code -> {host, players: Map(id -> sock)}
let nextId = 1;

function makeCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now() % 100000);
}

// ---------- minimal WebSocket (RFC 6455) ----------
function frame(str) {
  const data = Buffer.from(str);
  const n = data.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = 0x81;
  return Buffer.concat([head, data]);
}

function attach(sock, onText, onClose) {
  let buf = Buffer.alloc(0), parts = [], closed = false;
  const close = () => { if (closed) return; closed = true; try { sock.destroy(); } catch (e) {} onClose(); };
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 4 * 1024 * 1024) return close();
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4); payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (op === 0x8) return close();
      if (op === 0x9) { const h = Buffer.from([0x8a, payload.length]); sock.write(Buffer.concat([h, payload])); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        parts.push(payload);
        if (fin) { const s = Buffer.concat(parts).toString('utf8'); parts = []; onText(s); }
      }
    }
  });
  sock.on('close', close); sock.on('error', close); sock.on('end', close);
  sock.setNoDelay(true);
  return { send: s => { if (!closed) try { sock.write(frame(s)); } catch (e) {} }, close };
}

// ---------- rooms ----------
function handle(conn) {
  conn.id = nextId++; conn.room = null; conn.isHost = false;
  return text => {
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.t === 'ping') return conn.send('{"t":"pong"}');
    if (msg.t === 'create' && !conn.room) {
      const code = makeCode();
      rooms.set(code, { host: conn, players: new Map() });
      conn.room = code; conn.isHost = true;
      return conn.send(JSON.stringify({ t: 'created', code, id: conn.id }));
    }
    if (msg.t === 'join' && !conn.room) {
      const r = rooms.get(String(msg.code || '').trim());
      if (!r) return conn.send(JSON.stringify({ t: 'error', msg: 'nocode' }));
      if (r.players.size >= 9) return conn.send(JSON.stringify({ t: 'error', msg: 'full' }));
      conn.room = String(msg.code).trim(); r.players.set(conn.id, conn);
      conn.send(JSON.stringify({ t: 'joined', id: conn.id }));
      return r.host.send(JSON.stringify({ t: 'peer', id: conn.id }));
    }
    const r = conn.room && rooms.get(conn.room);
    if (!r) return;
    if (msg.t === 'to' && conn.isHost) {
      const out = JSON.stringify(msg.m);
      if (msg.id == null) { for (const p of r.players.values()) p.send(out); }
      else { const p = r.players.get(msg.id); if (p) p.send(out); }
      return;
    }
    if (msg.t === 'kick' && conn.isHost) { const p = r.players.get(msg.id); if (p) p.close(); return; }
    if (msg.t === 'up' && !conn.isHost) {
      return r.host.send(JSON.stringify({ t: 'from', id: conn.id, m: msg.m }));
    }
  };
}

function gone(conn) {
  const r = conn.room && rooms.get(conn.room);
  if (!r) return;
  if (conn.isHost) {
    for (const p of r.players.values()) { p.send('{"t":"hostgone"}'); p.room = null; p.close(); }
    rooms.delete(conn.room);
  } else {
    r.players.delete(conn.id);
    r.host.send(JSON.stringify({ t: 'left', id: conn.id }));
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end('worm-game relay ok · rooms: ' + rooms.size + '\n');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const conn = {};
  const ws = attach(sock, t => onText(t), () => gone(conn));
  Object.assign(conn, ws);
  const onText = handle(conn);
});
server.listen(PORT, () => console.log('relay listening on ' + PORT));
