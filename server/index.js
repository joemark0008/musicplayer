/**
 * Remote music server.
 *
 * Audio is produced by an mpv process on this machine. The React UI
 * running in your browser only sends commands and renders state.
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Mpv } from './mpv.js';
import { Library, hasTagSupport } from './library.js';
import { Player } from './player.js';
import { Settings } from './settings.js';
import { Scheduler, zonedNow } from './scheduler.js';
import { fetchLatestEpisode } from './podcast.js';
import { Playlists } from './playlists.js';
import { Downloader } from './downloads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(process.env.HOME || '/root', 'Music');
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || null;
const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

const mpv = new Mpv({ audioDevice: AUDIO_DEVICE, binary: process.env.MPV_BINARY || 'mpv' });
const library = new Library(MUSIC_DIR);
const player = new Player(mpv, library);
const settings = new Settings();
const playlists = new Playlists(library);
const downloader = new Downloader({ library, playlists });

// --------------------------------------------------------- scheduled jobs
async function playTodaysEpisode() {
  const { feedUrl, mode, resumeAfter } = settings.get().podcast;
  const { episode, feedTitle } = await fetchLatestEpisode(feedUrl, { force: true });

  if (mode === 'queue') {
    // Nothing to enqueue against — streams aren't library tracks — so this
    // still plays now, but without interrupting a track mid-way.
    if (player.state().playing) {
      player.emit('warning', `Podcast ready: ${episode.title}`);
      return episode;
    }
  }

  await player.playStream({
    url: episode.url,
    title: episode.title,
    artist: feedTitle || 'Podcast',
    album: episode.pubDate ? new Date(episode.pubDate).toDateString() : '',
    duration: episode.duration,
    source: 'podcast',
    resumeAfter,
  });
  return episode;
}

async function startMorningPlaylist() {
  const cfg = settings.get().autoStart;

  if (!cfg.playlist) throw new Error('no playlist chosen for auto-start');
  if (!playlists.resolveExisting(cfg.playlist)) {
    throw new Error(`playlist "${cfg.playlist}" no longer exists`);
  }

  const ids = playlists.tracksOf(cfg.playlist).map((t) => t.id);
  if (!ids.length) throw new Error(`playlist "${cfg.playlist}" is empty`);

  // Volume first, so the very first note is at the level you asked for.
  if (cfg.setVolume) await player.setVolume(cfg.volume);

  player.setShuffle(cfg.shuffle);
  await player.setQueue(ids, { startIndex: cfg.shuffle ? Math.floor(Math.random() * ids.length) : 0 });

  return { playlist: cfg.playlist, tracks: ids.length };
}

const scheduler = new Scheduler({
  getSettings: () => settings.get(),
  jobs: [
    {
      name: 'autoStart',
      config: (s) => s.autoStart,
      run: async () => {
        const result = await startMorningPlaylist();
        console.log(`[schedule] auto-start → ${result.playlist} (${result.tracks} tracks)`);
      },
    },
    {
      name: 'podcast',
      config: (s) => s.podcast,
      run: async () => {
        const episode = await playTodaysEpisode();
        console.log(`[schedule] podcast → ${episode.title}`);
      },
    },
    {
      name: 'autoStop',
      config: (s) => s.autoStop,
      run: async () => {
        const { fadeSeconds } = settings.get().autoStop;
        console.log(`[schedule] auto-stop (fade ${fadeSeconds}s)`);
        await player.fadeOutAndStop(fadeSeconds);
      },
    },
  ],
});

scheduler.on('fire', ({ job, at }) => console.log(`[schedule] ${job} fired at ${at}`));
scheduler.on('missed', ({ job, lateBy }) =>
  console.log(`[schedule] ${job} skipped (${lateBy} min past its window)`)
);
scheduler.on('job-error', ({ job, error }) => {
  console.error(`[schedule] ${job} failed: ${error}`);
  player.emit('warning', `Scheduled ${job} failed: ${error}`);
});

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------- auth
// Off by default (LAN use). Set AUTH_TOKEN to require a shared secret.
app.use('/api', (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '') || req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
});

const ok = (res, promise) =>
  Promise.resolve(promise)
    .then((data) => res.json(data ?? player.state()))
    .catch((err) => res.status(500).json({ error: String(err.message || err) }));

// -------------------------------------------------------------- library
app.get('/api/library', (req, res) => {
  // Playlist folders are indexed (so their tracks are playable) but hidden
  // from the main list — otherwise every song in a playlist appears twice.
  const includePlaylists = req.query.include === 'playlists';
  const visible = (t) => includePlaylists || !playlists.isPlaylistTrack(t.id);

  const tracks = library.search(req.query.q).filter(visible);
  res.json({
    root: MUSIC_DIR,
    count: tracks.length,
    total: library.tracks.filter(visible).length,
    // So the UI can say "your music is all in playlists" rather than the
    // misleading "no audio files found".
    inPlaylists: library.tracks.filter((t) => playlists.isPlaylistTrack(t.id)).length,
    includingPlaylists: includePlaylists,
    lastScan: library.lastScan,
    tagSupport: hasTagSupport,
    tracks: tracks.map((t) => ({ ...t, path: undefined })),
  });
});

app.post('/api/library/scan', (req, res) =>
  ok(res, library.scan().then((t) => ({ scanned: t.length, lastScan: library.lastScan })))
);

// ------------------------------------------------------------- playback
app.get('/api/state', (req, res) => res.json(player.state()));

app.post('/api/play', (req, res) => {
  const { id, index } = req.body || {};
  if (typeof index === 'number') return ok(res, player.playIndex(index));
  if (id) return ok(res, player.playTrack(id));
  return ok(res, player.resume());
});

app.post('/api/pause', (req, res) => ok(res, player.pause()));
app.post('/api/toggle', (req, res) => ok(res, player.toggle()));
app.post('/api/next', (req, res) => ok(res, player.next()));
app.post('/api/previous', (req, res) => ok(res, player.previous()));
app.post('/api/stop', (req, res) => ok(res, player.stop()));

app.post('/api/seek', (req, res) => ok(res, player.seek(Number(req.body?.position) || 0)));
app.post('/api/volume', (req, res) => ok(res, player.setVolume(Number(req.body?.volume))));
app.post('/api/mute', (req, res) => ok(res, player.setMuted(req.body?.muted)));
app.post('/api/repeat', (req, res) => ok(res, player.setRepeat(req.body?.mode)));
app.post('/api/shuffle', (req, res) => ok(res, player.setShuffle(req.body?.shuffle)));

// ---------------------------------------------------------------- queue
app.post('/api/queue', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  return ok(res, player.setQueue(ids, { mode: req.body?.mode || 'replace', startIndex: req.body?.startIndex ?? null }));
});
app.post('/api/queue/add', (req, res) => ok(res, player.enqueue(req.body?.ids || [])));
app.post('/api/queue/remove', (req, res) => ok(res, player.removeAt(Number(req.body?.index))));
app.post('/api/queue/move', (req, res) =>
  ok(res, player.move(Number(req.body?.from), Number(req.body?.to)))
);
app.post('/api/queue/clear', (req, res) => ok(res, player.clear()));

// ------------------------------------------------------------ playlists
app.get('/api/playlists', (req, res) => ok(res, playlists.list().then((items) => ({ playlists: items }))));

app.get('/api/playlists/:name', (req, res) =>
  ok(res, Promise.resolve({ name: req.params.name, tracks: playlists.tracksOf(req.params.name) }))
);

app.post('/api/playlists', (req, res) =>
  ok(res, playlists.create(req.body?.name).then((name) => ({ name })))
);

app.post('/api/playlists/:name/rename', (req, res) =>
  ok(res, playlists.rename(req.params.name, req.body?.name).then((name) => ({ name })))
);

app.post('/api/playlists/:name/delete', (req, res) =>
  ok(
    res,
    playlists
      .remove(req.params.name, { force: req.body?.force === true })
      .then(async (name) => {
        await library.scan();
        return { deleted: name };
      })
  )
);

app.post('/api/playlists/:name/tracks', (req, res) =>
  ok(
    res,
    playlists.addTracks(req.params.name, req.body?.ids || []).then(async (result) => {
      await library.scan();
      return result;
    })
  )
);

app.post('/api/playlists/:name/tracks/remove', (req, res) =>
  ok(
    res,
    playlists
      .removeTrack(req.params.name, req.body?.id, { force: req.body?.force === true })
      .then(async (id) => {
        await library.scan();
        return { removed: id };
      })
  )
);

// Queue or play a whole playlist.
app.post('/api/playlists/:name/play', (req, res) => {
  const ids = playlists.tracksOf(req.params.name).map((t) => t.id);
  if (!ids.length) return res.status(400).json({ error: 'That playlist is empty' });
  return ok(
    res,
    req.body?.mode === 'append'
      ? player.enqueue(ids)
      : player.setQueue(ids, { startIndex: Number(req.body?.startIndex) || 0 })
  );
});

// ------------------------------------------------------------ downloads
app.get('/api/downloads', (req, res) => res.json(downloader.list()));

app.post('/api/downloads', (req, res) => {
  try {
    const job = downloader.add({
      url: req.body?.url,
      playlist: req.body?.playlist,
      wholePlaylist: req.body?.wholePlaylist === true,
    });
    res.json({ job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/downloads/:id/cancel', (req, res) => {
  try {
    res.json({ job: downloader.cancel(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------- settings and schedule
app.get('/api/settings', (req, res) =>
  res.json({ settings: settings.get(), schedule: scheduler.status() })
);

app.put('/api/settings', (req, res) => {
  const updated = settings.update(req.body || {});
  res.json({ settings: updated, schedule: scheduler.status() });
});

app.get('/api/schedule', (req, res) => res.json(scheduler.status()));

app.get('/api/time', (req, res) => {
  const tz = settings.get().timezone;
  res.json({ timezone: tz, ...zonedNow(tz) });
});

// ------------------------------------------------------------- podcast
app.get('/api/podcast/latest', (req, res) =>
  ok(
    res,
    fetchLatestEpisode(settings.get().podcast.feedUrl, { force: req.query.refresh === '1' })
  )
);

app.post('/api/podcast/play', (req, res) =>
  ok(res, playTodaysEpisode().then(() => player.state()))
);

// Fire a scheduled job by hand — useful for testing the 3PM behaviour
// without waiting until 3PM.
app.post('/api/schedule/run', (req, res) => {
  const name = req.body?.job;
  const job = scheduler.jobs.find((j) => j.name === name);
  if (!job) return res.status(400).json({ error: `unknown job: ${name}` });
  return ok(res, Promise.resolve(job.run()).then(() => player.state()));
});

app.post('/api/fade-stop', (req, res) =>
  ok(res, player.fadeOutAndStop(Number(req.body?.seconds ?? settings.get().autoStop.fadeSeconds)))
);

// -------------------------------------------------------- audio devices
app.get('/api/audio-devices', (req, res) =>
  ok(
    res,
    mpv
      .get('audio-device-list')
      .then((list) => ({ active: AUDIO_DEVICE, devices: list || [] }))
  )
);

// ------------------------------------------------------- static React UI
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (req, res) =>
    res
      .status(200)
      .type('html')
      .send(
        '<h1>Backend is running</h1><p>The React UI has not been built yet. Run <code>npm run build</code>, or start the Vite dev server with <code>npm run client:dev</code>.</p>'
      )
  );
}

// ----------------------------------------------------- websocket updates
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast() {
  const payload = JSON.stringify({ type: 'state', state: player.state() });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  if (AUTH_TOKEN) {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== AUTH_TOKEN) {
      ws.close(1008, 'unauthorized');
      return;
    }
  }
  ws.send(JSON.stringify({ type: 'state', state: player.state() }));
});

function push(payload) {
  const json = JSON.stringify(payload);
  for (const client of wss.clients) if (client.readyState === 1) client.send(json);
}

player.on('change', broadcast);
player.on('warning', (message) => push({ type: 'warning', message }));

downloader.on('update', (job) => push({ type: 'download', job }));
downloader.on('library-changed', () => push({ type: 'library-changed' }));

// Position updates while playing.
setInterval(() => {
  if (wss.clients.size) broadcast();
}, 1000);

// ------------------------------------------------------------- start up
async function main() {
  if (!fs.existsSync(MUSIC_DIR)) {
    console.warn(`[warn] MUSIC_DIR does not exist: ${MUSIC_DIR}`);
  }

  await mpv.start();
  console.log('[mpv] ready' + (AUDIO_DEVICE ? ` on device ${AUDIO_DEVICE}` : ''));

  await playlists.ensureRoot();

  const ytdlp = await downloader.probe();
  console.log(
    ytdlp.ok
      ? `[downloads] yt-dlp ${ytdlp.version}`
      : `[downloads] disabled — ${ytdlp.error}`
  );

  const tracks = await library.scan();
  console.log(
    `[library] ${tracks.length} tracks in ${MUSIC_DIR}` +
      (hasTagSupport ? '' : ' (music-metadata not installed — using filenames)')
  );

  scheduler.start();
  const s = settings.get();
  console.log(
    `[schedule] timezone ${s.timezone} (now ${zonedNow(s.timezone).label}) · ` +
      `auto-start ${s.autoStart.enabled ? s.autoStart.time : 'off'} · ` +
      `podcast ${s.podcast.enabled ? s.podcast.time : 'off'} · ` +
      `auto-stop ${s.autoStop.enabled ? s.autoStop.time : 'off'}`
  );

  server.listen(PORT, HOST, () => {
    console.log(`[http] listening on http://${HOST}:${PORT}`);
    if (AUTH_TOKEN) console.log('[auth] token required');
  });
}

const shutdown = async () => {
  console.log('\nShutting down…');
  scheduler.stop();
  await mpv.quit().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
