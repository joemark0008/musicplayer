#!/usr/bin/env node
/**
 * Unit tests for the pieces that are hard to eyeball: timezone maths,
 * the daily fire-once rule, settings validation, and RSS parsing.
 *
 *   node test/schedule-test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler, zonedNow, parseTime } from '../server/scheduler.js';
import { Settings, DEFAULTS } from '../server/settings.js';
import { parseFeed } from '../server/podcast.js';

let passed = 0;
let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ------------------------------------------------------------- timezone */
console.log('\nTimezone (Asia/Manila = UTC+8, no DST)');
{
  const winter = zonedNow('Asia/Manila', new Date('2026-01-15T07:00:00Z'));
  check('07:00 UTC in January is 15:00 PH', winter.hour === 15 && winter.minute === 0, winter.label);

  const summer = zonedNow('Asia/Manila', new Date('2026-08-07T07:00:00Z'));
  check('07:00 UTC in August is also 15:00 PH (no DST)', summer.hour === 15, summer.label);

  const rollover = zonedNow('Asia/Manila', new Date('2026-08-07T16:30:00Z'));
  check('crosses the date line correctly', rollover.date === '2026-08-08' && rollover.hour === 0,
    rollover.label);

  const weekday = zonedNow('Asia/Manila', new Date('2026-08-07T07:00:00Z'));
  check('weekday index is right (2026-08-07 is a Friday)', weekday.weekday === 5, String(weekday.weekday));

  check('midnight reads as hour 0, not 24', zonedNow('UTC', new Date('2026-08-07T00:10:00Z')).hour === 0);
  check('parseTime handles HH:MM', parseTime('15:00') === 900 && parseTime('00:30') === 30);

  const bogus = zonedNow('Not/AZone', new Date('2026-08-07T07:00:00Z'));
  check('falls back to UTC on an invalid timezone', bogus.hour === 7);
}

/* ------------------------------------------------------------ scheduler */
console.log('\nScheduler');
{
  const fired = [];
  const settings = {
    timezone: 'Asia/Manila',
    podcast: { enabled: true, time: '15:00', days: [0, 1, 2, 3, 4, 5, 6] },
    autoStop: { enabled: true, time: '22:00', days: [0, 1, 2, 3, 4, 5, 6] },
  };
  const sched = new Scheduler({
    getSettings: () => settings,
    jobs: [
      { name: 'podcast', config: (s) => s.podcast, run: async () => fired.push('podcast') },
      { name: 'autoStop', config: (s) => s.autoStop, run: async () => fired.push('autoStop') },
    ],
  });

  const at = (iso) => sched.tick(new Date(iso));

  await at('2026-08-07T06:59:00Z');        // 14:59 PH
  check('does not fire early', fired.length === 0, fired.join(','));

  await at('2026-08-07T07:00:00Z');        // 15:00 PH
  check('fires at the scheduled minute', fired.join(',') === 'podcast');

  await at('2026-08-07T07:05:00Z');
  check('does not fire twice the same day', fired.join(',') === 'podcast');

  await at('2026-08-07T14:00:00Z');        // 22:00 PH
  check('independent jobs fire independently', fired.join(',') === 'podcast,autoStop');

  await at('2026-08-08T07:00:00Z');        // next day 15:00 PH
  check('fires again the next day', fired.filter((f) => f === 'podcast').length === 2);

  // Late start: 16:00 PH is 60 min past the 15:00 window (grace is 15).
  const late = [];
  const missed = [];
  const sched2 = new Scheduler({
    getSettings: () => settings,
    jobs: [{ name: 'podcast', config: (s) => s.podcast, run: async () => late.push(1) }],
  });
  sched2.on('missed', (e) => missed.push(e));
  await sched2.tick(new Date('2026-08-07T08:00:00Z'));
  check('skips a job that is past its grace window', late.length === 0 && missed.length === 1);

  // Day filter
  const weekdayOnly = [];
  const settings3 = {
    timezone: 'Asia/Manila',
    podcast: { enabled: true, time: '15:00', days: [1, 2, 3, 4, 5] },
  };
  const sched3 = new Scheduler({
    getSettings: () => settings3,
    jobs: [{ name: 'podcast', config: (s) => s.podcast, run: async () => weekdayOnly.push(1) }],
  });
  await sched3.tick(new Date('2026-08-08T07:00:00Z')); // Saturday PH
  check('respects the day filter', weekdayOnly.length === 0);
  await sched3.tick(new Date('2026-08-10T07:00:00Z')); // Monday PH
  check('runs on a selected day', weekdayOnly.length === 1);

  // Disabled
  const off = [];
  const settings4 = { timezone: 'Asia/Manila', podcast: { enabled: false, time: '15:00', days: [0,1,2,3,4,5,6] } };
  const sched4 = new Scheduler({
    getSettings: () => settings4,
    jobs: [{ name: 'podcast', config: (s) => s.podcast, run: async () => off.push(1) }],
  });
  await sched4.tick(new Date('2026-08-07T07:00:00Z'));
  check('does nothing when disabled', off.length === 0);

  const status = sched.status(new Date('2026-08-08T02:00:00Z')); // 10:00 PH
  check('reports a next-run label', status.jobs[0].nextRun === 'today at 15:00', status.jobs[0].nextRun);
}

