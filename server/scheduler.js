/**
 * Timezone-aware daily job runner.
 *
 * Deliberately not cron: we need "15:00 in Asia/Manila" regardless of what
 * the server's own clock is set to, and we need it to stay correct if the
 * host timezone or the user's setting changes at runtime.
 *
 * Everything is computed from Intl.DateTimeFormat, so no tz database
 * dependency and no DST bookkeeping of our own.
 */
import { EventEmitter } from 'node:events';

const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts for `date` as seen in `timezone`. */
export function zonedNow(timezone, date = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23', // avoids the "24:xx" quirk of hour12:false
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(date);
  } catch {
    return zonedNow('UTC', date);
  }

  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: DAY_INDEX[p.weekday] ?? 0,
    label: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
  };
}

export function parseTime(value) {
  const [h, m] = String(value).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export class Scheduler extends EventEmitter {
  /**
   * @param getSettings  () => settings object
   * @param jobs         [{ name, config(settings) -> {enabled,time,days}, run() }]
   * @param graceMinutes how late a job may still fire (missed window otherwise)
   */
  constructor({ getSettings, jobs, graceMinutes = 15, intervalMs = 20000 }) {
    super();
    this.getSettings = getSettings;
    this.jobs = jobs;
    this.graceMinutes = graceMinutes;
    this.intervalMs = intervalMs;
    this.lastRun = new Map();  // job name -> runKey()
    this.running = new Set();
    this.timer = null;
  }

  /**
   * The "already handled today" marker.
   *
   * Keyed on the schedule as well as the date: editing the time in the UI
   * must re-arm the job. Keying on the date alone meant that changing
   * "22:00" to "16:00" at lunchtime left the morning's boot-time
   * "already past its window" mark in place, silently suppressing the run.
   */
  runKey(now, cfg) {
    return `${now.date}@${cfg.time}@${[...cfg.days].sort().join('')}`;
  }

  start() {
    // On boot, mark anything already past its window as handled so restarting
    // the server at 6pm doesn't fire the 3pm podcast.
    const settings = this.getSettings();
    const now = zonedNow(settings.timezone);
    for (const job of this.jobs) {
      const cfg = job.config(settings);
      if (now.minutes - parseTime(cfg.time) > this.graceMinutes) {
        this.lastRun.set(job.name, this.runKey(now, cfg));
      }
    }

    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.emit('started', now);
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(date = new Date()) {
    const settings = this.getSettings();
    const now = zonedNow(settings.timezone, date);

    for (const job of this.jobs) {
      const cfg = job.config(settings);
      if (!cfg.enabled) continue;
      if (!cfg.days.includes(now.weekday)) continue;

      const key = this.runKey(now, cfg);
      if (this.lastRun.get(job.name) === key) continue;
      if (this.running.has(job.name)) continue;

      const delta = now.minutes - parseTime(cfg.time);
      if (delta < 0) continue;

      // Past the grace window (server was asleep, clock jumped): skip today.
      if (delta > this.graceMinutes) {
        this.lastRun.set(job.name, key);
        this.emit('missed', { job: job.name, date: now.date, lateBy: delta });
        continue;
      }

      this.lastRun.set(job.name, key);
      this.running.add(job.name);
      this.emit('fire', { job: job.name, at: now.label });
      try {
        await job.run();
      } catch (err) {
        this.emit('job-error', { job: job.name, error: err.message });
      } finally {
        this.running.delete(job.name);
      }
    }
  }

  /** Human-readable next-run info for the settings UI. */
  status(date = new Date()) {
    const settings = this.getSettings();
    const now = zonedNow(settings.timezone, date);

    return {
      timezone: settings.timezone,
      now: now.label,
      jobs: this.jobs.map((job) => {
        const cfg = job.config(settings);
        return {
          name: job.name,
          enabled: cfg.enabled,
          time: cfg.time,
          days: cfg.days,
          ranToday: this.lastRun.get(job.name) === this.runKey(now, cfg),
          nextRun: cfg.enabled ? nextRunLabel(cfg, now) : null,
        };
      }),
    };
  }
}

function nextRunLabel(cfg, now) {
  const target = parseTime(cfg.time);
  for (let offset = 0; offset < 8; offset++) {
    const weekday = (now.weekday + offset) % 7;
    if (!cfg.days.includes(weekday)) continue;
    if (offset === 0 && now.minutes >= target) continue;
    if (offset === 0) return `today at ${cfg.time}`;
    if (offset === 1) return `tomorrow at ${cfg.time}`;
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday]} at ${cfg.time}`;
  }
  return null;
}
