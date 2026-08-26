/**
 * yt-dlp download queue.
 *
 * Audio is extracted straight into the chosen playlist folder, so a
 * downloaded track is a real file sitting next to the symlinks — no import
 * step, and the folder still makes sense outside this app.
 *
 * Security notes:
 *  - yt-dlp is spawned with an argument array and never through a shell, so
 *    a URL containing `;` or backticks is inert.
 *  - `--` terminates option parsing, so a URL starting with `-` can't smuggle
 *    in flags like --exec.
 *  - The output directory is always a resolved playlist folder, never
 *    user-supplied text.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

const MAX_QUEUE = 25;
const MAX_HISTORY = 40;

export class Downloader extends EventEmitter {
  constructor({ library, playlists, binary = process.env.YTDLP_BINARY || 'yt-dlp' }) {
    super();
    this.library = library;
    this.playlists = playlists;
    this.binary = binary;
    this.jobs = [];          // newest first
    this.queue = [];         // job ids waiting
    this.current = null;     // { job, proc }
    this.available = null;   // filled in by probe()
  }

  async probe() {
    try {
      const { stdout } = await execFileAsync(this.binary, ['--version'], { timeout: 8000 });
      this.available = { ok: true, version: stdout.trim() };
    } catch (err) {
      this.available = {
        ok: false,
        error:
          err.code === 'ENOENT'
            ? `yt-dlp not found. Install it with "brew install yt-dlp" (macOS) or "pipx install yt-dlp" (Linux).`
            : err.message,
      };
    }
    return this.available;
  }

  add({ url, playlist, wholePlaylist = false }) {
    let parsed;
    try {
      parsed = new URL(String(url).trim());
    } catch {
      throw new Error('That does not look like a URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https links are supported');
    }

    // Must already exist: a typo'd name should be an error, not a new folder.
    const dir = this.playlists.resolveExisting(playlist);
    if (!dir) throw new Error(`No such playlist: ${playlist || '(none selected)'}`);

    if (this.queue.length >= MAX_QUEUE) throw new Error('Download queue is full');

    const job = {
      id: randomUUID(),
      url: parsed.href,
      playlist,
      wholePlaylist: Boolean(wholePlaylist),
      status: 'queued',
      progress: 0,
      title: '',
      item: null,          // "3 of 12" when downloading a whole playlist
      files: [],
      error: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };

    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, MAX_HISTORY);
    this.queue.push(job.id);
    this.emit('update', job);
    this.#pump();
    return job;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) throw new Error('No such download');

    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      this.emit('update', job);
      return job;
    }

    if (job.status === 'running' && this.current?.job.id === id) {
      this.current.cancelled = true;
      this.current.proc.kill('SIGTERM');
      return job;
    }

    throw new Error(`Download is already ${job.status}`);
  }

  list() {
    return {
      available: this.available,
      active: this.current?.job.id ?? null,
      jobs: this.jobs,
    };
  }

  async #pump() {
    if (this.current || !this.queue.length) return;

    const id = this.queue.shift();
    const job = this.get(id);
    if (!job || job.status === 'cancelled') return this.#pump();

    const dir = this.playlists.resolveExisting(job.playlist);
    if (!dir) {
      job.status = 'error';
      job.error = 'Playlist folder disappeared';
      this.emit('update', job);
      return this.#pump();
    }

    const before = new Set(await fs.readdir(dir).catch(() => []));

    const args = [
      '--extract-audio',
      // Prefer YouTube's native AAC so extraction is a remux, not a re-encode.
      '--format', 'bestaudio[ext=m4a]/bestaudio',
      '--audio-format', 'm4a',
      '--audio-quality', '0',
      '--embed-metadata',
      '--embed-thumbnail',
      '--no-overwrites',
      '--no-continue',
      '--newline',                       // progress on its own line, not \r
      '--no-color',
      job.wholePlaylist ? '--yes-playlist' : '--no-playlist',
      '--output', path.join(dir, '%(title)s.%(ext)s'),
      '--',                              // nothing after this is an option
      job.url,
    ];

    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.emit('update', job);

    const proc = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.current = { job, proc, cancelled: false };

    let stderr = '';
    const onLine = (line) => this.#parseLine(job, line);

    lineReader(proc.stdout, onLine);
    lineReader(proc.stderr, (line) => {
      stderr = (stderr + line + '\n').slice(-4000);
      onLine(line);
    });

    proc.on('error', (err) => {
      stderr += err.message;
    });

    await new Promise((resolve) => proc.on('close', resolve)).then(async (code) => {
      const cancelled = this.current?.cancelled;
      this.current = null;

      // Anything new in the folder is ours, whatever yt-dlp printed.
      const after = await fs.readdir(dir).catch(() => []);
      const created = after.filter((f) => !before.has(f) && !f.endsWith('.part'));

      if (cancelled) {
        job.status = 'cancelled';
        // Clean up half-finished files so the playlist has no corpses in it.
        await Promise.all(
          after
            .filter((f) => !before.has(f))
            .map((f) => fs.unlink(path.join(dir, f)).catch(() => {}))
        );
      } else if (created.length || job.alreadyHad) {
        job.status = 'done';
        job.progress = 100;
        job.files = created;
        if (!job.title && created.length) job.title = path.parse(created[0]).name;
      } else {
        // A clean exit code with nothing on disk still means failure. YouTube
        // 403s partway through look exactly like this, and reporting them as
        // "done" left an empty playlist with no explanation.
        job.status = 'error';
        job.error =
          firstUsefulError(stderr) ||
          (code === 0
            ? 'yt-dlp reported success but wrote no audio file — usually a partial block from YouTube. Try updating it: pipx upgrade yt-dlp'
            : `yt-dlp exited with code ${code}`);
      }

      job.finishedAt = new Date().toISOString();

      if (job.status === 'done') {
        await this.library.scan();          // make the new file playable
        this.emit('library-changed');
      }
      this.emit('update', job);
      this.#pump();
    });
  }

  #parseLine(job, line) {
    let changed = false;

    const pct = line.match(/\[download\]\s+([\d.]+)%/);
    if (pct) {
      const value = Math.min(100, Number(pct[1]));
      if (Math.abs(value - job.progress) >= 1 || value === 100) {
        job.progress = value;
        changed = true;
      }
    }

    const dest = line.match(/(?:\[download\]|\[ExtractAudio\])\s+Destination:\s+(.+)$/);
    if (dest) {
      job.title = path.parse(dest[1].trim()).name;
      changed = true;
    }

    const already = line.match(/\[download\]\s+(.+?) has already been downloaded/);
    if (already) {
      job.title = path.parse(already[1].trim()).name;
      job.progress = 100;
      job.alreadyHad = true;   // nothing new on disk, but not a failure
      changed = true;
    }

    const item = line.match(/\[download\] Downloading item (\d+) of (\d+)/);
    if (item) {
      job.item = `${item[1]} of ${item[2]}`;
      job.progress = 0;
      changed = true;
    }

    if (changed) this.emit('update', job);
  }
}

/** Split a stream into lines without pulling in a dependency. */
function lineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.search(/[\r\n]/)) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.trim());
  });
}

/** yt-dlp errors are verbose; show the line that actually says what broke. */
function firstUsefulError(stderr) {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^ERROR:/i.test(l));
  if (!line) return null;

  const message = line.replace(/^ERROR:\s*/i, '');
  if (/ffmpeg|ffprobe/i.test(message)) {
    return `${message} — install ffmpeg (brew install ffmpeg / apt install ffmpeg)`;
  }
  return message;
}