/* ------------------------------------- regression: editing a live schedule */
console.log('\nEditing a schedule re-arms the job');
{
  // Reproduces a real failure: the service booted with auto-stop at 22:00,
  // the user later moved it to 16:00, and the boot-time "already past its
  // window" mark (keyed only on the date) suppressed the 16:00 run.
  const fired = [];
  const settings = {
    timezone: 'Asia/Manila',
    autoStop: { enabled: true, time: '12:00', days: [0, 1, 2, 3, 4, 5, 6] },
  };
  const sched = new Scheduler({
    getSettings: () => settings,
    jobs: [{ name: 'autoStop', config: (s) => s.autoStop, run: async () => fired.push(1) }],
  });

  // Boot at 13:01 PH — 61 minutes past the 12:00 setting, so it's marked handled.
  const boot = new Date('2026-08-10T05:01:00Z');
  sched.getSettings = () => settings;
  const now = zonedNow('Asia/Manila', boot);
  sched.lastRun.set('autoStop', sched.runKey(now, settings.autoStop));

  check('a past-due job is marked handled at boot',
    sched.status(boot).jobs[0].ranToday === true);

  // User edits the time to 16:00.
  settings.autoStop.time = '16:00';
  check('editing the time clears the stale ranToday flag',
    sched.status(boot).jobs[0].ranToday === false);

  await sched.tick(new Date('2026-08-10T08:00:00Z')); // 16:00 PH
  check('the job fires at the new time', fired.length === 1, `fired ${fired.length}x`);

  await sched.tick(new Date('2026-08-10T08:05:00Z'));
  check('and still only fires once', fired.length === 1);

  // Changing the day list re-arms too.
  settings.autoStop.days = [1];
  check('editing the days also re-arms', sched.status(new Date('2026-08-10T08:05:00Z')).jobs[0].ranToday === false);
}

/* ------------------------------------------------------------- settings */
console.log('\nSettings validation');
{
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  const s = new Settings(file);

  check('starts from defaults', s.get().timezone === 'Asia/Manila' && s.get().podcast.time === '15:00');

  s.update({ podcast: { time: '25:99' } });
  check('rejects an invalid time', s.get().podcast.time === '15:00');

  s.update({ podcast: { time: '06:30' } });
  check('accepts a valid time', s.get().podcast.time === '06:30');

  s.update({ timezone: 'Nope/Nope' });
  check('rejects an invalid timezone', s.get().timezone === 'Asia/Manila');

  s.update({ autoStop: { fadeSeconds: 9999 } });
  check('clamps the fade length', s.get().autoStop.fadeSeconds === 120);

  s.update({ podcast: { days: [9, 1, 1, -3, 4] } });
  check('sanitises the day list', JSON.stringify(s.get().podcast.days) === '[1,4]',
    JSON.stringify(s.get().podcast.days));

  s.update({ podcast: { feedUrl: 'javascript:alert(1)' } });
  check('rejects a non-http feed url', s.get().podcast.feedUrl === DEFAULTS.podcast.feedUrl);

  s.update({ podcast: { feedUrl: 'https://example.com/feed.xml' } });
  check('accepts an https feed url', s.get().podcast.feedUrl === 'https://example.com/feed.xml');

  check('persists to disk', new Settings(file).get().podcast.time === '06:30');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

/* -------------------------------------------------------------- podcast */
console.log('\nRSS parsing');
{
  const xml = `<?xml version="1.0"?>
  <rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
   <channel>
    <title>Our Daily Bread Podcast</title>
    <item>
      <title><![CDATA[Older Episode]]></title>
      <pubDate>Wed, 05 Aug 2026 04:00:00 -0000</pubDate>
      <enclosure url="https://example.com/older.mp3" length="1" type="audio/mpeg"/>
      <itunes:duration>00:03:24</itunes:duration>
    </item>
    <item>
      <title>Today &amp; Always</title>
      <pubDate>Fri, 07 Aug 2026 04:00:00 -0000</pubDate>
      <enclosure length="1" type="audio/mpeg" url="https://example.com/today.mp3"/>
      <itunes:duration>229</itunes:duration>
      <guid isPermaLink="false">abc-123</guid>
    </item>
    <item>
      <title>No Audio Here</title>
      <pubDate>Sat, 08 Aug 2026 04:00:00 -0000</pubDate>
    </item>
   </channel>
  </rss>`;

  const { feedTitle, episodes } = parseFeed(xml);
  check('reads the feed title', feedTitle === 'Our Daily Bread Podcast', feedTitle);
  check('skips items with no enclosure', episodes.length === 2, String(episodes.length));
  check('picks the newest by pubDate, not feed order', episodes[0].url === 'https://example.com/today.mp3',
    episodes[0].url);
  check('decodes entities in titles', episodes[0].title === 'Today & Always', episodes[0].title);
  check('strips CDATA', episodes[1].title === 'Older Episode', episodes[1].title);
  check('parses bare-seconds duration', episodes[0].duration === 229, String(episodes[0].duration));
  check('parses HH:MM:SS duration', episodes[1].duration === 204, String(episodes[1].duration));
  check('handles url before other enclosure attrs', episodes[1].url === 'https://example.com/older.mp3');
  check('normalises pubDate to ISO', episodes[0].pubDate?.startsWith('2026-08-07'), episodes[0].pubDate);

  check('empty feed yields no episodes', parseFeed('<rss><channel></channel></rss>').episodes.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
