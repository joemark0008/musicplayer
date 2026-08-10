#!/usr/bin/env node
/**
 * End-to-end check of the API and queue logic against test/fake-mpv.js.
 * No real audio, no mpv install required.
 *
 *   node test/smoke-test.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const get = (p) => fetch(BASE + p).then((r) => r.json());
const send = (method) => (p, body) =>
  fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => r.json());
const post = send('POST');
const put = send('PUT');

/** Stands in for the podcast host so the tests never touch the network. */
function startFeedServer() {
  const xml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
 <channel>
  <title>Test Daily Bread</title>
  <item>
    <title>Yesterday's Episode</title>
    <pubDate>Thu, 06 Aug 2026 04:00:00 -0000</pubDate>
    <enclosure url="http://127.0.0.1:9/yesterday.mp3" type="audio/mpeg" length="1"/>
  </item>
  <item>
    <title>Today's Episode</title>
    <pubDate>Fri, 07 Aug 2026 04:00:00 -0000</pubDate>
    <enclosure url="http://127.0.0.1:9/today.mp3" type="audio/mpeg" length="1"/>
    <itunes:duration>00:03:49</itunes:duration>
  </item>
 </channel>
</rss>`;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(xml);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/feed.xml` }));
  });
}

async function main() {
  // ---- fixtures --------------------------------------------------------
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-test-'));
  fs.mkdirSync(path.join(musicDir, 'Album One'));
  const files = [
    'Artist A - Song One.mp3',
    'Album One/Artist B - Song Two.flac',
    'Album One/03 Song Three.ogg',
    'not-audio.txt',
  ];
  for (const f of files) fs.writeFileSync(path.join(musicDir, f), 'x');

  const wrapper = path.join(os.tmpdir(), `fake-mpv-${process.pid}.sh`);
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fake-mpv.js')}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MUSIC_DIR: musicDir,
      MPV_BINARY: wrapper,
      MPV_SOCKET: path.join(os.tmpdir(), `fake-mpv-${process.pid}.sock`),
      CONFIG_PATH: path.join(musicDir, 'test-config.json'),
      FAKE_DURATION: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`  [server:err] ${d}`));

  const cleanup = () => {
    server.kill('SIGTERM');
    try { fs.rmSync(musicDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(wrapper, { force: true }); } catch {}
  };

  try {
    // wait for the port
    for (let i = 0; i < 60; i++) {
      try {
        await get('/api/state');
        break;
      } catch {
        await sleep(200);
      }
    }

    console.log('\nLibrary');
    const lib = await get('/api/library');
    check('scans audio files only', lib.total === 3, `got ${lib.total}`);
    const byId = Object.fromEntries(lib.tracks.map((t) => [t.id, t]));
    const song1 = lib.tracks.find((t) => t.id === 'Artist A - Song One.mp3');
    check('parses "Artist - Title" filenames', song1?.artist === 'Artist A' && song1?.title === 'Song One',
      JSON.stringify(song1));
    check('never exposes server filesystem paths', lib.tracks.every((t) => t.path === undefined));
    check('search filters', (await get('/api/library?q=three')).count === 1);
    check('reports how many tracks are hidden inside playlists', lib.inPlaylists === 0,
      String(lib.inPlaylists));

    console.log('\nQueue and playback');
    const ids = lib.tracks.map((t) => t.id);
    let s = await post('/api/queue', { ids });
    check('queue is populated', s.queue.length === 3);
    check('playback starts at index 0', s.index === 0 && s.playing === true, JSON.stringify({ i: s.index, p: s.playing }));
    check('current track is reported', s.track?.id === ids[0]);

    s = await post('/api/next');
    check('next advances', s.index === 1);
    s = await post('/api/previous');
    check('previous goes back', s.index === 0);

    s = await post('/api/volume', { volume: 55 });
    check('volume is applied', Math.round(s.volume) === 55, `got ${s.volume}`);
    s = await post('/api/mute', { muted: true });
    check('mute is applied', s.muted === true);
    await post('/api/mute', { muted: false });

    s = await post('/api/seek', { position: 2 });
    check('seek moves position', Math.round(s.position) === 2, `got ${s.position}`);

    s = await post('/api/toggle');
    check('toggle pauses', s.paused === true && s.playing === false);
    s = await post('/api/toggle');
    check('toggle resumes', s.playing === true);

    console.log('\nAuto-advance');
    await post('/api/queue', { ids });          // restart from the top
    await post('/api/repeat', { mode: 'all' });
    const before = (await get('/api/state')).index;
    await sleep(4500);                           // FAKE_DURATION = 3s
    const after = await get('/api/state');
    check('advances to the next track at EOF', after.index !== before, `${before} -> ${after.index}`);
    check('keeps playing after advancing', after.playing === true);

    console.log('\nQueue editing');
    s = await post('/api/queue', { ids });
    s = await post('/api/queue/move', { from: 2, to: 0 });
    check('move reorders', s.queue[0].id === ids[2]);
    check('move keeps the current track selected', s.queue[s.index].id === ids[0]);
    s = await post('/api/queue/remove', { index: 0 });
    check('remove drops the row', s.queue.length === 2 && s.queue[0].id === ids[0]);
    s = await post('/api/queue/add', { ids: [ids[2]] });
    check('add appends', s.queue.length === 3);
    s = await post('/api/queue/clear');
    check('clear empties and stops', s.queue.length === 0 && s.stopped === true);

    console.log('\nSafety');
    s = await post('/api/play', { id: '../../../etc/passwd' });
    check('rejects path traversal ids', s.track === null && s.queue.length === 0, JSON.stringify(s.track));
    s = await post('/api/queue', { ids: ['nope.mp3', ids[0]] });
    check('ignores unknown ids', s.queue.length === 1);

    console.log('\nWebSocket');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const first = await new Promise((resolve, reject) => {
      ws.on('message', (data) => resolve(JSON.parse(data)));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    check('pushes state on connect', first.type === 'state' && Array.isArray(first.state.queue));
    const pushed = await new Promise((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data)));
      post('/api/pause');
    });
    check('pushes state on change', pushed.type === 'state');
    ws.close();

    console.log('\nSettings');
    let cfg = await get('/api/settings');
    check('defaults to Philippine time', cfg.settings.timezone === 'Asia/Manila');
    check('defaults the podcast to 15:00', cfg.settings.podcast.time === '15:00');
    check('schedules are off until enabled', cfg.settings.podcast.enabled === false);

    const clock = await get('/api/time');
    check('reports the wall clock in the configured zone',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(clock.label), clock.label);

    cfg = await put('/api/settings', { podcast: { enabled: true, time: '15:30' } });
    check('saves a schedule change', cfg.settings.podcast.time === '15:30' && cfg.settings.podcast.enabled);
    check('reports the next run', Boolean(cfg.schedule.jobs.find((j) => j.name === 'podcast').nextRun));

    console.log('\nPodcast');
    const { srv, url } = await startFeedServer();
    try {
      await put('/api/settings', { podcast: { feedUrl: url } });
      const latest = await get('/api/podcast/latest?refresh=1');
      check('reads the feed', latest.feedTitle === 'Test Daily Bread', latest.feedTitle);
      check('picks the newest episode', latest.episode.title === "Today's Episode", latest.episode.title);
      check('parses the episode length', latest.episode.duration === 229, String(latest.episode.duration));

      await post('/api/queue/clear');
      s = await post('/api/podcast/play');
      check('streams the episode', s.isStream === true && s.playing === true);
      check('shows the episode as the current track', s.track?.title === "Today's Episode", s.track?.title);
      check('is not added to the music queue', s.queue.length === 0 && s.index === -1,
        JSON.stringify({ queue: s.queue.length, index: s.index }));

      // The scheduled job must do exactly what the manual button does.
      await post('/api/queue', { ids });
      s = await post('/api/schedule/run', { job: 'podcast' });
      check('the 3PM job interrupts music', s.isStream === true && s.track?.title === "Today's Episode");

      s = await get('/api/state');
      check('interrupting leaves the queue intact', s.queue.length === 3);

      console.log('\nResuming music after the episode');
      // Play track 2, get a few seconds in, then let the podcast interrupt.
      await put('/api/settings', { podcast: { resumeAfter: true } });
      await post('/api/queue', { ids });
      await post('/api/play', { index: 1 });
      await sleep(1200);
      const before = await get('/api/state');
      check('music is playing before the interruption', before.playing && before.index === 1);

      s = await post('/api/podcast/play');
      check('the bookmark is armed', s.willResume === true);
      check('podcast is playing', s.isStream === true);

      await sleep(4200);            // fake episode is 3s long
      s = await get('/api/state');
      check('music resumes when the episode ends', s.isStream === false && s.playing === true);
      check('it resumes the same track', s.index === 1, `index ${s.index}`);
      check('the bookmark is cleared afterwards', s.willResume === false);

      // With the setting off, it should stop instead.
      await put('/api/settings', { podcast: { resumeAfter: false } });
      await post('/api/queue', { ids });
      await post('/api/play', { index: 0 });
      await sleep(600);
      s = await post('/api/podcast/play');
      check('no bookmark when the setting is off', s.willResume === false);
      await sleep(4200);
      s = await get('/api/state');
      check('it stops instead of resuming', s.stopped === true && s.playing === false);

      // A manual stop during the episode must cancel the pending resume.
      await put('/api/settings', { podcast: { resumeAfter: true } });
      await post('/api/queue', { ids });
      await post('/api/play', { index: 0 });
      await sleep(600);
      await post('/api/podcast/play');
      s = await post('/api/stop');
      check('stopping by hand cancels the pending resume', s.willResume === false);
      await sleep(1000);
      check('and nothing starts playing later', (await get('/api/state')).playing === false);
    } finally {
      srv.close();
    }

    console.log('\nAuto-stop');
    await post('/api/queue', { ids });
    await post('/api/volume', { volume: 80 });
    const fading = post('/api/fade-stop', { seconds: 1 });
    await sleep(300);
    const mid = await get('/api/state');
    check('volume drops during the fade', mid.volume < 80, `got ${mid.volume}`);
    check('state reports that it is fading', mid.fading === true);

    s = await fading;
    check('playback stops when the fade ends', s.stopped === true);
    await sleep(200);
    check('volume is restored afterwards', Math.round((await get('/api/state')).volume) === 80,
      `got ${(await get('/api/state')).volume}`);

    await post('/api/queue', { ids });
    const cancelled = post('/api/fade-stop', { seconds: 6 });
    await sleep(500);
    await post('/api/play', { index: 0 });    // user intervenes mid-fade
    await cancelled;
    await sleep(200);
    s = await get('/api/state');
    check('a user pressing play cancels the fade', s.playing === true && s.fading === false);
    check('cancelling restores the volume', Math.round(s.volume) === 80, `got ${s.volume}`);

    await put('/api/settings', { autoStop: { fadeSeconds: 0 } });
    s = await post('/api/schedule/run', { job: 'autoStop' });
    check('fadeSeconds 0 stops instantly', s.stopped === true);
    s = await post('/api/schedule/run', { job: 'nope' });
    check('unknown jobs are rejected', Boolean(s.error));

    console.log('\nAuto-start');
    cfg = await get('/api/settings');
    check('defaults to 08:00, disabled', cfg.settings.autoStart.time === '08:00'
      && cfg.settings.autoStart.enabled === false);
    check('has no playlist until you pick one', cfg.settings.autoStart.playlist === '');

    // Refuses to fire with nothing selected, rather than doing something random.
    await put('/api/settings', { autoStart: { enabled: true } });
    s = await post('/api/schedule/run', { job: 'autoStart' });
    check('errors when no playlist is chosen', /no playlist/.test(s.error || ''), JSON.stringify(s));

    s = await put('/api/settings', { autoStart: { playlist: 'Ghost Playlist' } });
    check('a missing playlist name is still stored', s.settings.autoStart.playlist === 'Ghost Playlist');
    s = await post('/api/schedule/run', { job: 'autoStart' });
    check('errors when the playlist no longer exists', /no longer exists/.test(s.error || ''), JSON.stringify(s));

    // Build a real playlist out of the library and start it.
    await post('/api/playlists', { name: 'Morning' });
    await post('/api/playlists/Morning/tracks', { ids });
    await post('/api/stop');
    await post('/api/volume', { volume: 95 });
    await put('/api/settings', { autoStart: { playlist: 'Morning', volume: 42, setVolume: true, shuffle: false } });

    s = await post('/api/schedule/run', { job: 'autoStart' });
    check('queues the playlist', s.queue.length === 3, String(s.queue.length));
    check('starts playing', s.playing === true);
    check('starts at the first track', s.index === 0);
    check('applies the configured volume', Math.round(s.volume) === 42, `got ${s.volume}`);
    check('plays the playlist copies, not the originals',
      s.queue.every((t) => t.id.startsWith('Playlists/Morning/')), s.queue[0]?.id);

    // The "my library looks empty" case: everything lives inside playlists.
    const hidden = await get('/api/library');
    check('playlist tracks stay out of the main library list', hidden.total === 3, String(hidden.total));
    check('but are counted so the UI can explain why', hidden.inPlaylists === 3,
      String(hidden.inPlaylists));
    const shown = await get('/api/library?include=playlists');
    check('include=playlists reveals them', shown.total === 6, String(shown.total));
    check('and flags that it did', shown.includingPlaylists === true);

    await put('/api/settings', { autoStart: { setVolume: false } });
    await post('/api/volume', { volume: 77 });
    s = await post('/api/schedule/run', { job: 'autoStart' });
    check('leaves the volume alone when told to', Math.round(s.volume) === 77, `got ${s.volume}`);

    await put('/api/settings', { autoStart: { shuffle: true } });
    s = await post('/api/schedule/run', { job: 'autoStart' });
    check('shuffle mode is switched on', s.shuffle === true);

    await post('/api/playlists/Morning/delete', { force: true });
    await put('/api/settings', { autoStart: { enabled: false, shuffle: false } });
  } finally {
    cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
