import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, connectSocket, formatTime, COARSE_POINTER } from './api.js';
import SettingsView from './Settings.jsx';
import PlaylistsView, { AddToPlaylist } from './Playlists.jsx';

const EMPTY_STATE = {
  connected: false,
  track: null,
  index: -1,
  queue: [],
  playing: false,
  paused: false,
  stopped: true,
  position: 0,
  duration: 0,
  volume: 80,
  muted: false,
  repeat: 'off',
  shuffle: false,
};

export default function App() {
  const [state, setState] = useState(EMPTY_STATE);
  const [tracks, setTracks] = useState([]);
  const [libraryInfo, setLibraryInfo] = useState({
    total: 0, root: '', tagSupport: true, inPlaylists: 0,
  });
  const [includePlaylists, setIncludePlaylists] = useState(false);
  const [query, setQuery] = useState('');
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState('library');
  const [scanning, setScanning] = useState(false);
  const [downloads, setDownloads] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [refreshSignal, setRefreshSignal] = useState(0);

  // ---------------------------------------------------------- data load
  const loadLibrary = useCallback(async () => {
    try {
      const data = await api.library('', includePlaylists);
      setTracks(data.tracks);
      setLibraryInfo({
        total: data.total,
        root: data.root,
        tagSupport: data.tagSupport,
        inPlaylists: data.inPlaylists,
      });
    } catch (err) {
      setNotice(err.message);
    }
  }, [includePlaylists]);

  const loadPlaylists = useCallback(() => {
    api.playlists().then((d) => setPlaylists(d.playlists)).catch(() => {});
  }, []);

  useEffect(() => {
    loadLibrary();
    loadPlaylists();
    api.state().then(setState).catch(() => {});
    api.downloads().then((d) => setDownloads(d.jobs)).catch(() => {});

    return connectSocket({
      onState: setState,
      onWarning: setNotice,
      onStatus: setSocketStatus,
      // Upsert so an in-flight job updates in place rather than duplicating.
      onDownload: (job) =>
        setDownloads((jobs) => {
          const next = jobs.filter((j) => j.id !== job.id);
          return [job, ...next].slice(0, 40);
        }),
      onLibraryChanged: () => {
        loadLibrary();
        loadPlaylists();
        setRefreshSignal((n) => n + 1);
      },
    });
  }, [loadLibrary, loadPlaylists]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // Client-side filtering keeps typing instant on large libraries.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tracks;
    return tracks.filter((t) =>
      [t.title, t.artist, t.album, t.id].some((f) => (f || '').toLowerCase().includes(q))
    );
  }, [tracks, query]);

  const run = (fn) => async (...args) => {
    try {
      const next = await fn(...args);
      if (next && typeof next === 'object' && 'queue' in next) setState(next);
    } catch (err) {
      setNotice(err.message);
    }
  };

  const rescan = async () => {
    setScanning(true);
    try {
      await api.rescan();
      await loadLibrary();
      setNotice('Library rescanned');
    } catch (err) {
      setNotice(err.message);
    } finally {
      setScanning(false);
    }
  };

  // ------------------------------------------------------ keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        api.toggle().then(setState).catch(() => {});
      }
      if (e.code === 'ArrowRight' && e.shiftKey) api.next().then(setState).catch(() => {});
      if (e.code === 'ArrowLeft' && e.shiftKey) api.previous().then(setState).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-status={socketStatus} />
          <h1>Music Server</h1>
        </div>
        <nav className="tabs">
          <button className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
            Library <span className="count">{libraryInfo.total}</span>
          </button>
          <button className={tab === 'playlists' ? 'active' : ''} onClick={() => setTab('playlists')}>
            Playlists <span className="count">{playlists.length}</span>
          </button>
          <button className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>
            Queue <span className="count">{state.queue.length}</span>
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Schedule
          </button>
        </nav>
        <button className="ghost" onClick={rescan} disabled={scanning}>
          {scanning ? 'Scanning…' : 'Rescan'}
        </button>
      </header>

      {notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>}

      <main className="content">
        {tab === 'library' ? (
          <LibraryView
            tracks={filtered}
            total={libraryInfo.total}
            root={libraryInfo.root}
            inPlaylists={libraryInfo.inPlaylists}
            includePlaylists={includePlaylists}
            setIncludePlaylists={setIncludePlaylists}
            query={query}
            setQuery={setQuery}
            currentId={state.track?.id}
            onPlay={run((id) => api.play({ id }))}
            onEnqueue={run((id) => api.addToQueue([id]))}
            onPlayAll={run(() => api.setQueue(filtered.map((t) => t.id), { startIndex: 0 }))}
            onQueueAll={run(() => api.addToQueue(filtered.map((t) => t.id)))}
            playlists={playlists}
            onPlaylistsChanged={loadPlaylists}
            onNotice={setNotice}
          />
        ) : tab === 'playlists' ? (
          <PlaylistsView
            onNotice={setNotice}
            currentId={state.track?.id}
            downloads={downloads}
            refreshSignal={refreshSignal}
          />
        ) : tab === 'settings' ? (
          <SettingsView onNotice={setNotice} />
        ) : (
          <QueueView
            queue={state.queue}
            index={state.index}
            onPlayIndex={run((i) => api.play({ index: i }))}
            onRemove={run((i) => api.removeFromQueue(i))}
            onMove={run((from, to) => api.moveInQueue(from, to))}
            onClear={run(() => api.clearQueue())}
          />
        )}
      </main>

      <NowPlaying state={state} setState={setState} onError={setNotice} />
    </div>
  );
}

