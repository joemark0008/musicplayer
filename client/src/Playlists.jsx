import { useCallback, useEffect, useState } from 'react';
import { api, formatTime, COARSE_POINTER } from './api.js';

export default function PlaylistsView({ onNotice, currentId, downloads, refreshSignal }) {
  const [playlists, setPlaylists] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [newName, setNewName] = useState('');
  const [url, setUrl] = useState('');
  const [wholePlaylist, setWholePlaylist] = useState(false);
  const [ytdlp, setYtdlp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState([]);   // finished jobs hidden by the user

  const loadPlaylists = useCallback(async () => {
    try {
      const data = await api.playlists();
      setPlaylists(data.playlists);
      setSelected((current) => {
        if (current && data.playlists.some((p) => p.name === current)) return current;
        return data.playlists[0]?.name ?? null;
      });
    } catch (err) {
      onNotice(err.message);
    }
  }, [onNotice]);

  const loadTracks = useCallback(async () => {
    if (!selected) return setTracks([]);
    try {
      const data = await api.playlist(selected);
      setTracks(data.tracks);
    } catch (err) {
      onNotice(err.message);
    }
  }, [selected, onNotice]);

  useEffect(() => {
    loadPlaylists();
    api.downloads().then((d) => setYtdlp(d.available)).catch(() => {});
  }, [loadPlaylists, refreshSignal]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks, refreshSignal]);

  const act = (fn) => async (...args) => {
    setBusy(true);
    try {
      await fn(...args);
      await loadPlaylists();
      await loadTracks();
    } catch (err) {
      onNotice(err.message);
    } finally {
      setBusy(false);
    }
  };

  const create = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const { name } = await api.createPlaylist(newName);
      setNewName('');
      await loadPlaylists();
      setSelected(name);
    } catch (err) {
      onNotice(err.message);
    }
  };

  const removePlaylist = async (name) => {
    try {
      await api.deletePlaylist(name);
      onNotice(`Deleted "${name}"`);
    } catch (err) {
      // The server refuses to bin real downloads without a second nod.
      if (/downloaded file/.test(err.message) && confirm(`${err.message}\n\nDelete anyway?`)) {
        await api.deletePlaylist(name, true).catch((e) => onNotice(e.message));
      } else {
        onNotice(err.message);
        return;
      }
    }
    setSelected(null);
    await loadPlaylists();
  };

  const removeTrack = async (id) => {
    try {
      await api.removeFromPlaylist(selected, id);
    } catch (err) {
      if (/real file/.test(err.message) && confirm(`${err.message}\n\nDelete permanently?`)) {
        await api.removeFromPlaylist(selected, id, true).catch((e) => onNotice(e.message));
      } else {
        onNotice(err.message);
        return;
      }
    }
    await loadTracks();
    await loadPlaylists();
  };

  const startDownload = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    try {
      await api.download(url.trim(), selected, wholePlaylist);
      setUrl('');
      onNotice(`Queued for "${selected}"`);
    } catch (err) {
      onNotice(err.message);
    }
  };

  // Only this playlist's downloads. The server keeps one global history, and
  // showing all of it here made jobs from other playlists look like they
  // belonged to the one you're looking at.
  const mine = downloads.filter((j) => j.playlist === selected && !dismissed.includes(j.id));
  const active = mine.filter((j) => ['queued', 'running'].includes(j.status));
  const recent = mine.filter((j) => !['queued', 'running'].includes(j.status)).slice(0, 5);

  return (
    <section className="panel playlists">
      <aside className="pl-sidebar">
        <form className="pl-new" onSubmit={create}>
          <input
            placeholder="New playlist…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" disabled={!newName.trim()}>＋</button>
        </form>

        <ul className="pl-list">
          {playlists.map((p) => (
            <li
              key={p.name}
              className={p.name === selected ? 'active' : ''}
              onClick={() => setSelected(p.name)}
            >
              <span className="pl-name">{p.name}</span>
              <span className="pl-count">{p.count}</span>
            </li>
          ))}
          {!playlists.length && <li className="pl-empty">No playlists yet</li>}
        </ul>
      </aside>

      <div className="pl-main">
        {!selected ? (
          <p className="empty">Create a playlist to get started. Each one is a real folder in your music directory.</p>
        ) : (
          <>
            <div className="panel-head">
              <h2>{selected}</h2>
              <span className="hint inline">
                {tracks.length} track{tracks.length === 1 ? '' : 's'}
                {tracks.length > 0 &&
                  ` · ${formatTime(tracks.reduce((t, x) => t + (x.duration || 0), 0))}`}
              </span>
              <div className="panel-actions">
                <button
                  onClick={act(() => api.playPlaylist(selected))}
                  disabled={!tracks.length || busy}
                >
                  Play
                </button>
                <button
                  className="ghost"
                  onClick={act(() => api.playPlaylist(selected, { mode: 'append' }))}
                  disabled={!tracks.length || busy}
                >
                  Queue
                </button>
                <button className="ghost danger" onClick={() => removePlaylist(selected)}>
                  Delete
                </button>
              </div>
            </div>

            {/* ------------------------------------------------ downloader */}
            <form className="dl-form" onSubmit={startDownload}>
              <input
                type="url"
                placeholder="Paste a YouTube link to download into this playlist…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!ytdlp?.ok}
              />
              <label className="dl-check" title="Download every video in the linked playlist">
                <input
                  type="checkbox"
                  checked={wholePlaylist}
                  onChange={(e) => setWholePlaylist(e.target.checked)}
                  disabled={!ytdlp?.ok}
                />
                whole playlist
              </label>
              <button type="submit" disabled={!ytdlp?.ok || !url.trim()}>Download</button>
            </form>

            {ytdlp && !ytdlp.ok && <div className="dl-warn">{ytdlp.error}</div>}

            {(active.length > 0 || recent.length > 0) && (
              <ul className="dl-list">
                {active.map((job) => (
                  <li key={job.id} className="dl-job">
                    <div className="dl-row">
                      <span className="dl-title">
                        {job.title || job.url}
                        {job.item && <span className="dl-item"> · item {job.item}</span>}
                      </span>
                      <span className="dl-pct">
                        {job.status === 'queued' ? 'queued' : `${job.progress.toFixed(0)}%`}
                      </span>
                      <button className="ghost" onClick={() => api.cancelDownload(job.id).catch(() => {})}>
                        ✕
                      </button>
                    </div>
                    <div className="dl-bar">
                      <div className="dl-fill" style={{ width: `${job.progress}%` }} />
                    </div>
                  </li>
                ))}
                {recent.map((job) => (
                  <li key={job.id} className={`dl-job done ${job.status}`}>
                    <div className="dl-row">
                      <span className="dl-title">{job.title || job.url}</span>
                      <span className="dl-pct">{job.status === 'error' ? 'failed' : job.status}</span>
                      <button
                        className="ghost"
                        title="Dismiss"
                        onClick={() => setDismissed((d) => [...d, job.id])}
                      >
                        ✕
                      </button>
                    </div>
                    {job.error && <div className="dl-error">{job.error}</div>}
                  </li>
                ))}
                {recent.length > 1 && (
                  <li className="dl-clear">
                    <button
                      className="ghost"
                      onClick={() => setDismissed((d) => [...d, ...recent.map((j) => j.id)])}
                    >
                      Clear finished
                    </button>
                  </li>
                )}
              </ul>
            )}

            {/* ---------------------------------------------------- tracks */}
            {!tracks.length ? (
              <p className="empty">
                Empty. Paste a link above, or use ＋ on any track in the Library tab.
              </p>
            ) : (
              <ul className="tracklist">
                {tracks.map((t, i) => (
                  <li
                    key={t.id}
                    className={t.id === currentId ? 'current' : ''}
                    onDoubleClick={() => api.playPlaylist(selected, { startIndex: i }).catch(() => {})}
                    onClick={() =>
                      COARSE_POINTER &&
                      api.playPlaylist(selected, { startIndex: i }).catch(() => {})
                    }
                  >
                    <span className="idx">{i + 1}</span>
                    <div className="track-main">
                      <span className="title">{t.title || t.id}</span>
                      <span className="sub">{[t.artist, t.album].filter(Boolean).join(' · ')}</span>
                    </div>
                    <span className="dur">{t.duration ? formatTime(t.duration) : ''}</span>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        title="Play from here"
                        onClick={() => api.playPlaylist(selected, { startIndex: i }).catch(() => {})}
                      >
                        ▶
                      </button>
                      <button className="ghost danger" title="Remove" onClick={() => removeTrack(t.id)}>
                        ✕
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Small "add to playlist" menu used from the Library tab. */
export function AddToPlaylist({ trackId, playlists, onDone, onNotice }) {
  const [open, setOpen] = useState(false);

  if (!playlists.length) return null;

  const add = async (name) => {
    setOpen(false);
    try {
      const result = await api.addToPlaylist(name, [trackId]);
      onNotice(
        result.added.length ? `Added to "${name}"` : result.skipped[0]?.reason || 'Already there'
      );
      onDone?.();
    } catch (err) {
      onNotice(err.message);
    }
  };

  return (
    <div className="addmenu">
      <button className="ghost" title="Add to playlist" onClick={() => setOpen((o) => !o)}>
        ≡
      </button>
      {open && (
        <>
          <div className="addmenu-backdrop" onClick={() => setOpen(false)} />
          <ul className="addmenu-list">
            {playlists.map((p) => (
              <li key={p.name}>
                <button onClick={() => add(p.name)}>{p.name}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
