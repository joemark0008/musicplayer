import { useCallback, useEffect, useState } from 'react';
import { api, formatTime } from './api.js';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const COMMON_ZONES = [
  'Asia/Manila',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'America/Los_Angeles',
  'America/New_York',
  'UTC',
];

export default function SettingsView({ onNotice }) {
  const [settings, setSettings] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [clock, setClock] = useState(null);
  const [episode, setEpisode] = useState(null);
  const [busy, setBusy] = useState(null);
  const [playlists, setPlaylists] = useState([]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.settings();
      setSettings(data.settings);
      setSchedule(data.schedule);
    } catch (err) {
      onNotice(err.message);
    }
  }, [onNotice]);

  useEffect(() => {
    refresh();
    api.playlists().then((d) => setPlaylists(d.playlists)).catch(() => {});
    const tick = () => api.serverTime().then(setClock).catch(() => {});
    tick();
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // Every change saves immediately — no Save button to forget.
  const patch = async (delta) => {
    try {
      const data = await api.saveSettings(delta);
      setSettings(data.settings);
      setSchedule(data.schedule);
    } catch (err) {
      onNotice(err.message);
    }
  };

  const withBusy = (key, fn) => async () => {
    setBusy(key);
    try {
      return await fn();
    } catch (err) {
      onNotice(err.message);
    } finally {
      setBusy(null);
    }
  };

  const loadEpisode = withBusy('episode', async () => {
    const data = await api.podcastLatest(true);
    setEpisode(data);
    onNotice(`Latest: ${data.episode.title}`);
  });

  const playNow = withBusy('play', async () => {
    await api.playPodcast();
    onNotice('Playing today’s episode');
  });

  const testStart = withBusy('start', async () => {
    await api.runJob('autoStart');
    onNotice(`Playing "${settings.autoStart.playlist}"`);
  });

  const testStop = withBusy('stop', async () => {
    await api.fadeStop(settings.autoStop.fadeSeconds);
    onNotice('Fading out…');
  });

  if (!settings) {
    return (
      <section className="panel">
        <p className="empty">Loading settings…</p>
      </section>
    );
  }

  const jobStatus = (name) => schedule?.jobs?.find((j) => j.name === name);

  return (
    <section className="panel settings">
      <div className="settings-inner">
        {/* ---------------------------------------------------------- clock */}
        <div className="card">
          <div className="card-head">
            <h2>Time zone</h2>
            {clock && <span className="clock">{clock.label}</span>}
          </div>
          <p className="hint">
            All schedules below fire on this clock, not the server's. Philippine time is{' '}
            <code>Asia/Manila</code>.
          </p>
          <select
            value={COMMON_ZONES.includes(settings.timezone) ? settings.timezone : 'custom'}
            onChange={(e) => e.target.value !== 'custom' && patch({ timezone: e.target.value })}
          >
            {COMMON_ZONES.map((z) => (
              <option key={z} value={z}>{z}</option>
            ))}
            {!COMMON_ZONES.includes(settings.timezone) && (
              <option value="custom">{settings.timezone}</option>
            )}
          </select>
        </div>

        {/* ------------------------------------------------------ auto-start */}
        <div className="card">
          <div className="card-head">
            <h2>Auto-start</h2>
            <Toggle
              checked={settings.autoStart.enabled}
              onChange={(enabled) => patch({ autoStart: { enabled } })}
            />
          </div>
          <p className="hint">Wakes the player up and plays a playlist.</p>

          <div className="field">
            <label>Start at</label>
            <input
              type="time"
              value={settings.autoStart.time}
              onChange={(e) => patch({ autoStart: { time: e.target.value } })}
            />
          </div>

          <div className="field">
            <label>Days</label>
            <DayPicker
              value={settings.autoStart.days}
              onChange={(days) => patch({ autoStart: { days } })}
            />
          </div>

          <div className="field">
            <label>Playlist</label>
            <select
              className="grow"
              value={settings.autoStart.playlist}
              onChange={(e) => patch({ autoStart: { playlist: e.target.value } })}
            >
              <option value="">— pick one —</option>
              {playlists.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} ({p.count})
                </option>
              ))}
              {/* Keep a stale name visible rather than silently swapping it. */}
              {settings.autoStart.playlist &&
                !playlists.some((p) => p.name === settings.autoStart.playlist) && (
                  <option value={settings.autoStart.playlist}>
                    {settings.autoStart.playlist} (missing)
                  </option>
                )}
            </select>
          </div>

          <div className="field">
            <label>Order</label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={settings.autoStart.shuffle}
                onChange={(e) => patch({ autoStart: { shuffle: e.target.checked } })}
              />
              shuffle
            </label>
          </div>

          <div className="field">
            <label>Volume</label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={settings.autoStart.setVolume}
                onChange={(e) => patch({ autoStart: { setVolume: e.target.checked } })}
              />
              set to
            </label>
            <input
              type="number"
              min={0}
              max={100}
              value={settings.autoStart.volume}
              disabled={!settings.autoStart.setVolume}
              onChange={(e) => patch({ autoStart: { volume: Number(e.target.value) } })}
            />
          </div>

          {settings.autoStart.enabled && !settings.autoStart.playlist && (
            <div className="next off">Pick a playlist, or nothing will happen.</div>
          )}
          <NextRun status={jobStatus('autoStart')} />

          <div className="card-actions">
            <button
              onClick={testStart}
              disabled={busy === 'start' || !settings.autoStart.playlist}
            >
              {busy === 'start' ? 'Starting…' : 'Start it now'}
            </button>
          </div>
        </div>

        {/* -------------------------------------------------------- podcast */}
        <div className="card">
          <div className="card-head">
            <h2>Daily podcast</h2>
            <Toggle
              checked={settings.podcast.enabled}
              onChange={(enabled) => patch({ podcast: { enabled } })}
            />
          </div>
          <p className="hint">
            Reads the feed at the scheduled time and plays whatever episode is newest — so it
            follows the show forward on its own.
          </p>

          <div className="field">
            <label>Play at</label>
            <input
              type="time"
              value={settings.podcast.time}
              onChange={(e) => patch({ podcast: { time: e.target.value } })}
            />
          </div>

          <div className="field">
            <label>Days</label>
            <DayPicker
              value={settings.podcast.days}
              onChange={(days) => patch({ podcast: { days } })}
            />
          </div>

          <div className="field">
            <label>Afterwards</label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={settings.podcast.resumeAfter}
                onChange={(e) => patch({ podcast: { resumeAfter: e.target.checked } })}
              />
              resume the music where it left off
            </label>
          </div>

          <div className="field">
            <label>Feed URL</label>
            <input
              type="url"
              className="grow"
              defaultValue={settings.podcast.feedUrl}
              onBlur={(e) => patch({ podcast: { feedUrl: e.target.value } })}
            />
          </div>

          <NextRun status={jobStatus('podcast')} />

          <div className="card-actions">
            <button onClick={playNow} disabled={busy === 'play'}>
              {busy === 'play' ? 'Starting…' : 'Play today’s episode'}
            </button>
            <button className="ghost" onClick={loadEpisode} disabled={busy === 'episode'}>
              {busy === 'episode' ? 'Checking…' : 'Check feed'}
            </button>
          </div>

          {episode && (
            <div className="episode">
              <div className="episode-title">{episode.episode.title}</div>
              <div className="hint">
                {episode.feedTitle}
                {episode.episode.pubDate &&
                  ` · ${new Date(episode.episode.pubDate).toLocaleString()}`}
                {episode.episode.duration ? ` · ${formatTime(episode.episode.duration)}` : ''}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------ auto-stop */}
        <div className="card">
          <div className="card-head">
            <h2>Auto-stop</h2>
            <Toggle
              checked={settings.autoStop.enabled}
              onChange={(enabled) => patch({ autoStop: { enabled } })}
            />
          </div>
          <p className="hint">
            Fades the volume down, stops playback, then restores the volume so tomorrow doesn't
            start silent.
          </p>

          <div className="field">
            <label>Stop at</label>
            <input
              type="time"
              value={settings.autoStop.time}
              onChange={(e) => patch({ autoStop: { time: e.target.value } })}
            />
          </div>

          <div className="field">
            <label>Days</label>
            <DayPicker
              value={settings.autoStop.days}
              onChange={(days) => patch({ autoStop: { days } })}
            />
          </div>

          <div className="field">
            <label>Fade</label>
            <input
              type="number"
              min={0}
              max={120}
              value={settings.autoStop.fadeSeconds}
              onChange={(e) => patch({ autoStop: { fadeSeconds: Number(e.target.value) } })}
            />
            <span className="hint inline">seconds · 0 = stop instantly</span>
          </div>

          <NextRun status={jobStatus('autoStop')} />

          <div className="card-actions">
            <button className="ghost" onClick={testStop} disabled={busy === 'stop'}>
              Test fade-out now
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function NextRun({ status }) {
  if (!status) return null;
  if (!status.enabled) return <div className="next off">Disabled</div>;
  if (status.ranToday) return <div className="next">Already ran today · next {status.nextRun}</div>;
  return <div className="next">Next run: {status.nextRun ?? 'no matching day selected'}</div>;
}

function Toggle({ checked, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider" />
    </label>
  );
}

function DayPicker({ value, onChange }) {
  const toggle = (day) => {
    const next = value.includes(day) ? value.filter((d) => d !== day) : [...value, day].sort();
    if (next.length) onChange(next);
  };
  return (
    <div className="days">
      {DAY_LABELS.map((label, day) => (
        <button
          key={day}
          type="button"
          title={DAY_NAMES[day]}
          className={`day ${value.includes(day) ? 'on' : ''}`}
          onClick={() => toggle(day)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