/* ------------------------------------------------------------------ library */
function LibraryView({
  tracks, total, root, inPlaylists, includePlaylists, setIncludePlaylists,
  query, setQuery, currentId,
  onPlay, onEnqueue, onPlayAll, onQueueAll,
  playlists, onPlaylistsChanged, onNotice,
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <input
          className="search"
          type="search"
          placeholder="Search title, artist, album…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {inPlaylists > 0 && (
          <label className="inline-check" title="Playlist tracks are hidden by default so nothing appears twice">
            <input
              type="checkbox"
              checked={includePlaylists}
              onChange={(e) => setIncludePlaylists(e.target.checked)}
            />
            include playlists
          </label>
        )}
        <div className="panel-actions">
          <button onClick={onPlayAll} disabled={!tracks.length}>Play all</button>
          <button className="ghost" onClick={onQueueAll} disabled={!tracks.length}>Queue all</button>
        </div>
      </div>

      {!total && inPlaylists > 0 && (
        <p className="empty">
          Nothing loose in <code>{root}</code> — all {inPlaylists} of your tracks live inside
          playlists, which are hidden here so songs don't appear twice.
          <br />
          <br />
          Open the <strong>Playlists</strong> tab to play them, tick{' '}
          <strong>include playlists</strong> above to list them here, or drop files straight
          into <code>{root}</code> and hit Rescan.
        </p>
      )}

      {!total && !inPlaylists && (
        <p className="empty">
          No audio files found in <code>{root}</code>. Copy music there and hit Rescan, or
          download something in the <strong>Playlists</strong> tab.
        </p>
      )}

      <ul className="tracklist">
        {tracks.map((t) => (
          <li
            key={t.id}
            className={t.id === currentId ? 'current' : ''}
            onDoubleClick={() => onPlay(t.id)}
            onClick={() => COARSE_POINTER && onPlay(t.id)}
          >
            <div className="track-main">
              <span className="title">{t.title || t.id}</span>
              <span className="sub">
                {[t.artist, t.album].filter(Boolean).join(' · ') || t.id}
              </span>
            </div>
            <span className="dur">{t.duration ? formatTime(t.duration) : ''}</span>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button title="Play now" onClick={() => onPlay(t.id)}>▶</button>
              <button title="Add to queue" className="ghost" onClick={() => onEnqueue(t.id)}>＋</button>
              <AddToPlaylist
                trackId={t.id}
                playlists={playlists}
                onDone={onPlaylistsChanged}
                onNotice={onNotice}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------- queue */
function QueueView({ queue, index, onPlayIndex, onRemove, onMove, onClear }) {
  if (!queue.length) {
    return (
      <section className="panel">
        <p className="empty">Queue is empty. Add something from the library.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Up next</h2>
        <div className="panel-actions">
          <button className="ghost danger" onClick={onClear}>Clear</button>
        </div>
      </div>
      <ul className="tracklist">
        {queue.map((t, i) => (
          <li
            key={`${t.id}-${i}`}
            className={i === index ? 'current' : ''}
            onDoubleClick={() => onPlayIndex(i)}
            onClick={() => COARSE_POINTER && onPlayIndex(i)}
          >
            <span className="idx">{i === index ? '♪' : i + 1}</span>
            <div className="track-main">
              <span className="title">{t.title || t.id}</span>
              <span className="sub">{[t.artist, t.album].filter(Boolean).join(' · ')}</span>
            </div>
            <span className="dur">{t.duration ? formatTime(t.duration) : ''}</span>
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              <button className="ghost" title="Move up" disabled={i === 0} onClick={() => onMove(i, i - 1)}>↑</button>
              <button className="ghost" title="Move down" disabled={i === queue.length - 1} onClick={() => onMove(i, i + 1)}>↓</button>
              <button className="ghost danger" title="Remove" onClick={() => onRemove(i)}>✕</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- now playing */
function NowPlaying({ state, setState, onError }) {
  const [scrub, setScrub] = useState(null);   // local value while dragging
  const [vol, setVol] = useState(null);
  const [volumeOpen, setVolumeOpen] = useState(false); // mobile only
  const volTimer = useRef(null);

  const duration = state.duration || state.track?.duration || 0;
  const position = scrub ?? state.position ?? 0;
  const volume = vol ?? state.volume ?? 80;

  const call = (fn) => async () => {
    try {
      setState(await fn());
    } catch (err) {
      onError(err.message);
    }
  };

  const commitSeek = async (value) => {
    setScrub(null);
    try {
      setState(await api.seek(value));
    } catch (err) {
      onError(err.message);
    }
  };

  // Throttle volume writes so dragging doesn't flood the server.
  const changeVolume = (value) => {
    setVol(value);
    clearTimeout(volTimer.current);
    volTimer.current = setTimeout(async () => {
      try {
        await api.volume(value);
      } catch (err) {
        onError(err.message);
      } finally {
        setVol(null);
      }
    }, 120);
  };

  const cycleRepeat = call(() =>
    api.repeat({ off: 'all', all: 'one', one: 'off' }[state.repeat])
  );

  return (
    <footer className="player">
      <div className="np">
        <div className="np-title">
          {state.isStream && <span className="badge">PODCAST</span>}
          {state.willResume && <span className="badge resume">↩ RESUMES</span>}
          {state.fading && <span className="badge fade">FADING OUT</span>}
          {state.track?.title || 'Nothing playing'}
        </div>
        <div className="np-sub">
          {[state.track?.artist, state.track?.album].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>

      <div className="controls">
        <div className="buttons">
          <button
            className={`ghost toggle ${state.shuffle ? 'on' : ''}`}
            title="Shuffle"
            onClick={call(() => api.shuffle(!state.shuffle))}
          >
            ⤨
          </button>
          <button className="ghost" title="Previous (Shift+←)" onClick={call(api.previous)}>⏮</button>
          <button className="primary" title="Play / Pause (Space)" onClick={call(api.toggle)}>
            {state.playing ? '⏸' : '▶'}
          </button>
          <button className="ghost" title="Next (Shift+→)" onClick={call(api.next)}>⏭</button>
          <button
            className={`ghost toggle ${state.repeat !== 'off' ? 'on' : ''}`}
            title={`Repeat: ${state.repeat}`}
            onClick={cycleRepeat}
          >
            {state.repeat === 'one' ? '🔂' : '🔁'}
          </button>
          <button
            className={`ghost mobile-only ${volumeOpen ? 'on' : ''}`}
            title="Volume"
            onClick={() => setVolumeOpen((o) => !o)}
          >
            {state.muted || volume === 0 ? '🔇' : '🔊'}
          </button>
        </div>

        <div className="seek">
          <span className="t">{formatTime(position)}</span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 1)}
            step={1}
            value={Math.min(position, duration || 1)}
            disabled={!duration}
            onChange={(e) => setScrub(Number(e.target.value))}
            onMouseUp={(e) => commitSeek(Number(e.target.value))}
            onTouchEnd={(e) => commitSeek(Number(e.target.value))}
          />
          <span className="t">{formatTime(duration)}</span>
        </div>
      </div>

      <div className={`volume ${volumeOpen ? 'open' : ''}`}>
        <button
          className="ghost desktop-only"
          title={state.muted ? 'Unmute' : 'Mute'}
          onClick={call(() => api.mute(!state.muted))}
        >
          {state.muted || volume === 0 ? '🔇' : '🔊'}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
        />
        <span className="t">{Math.round(volume)}</span>
      </div>
    </footer>
  );
}
