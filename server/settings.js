/**
 * Persisted user settings (schedules, timezone).
 *
 * Stored as JSON next to the app so it survives restarts and container
 * rebuilds when config.json is on a mounted volume.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  // Philippine time. No DST, permanently UTC+8.
  timezone: 'Asia/Manila',

  autoStop: {
    enabled: false,
    time: '22:00',       // 24-hour, in `timezone`
    fadeSeconds: 10,     // 0 = hard stop
    days: [0, 1, 2, 3, 4, 5, 6],
  },

  podcast: {
    enabled: false,
    time: '15:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    feedUrl: 'https://feeds.transistor.fm/our-daily-bread-podcast',
    // 'interrupt' — stop whatever is playing, play today's episode, then stop.
    mode: 'interrupt',
  },
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function clean(patch, current) {
  const next = structuredClone(current);

  if (typeof patch.timezone === 'string' && isValidTimezone(patch.timezone)) {
    next.timezone = patch.timezone;
  }

  for (const key of ['autoStop', 'podcast']) {
    const p = patch[key];
    if (!p || typeof p !== 'object') continue;

    if (typeof p.enabled === 'boolean') next[key].enabled = p.enabled;
    if (typeof p.time === 'string' && TIME_RE.test(p.time)) next[key].time = p.time;
    if (Array.isArray(p.days)) {
      const days = [...new Set(p.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      if (days.length) next[key].days = days;
    }
  }

  if (patch.autoStop && Number.isFinite(Number(patch.autoStop.fadeSeconds))) {
    next.autoStop.fadeSeconds = Math.max(0, Math.min(120, Number(patch.autoStop.fadeSeconds)));
  }
  if (patch.podcast) {
    if (typeof patch.podcast.feedUrl === 'string') {
      try {
        const u = new URL(patch.podcast.feedUrl);
        if (u.protocol === 'http:' || u.protocol === 'https:') next.podcast.feedUrl = u.href;
      } catch {
        /* keep the existing feed */
      }
    }
    if (['interrupt', 'queue'].includes(patch.podcast.mode)) next.podcast.mode = patch.podcast.mode;
  }

  return next;
}

export class Settings extends EventEmitter {
  constructor(filePath = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.json')) {
    super();
    this.file = filePath;
    this.values = structuredClone(DEFAULTS);
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.values = clean(raw, DEFAULTS);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[settings] ${this.file} unreadable, using defaults`);
    }
    return this.values;
  }

  save() {
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
    fs.renameSync(tmp, this.file);
  }

  update(patch) {
    this.values = clean(patch || {}, this.values);
    try {
      this.save();
    } catch (err) {
      console.warn(`[settings] could not persist: ${err.message}`);
    }
    this.emit('change', this.values);
    return this.values;
  }

  get() {
    return this.values;
  }
}
