/**
 * Recursive scan of the music directory.
 *
 * Tags are read with `music-metadata` when it is installed; if it isn't,
 * we fall back to parsing "Artist - Title.mp3" style filenames so the app
 * still works with zero optional dependencies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus',
  '.wav', '.wma', '.alac', '.aiff', '.aif', '.mp4', '.m4b',
]);

let parseFile = null;
try {
  ({ parseFile } = await import('music-metadata'));
} catch {
  // Optional dependency not installed — filename parsing it is.
}

function fromFilename(relPath) {
  const base = path.basename(relPath, path.extname(relPath));
  const dir = path.dirname(relPath);
  const parts = base.split(' - ');
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim(),
      album: dir === '.' ? '' : path.basename(dir),
    };
  }
  return {
    artist: '',
    title: base.replace(/^\d+[\s._-]+/, '').trim(),
    album: dir === '.' ? '' : path.basename(dir),
  };
}

async function readTags(absPath, relPath) {
  const fallback = fromFilename(relPath);
  if (!parseFile) return { ...fallback, duration: 0 };
  try {
    const meta = await parseFile(absPath, { duration: true, skipCovers: true });
    const c = meta.common || {};
    return {
      title: c.title?.trim() || fallback.title,
      artist: c.artist?.trim() || c.albumartist?.trim() || fallback.artist,
      album: c.album?.trim() || fallback.album,
      track: c.track?.no ?? null,
      year: c.year ?? null,
      duration: Math.round(meta.format?.duration || 0),
    };
  } catch {
    return { ...fallback, duration: 0 };
  }
}

export class Library {
  constructor(rootDir) {
    this.root = path.resolve(rootDir);
    this.tracks = [];
    this.byId = new Map();
    this.scanning = false;
    this.lastScan = null;
  }

  /** Guard against `../../etc/passwd` style ids arriving from the network. */
  resolveId(id) {
    const abs = path.resolve(this.root, id);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
  }

  async scan() {
    if (this.scanning) return this.tracks;
    this.scanning = true;
    const found = [];

    const walk = async (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs, depth + 1);
        } else if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) {
          found.push(abs);
        }
      }
    };

    try {
      await walk(this.root);
      found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      const tracks = [];
      for (const abs of found) {
        const id = path.relative(this.root, abs);
        tracks.push({ id, path: abs, ...(await readTags(abs, id)) });
      }

      this.tracks = tracks;
      this.byId = new Map(tracks.map((t) => [t.id, t]));
      this.lastScan = new Date().toISOString();
      return tracks;
    } finally {
      this.scanning = false;
    }
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  search(query) {
    if (!query) return this.tracks;
    const q = query.toLowerCase();
    return this.tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
    );
  }
}

export const hasTagSupport = Boolean(parseFile);
