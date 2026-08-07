/**
 * Thin wrapper around mpv's JSON IPC interface.
 *
 * mpv runs as a child process on THIS machine (the server) with
 * --no-video, so all audio comes out of the server's sound device.
 * We talk to it over a unix domain socket using newline-delimited JSON.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_SOCKET = path.join(os.tmpdir(), 'mpv-music-server.sock');

/** Properties we ask mpv to push to us whenever they change. */
const OBSERVED = [
  'time-pos',
  'duration',
  'pause',
  'volume',
  'mute',
  'idle-active',
  'media-title',
  'eof-reached',
];

export class Mpv extends EventEmitter {
  constructor({ socketPath = DEFAULT_SOCKET, audioDevice = null, binary = 'mpv' } = {}) {
    super();
    this.socketPath = socketPath;
    this.audioDevice = audioDevice;
    this.binary = binary;
    this.props = {};
    this.connected = false;

    this._reqId = 0;
    this._pending = new Map();
    this._buffer = '';
  }

  async start() {
    // Stale socket from a previous crash would make mpv refuse to bind.
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      /* nothing to clean up */
    }

    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      '--keep-open=no',
      '--gapless-audio=yes',
      '--volume=80',
      `--input-ipc-server=${this.socketPath}`,
    ];
    if (this.audioDevice) args.push(`--audio-device=${this.audioDevice}`);
    this.args = args;

    // stderr is captured rather than discarded: when mpv refuses to start,
    // its own message is the only thing that explains why.
    this.proc = spawn(this.binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.stderr = '';
    this.exited = null;
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });

    // Note: this is deliberately NOT the 'error' event. An unhandled 'error'
    // on an EventEmitter throws, which turns "mpv isn't installed" into a
    // stack trace. We stash it and let _connect() report it in plain English.
    this.spawnError = null;
    this.proc.on('error', (err) => {
      this.spawnError = err;
      this.connected = false;
      this.emit('spawn-error', err);
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = { code, signal };
      this.connected = false;
      this.emit('exit', { code, signal });
    });

    await this._connect();
    for (const name of OBSERVED) {
      await this.command('observe_property', OBSERVED.indexOf(name) + 1, name).catch(() => {});
    }
    this.emit('ready');
  }

  async _connect(attempts = 60) {
    for (let i = 0; i < attempts; i++) {
      if (this.spawnError?.code === 'ENOENT') {
        throw new Error(
          `Could not find the "${this.binary}" executable.\n` +
            `  macOS:  brew install mpv\n` +
            `  Debian: sudo apt install mpv\n` +
            `  Fedora: sudo dnf install mpv\n` +
            `Already installed somewhere unusual? Set MPV_BINARY=/full/path/to/mpv`
        );
      }
      if (this.spawnError) throw this.spawnError;

      // mpv died before the socket appeared — surface its own words rather
      // than a generic "could not connect" after a six-second wait.
      if (this.exited) {
        const why = this.stderr.trim();
        throw new Error(
          `mpv exited immediately (code ${this.exited.code}${
            this.exited.signal ? `, signal ${this.exited.signal}` : ''
          }) without creating its IPC socket.\n` +
            (why ? `\nmpv said:\n${why}\n` : '\nmpv printed nothing to stderr.\n') +
            `\nTry running it by hand to see the full output:\n` +
            `  ${this.binary} ${this.args.join(' ')}`
        );
      }

      try {
        await new Promise((resolve, reject) => {
          const sock = net.createConnection(this.socketPath);
          sock.once('connect', () => {
            this.sock = sock;
            this.connected = true;
            sock.setEncoding('utf8');
            sock.on('data', (chunk) => this._onData(chunk));
            sock.on('close', () => {
              this.connected = false;
              this.emit('disconnect');
            });
            sock.on('error', () => {});
            resolve();
          });
          sock.once('error', reject);
        });
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error(
      `Could not connect to mpv IPC socket at ${this.socketPath}. Is mpv installed? (apt install mpv)`
    );
  }

  _onData(chunk) {
    this._buffer += chunk;
    let nl;
    while ((nl = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._handle(msg);
    }
  }

  _handle(msg) {
    if (msg.request_id !== undefined && this._pending.has(msg.request_id)) {
      const { resolve, reject } = this._pending.get(msg.request_id);
      this._pending.delete(msg.request_id);
      if (msg.error === 'success') resolve(msg.data);
      else reject(new Error(msg.error));
      return;
    }

    if (msg.event === 'property-change') {
      this.props[msg.name] = msg.data;
      this.emit('property', msg.name, msg.data);
      return;
    }

    if (msg.event) this.emit('mpv-event', msg);
  }

  command(...args) {
    if (!this.connected) return Promise.reject(new Error('mpv is not connected'));
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ command: args, request_id: id }) + '\n');
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`mpv command timed out: ${args[0]}`));
        }
      }, 5000);
    });
  }

  get(name) {
    return this.command('get_property', name);
  }

  set(name, value) {
    return this.command('set_property', name, value);
  }

  loadFile(file) {
    return this.command('loadfile', file, 'replace');
  }

  stop() {
    return this.command('stop');
  }

  async quit() {
    try {
      await this.command('quit');
    } catch {
      this.proc?.kill();
    }
  }
}
