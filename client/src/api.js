/**
 * Touch devices get single-tap-to-play; double-click is awkward on a phone.
 * Checked once — a device doesn't grow a mouse mid-session.
 */
export const COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

// Optional shared secret: open the UI as http://server:3000/?token=xxxx
const token = new URLSearchParams(location.search).get('token') || '';

const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  state: () => request('GET', '/api/state'),
  library: (q = '') => request('GET', `/api/library${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  rescan: () => request('POST', '/api/library/scan'),

  play: (payload = {}) => request('POST', '/api/play', payload),
  toggle: () => request('POST', '/api/toggle'),
  next: () => request('POST', '/api/next'),
  previous: () => request('POST', '/api/previous'),
  stop: () => request('POST', '/api/stop'),
  seek: (position) => request('POST', '/api/seek', { position }),
  volume: (volume) => request('POST', '/api/volume', { volume }),
  mute: (muted) => request('POST', '/api/mute', { muted }),
  repeat: (mode) => request('POST', '/api/repeat', { mode }),
  shuffle: (shuffle) => request('POST', '/api/shuffle', { shuffle }),

  playlists: () => request('GET', '/api/playlists'),
  playlist: (name) => request('GET', `/api/playlists/${encodeURIComponent(name)}`),
  createPlaylist: (name) => request('POST', '/api/playlists', { name }),
  renamePlaylist: (from, name) =>
    request('POST', `/api/playlists/${encodeURIComponent(from)}/rename`, { name }),
  deletePlaylist: (name, force = false) =>
    request('POST', `/api/playlists/${encodeURIComponent(name)}/delete`, { force }),
  addToPlaylist: (name, ids) =>
    request('POST', `/api/playlists/${encodeURIComponent(name)}/tracks`, { ids }),
  removeFromPlaylist: (name, id, force = false) =>
    request('POST', `/api/playlists/${encodeURIComponent(name)}/tracks/remove`, { id, force }),
  playPlaylist: (name, opts = {}) =>
    request('POST', `/api/playlists/${encodeURIComponent(name)}/play`, opts),

  downloads: () => request('GET', '/api/downloads'),
  download: (url, playlist, wholePlaylist = false) =>
    request('POST', '/api/downloads', { url, playlist, wholePlaylist }),
  cancelDownload: (id) => request('POST', `/api/downloads/${id}/cancel`),

  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PUT', '/api/settings', patch),
  schedule: () => request('GET', '/api/schedule'),
  serverTime: () => request('GET', '/api/time'),
  podcastLatest: (refresh = false) =>
    request('GET', `/api/podcast/latest${refresh ? '?refresh=1' : ''}`),
  playPodcast: () => request('POST', '/api/podcast/play'),
  runJob: (job) => request('POST', '/api/schedule/run', { job }),
  fadeStop: (seconds) => request('POST', '/api/fade-stop', { seconds }),

  setQueue: (ids, opts = {}) => request('POST', '/api/queue', { ids, ...opts }),
  addToQueue: (ids) => request('POST', '/api/queue/add', { ids }),
  removeFromQueue: (index) => request('POST', '/api/queue/remove', { index }),
  moveInQueue: (from, to) => request('POST', '/api/queue/move', { from, to }),
  clearQueue: () => request('POST', '/api/queue/clear'),
};

/** Live state feed with automatic reconnect. */
export function connectSocket({ onState, onWarning, onStatus, onDownload, onLibraryChanged }) {
  let ws;
  let retry = 0;
  let closed = false;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${token}` : ''}`);

    ws.onopen = () => {
      retry = 0;
      onStatus?.('connected');
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') onState(msg.state);
      if (msg.type === 'warning') onWarning?.(msg.message);
      if (msg.type === 'download') onDownload?.(msg.job);
      if (msg.type === 'library-changed') onLibraryChanged?.();
    };
    ws.onclose = () => {
      onStatus?.('disconnected');
      if (closed) return;
      retry = Math.min(retry + 1, 10);
      setTimeout(open, retry * 500);
    };
    ws.onerror = () => ws.close();
  };

  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
