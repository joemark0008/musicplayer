/**
 * Playlists are plain folders under MUSIC_DIR/Playlists.
 *
 * Adding an existing library track creates a *symlink*, so a song can live in
 * five playlists without costing five copies of disk. Downloads land in the
 * folder as real files. Either way the folder is self-describing: you can
 * browse it in Finder, copy it to a USB stick, and it still makes sense
 * without this app.
 *
 * Playlist tracks are indexed by the normal library scan (so they're
 * playable through the same code path) but hidden from the main Library
 * list, otherwise every song would appear twice.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const PLAYLIST_DIRNAME = 'Playlists';

/**
 * Strip path separators, Windows-illegal characters and control codes.
 * Spaces, hyphens and unicode are kept — this is a folder name a human reads.
 */
export function sanitizeName(raw) {
  const name = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();

  // Reserved device names on Windows, in case the library is on a share.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return '';
  return name;
}

export class Playlists {
  constructor(library, dirName = PLAYLIST_DIRNAME) {
    this.library = library;
    this.dirName = dirName;
    this.root = path.join(library.root, dirName);
  }

  async ensureRoot() {
    await fs.mkdir(this.root, { recursive: true });
  }

  /**
   * Absolute path of an *existing* playlist folder, or null.
   * Anything that writes files should use this rather than resolve(), which
   * happily returns a path for a folder that was never created.
   */
  resolveExisting(name) {
    const dir = this.resolve(name);
    return dir && fsSync.existsSync(dir) ? dir : null;
  }

  /** Absolute path of a playlist folder, or null if the name escapes the root. */
  resolve(name) {
    const clean = sanitizeName(name);
    if (!clean) return null;
    const abs = path.join(this.root, clean);
    const rel = path.relative(this.root, abs);
    if (rel !== clean || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
  }

  /** Library ids that belong to a playlist, in filename order. */
  tracksOf(name) {
    const prefix = `${this.dirName}${path.sep}${sanitizeName(name)}${path.sep}`;
    return this.library.tracks
      .filter((t) => t.id.startsWith(prefix) && !t.id.slice(prefix.length).includes(path.sep))
      .map((t) => ({ ...t, path: undefined }));
  }

  /** True for any library id that lives under Playlists/. */
  isPlaylistTrack(id) {
    return id.startsWith(`${this.dirName}${path.sep}`) || id.startsWith(`${this.dirName}/`);
  }

  async list() {
    await this.ensureRoot();
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const playlists = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const tracks = this.tracksOf(entry.name);
      playlists.push({
        name: entry.name,
        count: tracks.length,
        duration: tracks.reduce((total, t) => total + (t.duration || 0), 0),
      });
    }

    playlists.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return playlists;
  }

  async create(rawName) {
    const name = sanitizeName(rawName);
    if (!name) throw new Error('Please give the playlist a name');
    const dir = this.resolve(name);
    if (!dir) throw new Error('Invalid playlist name');
    if (fsSync.existsSync(dir)) throw new Error(`Playlist "${name}" already exists`);
    await fs.mkdir(dir, { recursive: true });
    return name;
  }

  async rename(from, to) {
    const src = this.resolve(from);
    const name = sanitizeName(to);
    const dst = this.resolve(name);
    if (!src || !dst) throw new Error('Invalid playlist name');
    if (!fsSync.existsSync(src)) throw new Error(`No such playlist: ${from}`);
    if (fsSync.existsSync(dst)) throw new Error(`Playlist "${name}" already exists`);
    await fs.rename(src, dst);
    return name;
  }

  /**
   * Deleting a playlist removes symlinks freely, but refuses to take real
   * files with it unless the caller explicitly says so — losing a download
   * to a stray click would be unrecoverable.
   */
  async remove(name, { force = false } = {}) {
    const dir = this.resolve(name);
    if (!dir) throw new Error('Invalid playlist name');
    if (!fsSync.existsSync(dir)) throw new Error(`No such playlist: ${name}`);

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const realFiles = entries.filter((e) => !e.isSymbolicLink() && e.isFile());

    if (realFiles.length && !force) {
      throw new Error(
        `"${name}" contains ${realFiles.length} downloaded file(s) that exist nowhere else. ` +
          `Delete them too by confirming, or move them into your library first.`
      );
    }

    await fs.rm(dir, { recursive: true, force: true });
    return name;
  }

  /** Symlink library tracks into a playlist folder. */
  async addTracks(name, ids) {
    const dir = this.resolve(name);
    if (!dir) throw new Error('Invalid playlist name');
    if (!fsSync.existsSync(dir)) throw new Error(`No such playlist: ${name}`);

    const added = [];
    const skipped = [];

    for (const id of ids) {
      const track = this.library.get(id);
      if (!track) {
        skipped.push({ id, reason: 'not in library' });
        continue;
      }
      if (this.isPlaylistTrack(id)) {
        skipped.push({ id, reason: 'already a playlist entry' });
        continue;
      }

      const base = path.basename(track.path);
      let target = path.join(dir, base);

      // "Song.mp3" already taken by a different source file? Number it.
      let n = 1;
      while (fsSync.existsSync(target)) {
        const existing = await fs.realpath(target).catch(() => null);
        if (existing === track.path) break; // same song, already here
        const ext = path.extname(base);
        target = path.join(dir, `${path.basename(base, ext)} (${++n})${ext}`);
      }

      if (fsSync.existsSync(target)) {
        skipped.push({ id, reason: 'already in playlist' });
        continue;
      }

      try {
        // Relative link, so the whole music folder stays portable.
        await fs.symlink(path.relative(dir, track.path), target);
        added.push(id);
      } catch (err) {
        // Some filesystems (exFAT, SMB shares) can't do symlinks — fall back
        // to copying rather than failing the whole request.
        if (['EPERM', 'ENOSYS', 'EACCES'].includes(err.code)) {
          await fs.copyFile(track.path, target);
          added.push(id);
        } else {
          skipped.push({ id, reason: err.message });
        }
      }
    }

    return { added, skipped };
  }

  /** Remove one entry from a playlist. Real files require `force`. */
  async removeTrack(playlistName, trackId, { force = false } = {}) {
    const dir = this.resolve(playlistName);
    if (!dir) throw new Error('Invalid playlist name');

    const track = this.library.get(trackId);
    if (!track) throw new Error('No such track');

    const abs = path.resolve(track.path);
    if (path.dirname(abs) !== path.resolve(dir)) {
      throw new Error('That track is not in this playlist');
    }

    const stat = await fs.lstat(abs);
    if (!stat.isSymbolicLink() && !force) {
      throw new Error(
        'This is a real file (a download), not a link. Confirm to delete it permanently.'
      );
    }

    await fs.unlink(abs);
    return trackId;
  }
}
