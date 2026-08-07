/**
 * Queue + playback logic layered on top of the mpv IPC wrapper.
 *
 * The queue lives here in Node rather than in mpv's own playlist, so the
 * UI can reorder/remove freely and we keep one source of truth.
 */
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export class Player extends EventEmitter {
  constructor(mpv, library) {
    super();
    this.mpv = mpv;
    this.library = library;

    this.queue = [];        // array of track ids
    this.index = -1;        // position in queue
    this.repeat = 'off';    // 'off' | 'all' | 'one'
    this.shuffle = false;
    this.stopped = true;

    // Set when playing something that isn't in the library — a podcast
    // episode streamed straight from its URL. Takes over the "current
    // track" slot without polluting the queue.
    this.stream = null;

    // In-progress volume fade, so a user pressing play can cancel it.
    this._fade = null;

    // Set while we deliberately swap files, so the resulting
    // end-file(reason=stop) isn't mistaken for a track finishing.
    this._switching = false;

    mpv.on('mpv-event', (ev) => this._onMpvEvent(ev));
    mpv.on('property', () => this.emit('change'));
  }

  async _onMpvEvent(ev) {
    if (ev.event === 'end-file') {
      if (this._switching || ev.reason === 'quit') return;
      if (ev.reason === 'eof') {
        await this._advance(true);
      } else if (ev.reason === 'error') {
        this.emit('warning', `Playback error on "${this.currentId ?? 'unknown'}" — skipping`);
        await this._advance(true);
      }
      this.emit('change');
    }
    if (ev.event === 'file-loaded' || ev.event === 'playback-restart') {
      this.emit('change');
    }
  }

  get currentId() {
    return this.index >= 0 ? this.queue[this.index] ?? null : null;
  }

  get currentTrack() {
    if (this.stream) return this.stream;
    const id = this.currentId;
    return id ? this.library.get(id) : null;
  }

  /** Replace or append to the queue. `startIndex` begins playback there. */
  async setQueue(ids, { mode = 'replace', startIndex = null } = {}) {
    const valid = ids.filter((id) => this.library.get(id));
    if (mode === 'append') {
      this.queue = this.queue.concat(valid);
      if (this.index === -1 && this.queue.length) await this.playIndex(0);
    } else {
      this.queue = valid;
      this.index = -1;
      if (this.queue.length) await this.playIndex(startIndex ?? 0);
      else await this.stop();
    }
    this.emit('change');
    return this.state();
  }

  async enqueue(ids) {
    return this.setQueue(ids, { mode: 'append' });
  }

  async removeAt(i) {
    if (i < 0 || i >= this.queue.length) return this.state();
    const wasCurrent = i === this.index;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    if (wasCurrent) {
      if (this.queue.length === 0) await this.stop();
      else await this.playIndex(Math.min(this.index, this.queue.length - 1));
    }
    this.emit('change');
    return this.state();
  }

  async move(from, to) {
    if (from < 0 || from >= this.queue.length) return this.state();
    to = Math.max(0, Math.min(to, this.queue.length - 1));
    const [id] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, id);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.emit('change');
    return this.state();
  }

  async clear() {
    this.queue = [];
    this.index = -1;
    await this.stop();
    this.emit('change');
    return this.state();
  }

  async playIndex(i) {
    if (i < 0 || i >= this.queue.length) return this.state();
    const track = this.library.get(this.queue[i]);
    if (!track) return this.state();

    this.cancelFade();
    this.stream = null;
    this.index = i;
    this.stopped = false;
    this._switching = true;
    try {
      await this.mpv.loadFile(track.path);
      await this.mpv.set('pause', false);
    } finally {
      // mpv emits end-file for the outgoing file asynchronously.
      setTimeout(() => {
        this._switching = false;
      }, 300);
    }
    this.emit('change');
    return this.state();
  }

  /** Play a library track immediately; queues it if it isn't already there. */
  async playTrack(id) {
    // Only ids that came out of the scan are playable — this is what stops
    // "../../etc/passwd" from ever reaching mpv.
    if (!this.library.get(id)) {
      this.emit('warning', `Unknown track: ${id}`);
      return this.state();
    }
    const existing = this.queue.indexOf(id);
    if (existing !== -1) return this.playIndex(existing);
    this.queue.push(id);
    return this.playIndex(this.queue.length - 1);
  }

  /**
   * Play a URL that isn't in the library (a podcast episode).
   * mpv streams it over HTTP; nothing is written to disk.
   */
  async playStream({ url, title, artist = '', album = '', duration = 0, source = 'stream' }) {
    if (!url) return this.state();
    this.cancelFade();

    this.stream = { id: `stream:${url}`, title, artist, album, duration, source, url };
    this.index = -1;
    this.stopped = false;
    this._switching = true;
    try {
      await this.mpv.loadFile(url);
      await this.mpv.set('pause', false);
    } finally {
      setTimeout(() => {
        this._switching = false;
      }, 300);
    }
    this.emit('change');
    return this.state();
  }

  /**
   * Ramp the volume down, stop, then put the volume back where the user
   * had it — otherwise tomorrow's playback would start silent.
   */
  async fadeOutAndStop(seconds = 10) {
    if (seconds <= 0) return this.stop();

    const from = this.mpv.props.volume ?? 80;
    const steps = Math.max(1, Math.round(seconds * 4));
    const token = Symbol('fade');
    this._fade = { token, from };
    this.emit('change');

    for (let i = 1; i <= steps; i++) {
      if (this._fade?.token !== token) return this.state(); // cancelled
      await this.mpv.set('volume', Math.max(0, Math.round(from * (1 - i / steps)))).catch(() => {});
      await sleep((seconds * 1000) / steps);
    }

    if (this._fade?.token !== token) return this.state();
    await this.stop();
    await this.mpv.set('volume', from).catch(() => {});
    this._fade = null;
    this.emit('change');
    return this.state();
  }

  /** Abort a running fade and restore the pre-fade volume. */
  cancelFade() {
    if (!this._fade) return;
    const { from } = this._fade;
    this._fade = null;
    this.mpv.set('volume', from).catch(() => {});
  }

  async _advance(auto) {
    // A podcast episode finishing means "done", not "next track".
    if (this.stream) {
      this.stream = null;
      return this.stop();
    }
    if (!this.queue.length) return;

    if (auto && this.repeat === 'one') return this.playIndex(this.index);

    let next;
    if (this.shuffle && this.queue.length > 1) {
      do {
        next = Math.floor(Math.random() * this.queue.length);
      } while (next === this.index);
    } else {
      next = this.index + 1;
    }

    if (next >= this.queue.length) {
      if (this.repeat === 'all') next = 0;
      else return this.stop();
    }
    return this.playIndex(next);
  }

  async next() {
    return this._advance(false);
  }

  async previous() {
    // Standard behaviour: restart the track if we're more than 3s in.
    const pos = this.mpv.props['time-pos'] || 0;
    if (pos > 3) return this.seek(0);
    if (this.index <= 0) {
      if (this.repeat === 'all') return this.playIndex(this.queue.length - 1);
      return this.seek(0);
    }
    return this.playIndex(this.index - 1);
  }

  async pause() {
    await this.mpv.set('pause', true);
    this.emit('change');
    return this.state();
  }

  async resume() {
    this.cancelFade();
    if (this.stopped && !this.stream && this.queue.length) {
      return this.playIndex(Math.max(this.index, 0));
    }
    await this.mpv.set('pause', false);
    this.emit('change');
    return this.state();
  }

  async toggle() {
    if (this.stopped) return this.resume();
    const paused = await this.mpv.get('pause').catch(() => false);
    return paused ? this.resume() : this.pause();
  }

  async stop() {
    this._switching = true;
    this.stopped = true;
    this.stream = null;
    await this.mpv.stop().catch(() => {});
    setTimeout(() => {
      this._switching = false;
    }, 300);
    this.emit('change');
    return this.state();
  }

  async seek(seconds) {
    await this.mpv.command('seek', Math.max(0, seconds), 'absolute').catch(() => {});
    this.emit('change');
    return this.state();
  }

  async setVolume(v) {
    await this.mpv.set('volume', Math.max(0, Math.min(130, Math.round(v))));
    this.emit('change');
    return this.state();
  }

  async setMuted(muted) {
    await this.mpv.set('mute', Boolean(muted));
    this.emit('change');
    return this.state();
  }

  setRepeat(mode) {
    if (['off', 'all', 'one'].includes(mode)) this.repeat = mode;
    this.emit('change');
    return this.state();
  }

  setShuffle(on) {
    this.shuffle = Boolean(on);
    this.emit('change');
    return this.state();
  }

  state() {
    const p = this.mpv.props;
    const track = this.currentTrack;
    const idle = p['idle-active'] === true;
    return {
      connected: this.mpv.connected,
      track: track
        ? { ...track, path: undefined } // don't leak server filesystem paths
        : null,
      isStream: Boolean(this.stream),
      fading: Boolean(this._fade),
      index: this.index,
      queue: this.queue.map((id) => {
        const t = this.library.get(id);
        return t ? { ...t, path: undefined } : { id, title: id, artist: '', album: '', duration: 0 };
      }),
      playing: !this.stopped && !idle && p.pause === false,
      paused: p.pause === true,
      stopped: this.stopped || idle,
      position: p['time-pos'] ?? 0,
      duration: p.duration ?? track?.duration ?? 0,
      volume: p.volume ?? 80,
      muted: p.mute === true,
      repeat: this.repeat,
      shuffle: this.shuffle,
    };
  }
}
