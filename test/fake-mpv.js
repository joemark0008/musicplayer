#!/usr/bin/env node
/**
 * A stand-in for mpv that speaks the same JSON IPC protocol but plays
 * nothing. Used by test/smoke-test.js so the server logic (queue, repeat,
 * auto-advance, seek, volume) can be exercised on machines without mpv.
 *
 * Each "track" lasts FAKE_DURATION seconds of wall clock.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const socketPath = process.argv
  .find((a) => a.startsWith('--input-ipc-server='))
  ?.split('=')[1];
if (!socketPath) {
  console.error('fake-mpv: missing --input-ipc-server');
  process.exit(1);
}

const DURATION = Number(process.env.FAKE_DURATION || 4);

const props = {
  'time-pos': null,
  duration: null,
  pause: true,
  volume: 80,
  mute: false,
  'idle-active': true,
  'media-title': null,
  'eof-reached': false,
};

const observed = new Map(); // name -> id
const clients = new Set();
let ticker = null;

const send = (obj) => {
  const line = JSON.stringify(obj) + '\n';
  for (const c of clients) c.write(line);
};

const setProp = (name, value) => {
  props[name] = value;
  if (observed.has(name)) {
    send({ event: 'property-change', id: observed.get(name), name, data: value });
  }
};

const emit = (event, extra = {}) => send({ event, ...extra });

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    if (props.pause || props['idle-active']) return;
    const next = (props['time-pos'] ?? 0) + 0.25;
    if (next >= props.duration) {
      stopTicker();
      setProp('time-pos', null);
      setProp('idle-active', true);
      emit('end-file', { reason: 'eof' });
    } else {
      setProp('time-pos', next);
    }
  }, 250);
}

function handle(cmd, client, requestId) {
  const [name, ...args] = cmd;
  const reply = (data) =>
    client.write(JSON.stringify({ error: 'success', data: data ?? null, request_id: requestId }) + '\n');

  switch (name) {
    case 'observe_property':
      observed.set(args[1], args[0]);
      reply(null);
      setProp(args[1], props[args[1]]);
      return;

    case 'get_property':
      return reply(props[args[0]]);

    case 'set_property': {
      setProp(args[0], args[1]);
      if (args[0] === 'pause' && args[1] === false && props['idle-active'] === false) startTicker();
      return reply(null);
    }

    case 'loadfile': {
      const file = args[0];
      if (!props['idle-active']) emit('end-file', { reason: 'stop' });
      setProp('idle-active', false);
      setProp('media-title', path.basename(file));
      setProp('duration', DURATION);
      setProp('time-pos', 0);
      setProp('pause', false);
      emit('file-loaded');
      startTicker();
      return reply(null);
    }

    case 'stop': {
      stopTicker();
      const wasIdle = props['idle-active'];
      setProp('idle-active', true);
      setProp('time-pos', null);
      setProp('duration', null);
      if (!wasIdle) emit('end-file', { reason: 'stop' });
      return reply(null);
    }

    case 'seek': {
      setProp('time-pos', Math.min(Number(args[0]), props.duration ?? 0));
      return reply(null);
    }

    case 'quit': {
      reply(null);
      stopTicker();
      setTimeout(() => process.exit(0), 50);
      return;
    }

    default:
      return reply(null);
  }
}

try {
  fs.unlinkSync(socketPath);
} catch {}

const server = net.createServer((client) => {
  client.setEncoding('utf8');
  clients.add(client);
  let buf = '';
  client.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      handle(msg.command, client, msg.request_id);
    }
  });
  client.on('close', () => clients.delete(client));
  client.on('error', () => clients.delete(client));
});

server.listen(socketPath);
process.on('SIGTERM', () => process.exit(0));
