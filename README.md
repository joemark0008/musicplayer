# Remote Music Server

Audio plays out of **the server's** sound card. The React UI runs in a browser on
your PC and only sends commands.

```
Your PC (browser)          Server (Linux)
┌────────────────┐         ┌──────────────────────────────┐
│ React UI       │  HTTP   │ Express API                  │
│  transport     │ ──────► │   │                          │
│  library/queue │  WS     │   ▼ JSON IPC (unix socket)   │
│  live state    │ ◄────── │ mpv ──► ALSA/PipeWire ──► 🔊 │
└────────────────┘         └──────────────────────────────┘
```

## Requirements (on the server)

```bash
sudo apt update
sudo apt install -y mpv nodejs npm     # Node 20+ recommended
node -v                                 # must be >= 20
```

If your distro ships an old Node, use nodesource or nvm.

## Install

```bash
cd music-server
npm install          # backend deps
npm run build        # installs client deps and builds the React UI
```

## Run

```bash
MUSIC_DIR=/srv/music npm start
```

Then open `http://<server-ip>:3000` from your PC.

### Environment variables

| Variable       | Default        | Purpose                                                        |
| -------------- | -------------- | -------------------------------------------------------------- |
| `MUSIC_DIR`    | `$HOME/Music`  | Folder scanned recursively for audio files                      |
| `PORT`         | `3000`         | HTTP port                                                       |
| `HOST`         | `0.0.0.0`      | Bind address; use `127.0.0.1` if fronting with nginx            |
| `AUDIO_DEVICE` | mpv default    | e.g. `alsa/hw:1,0` or `pipewire`. See `GET /api/audio-devices`  |
| `AUTH_TOKEN`   | *(none)*       | If set, API + WebSocket require it; open UI as `/?token=...`    |
| `MPV_SOCKET`   | `$TMPDIR/...`  | IPC socket path                                                 |

## Playlists

**A playlist is a folder.** Creating "Chill Mix" creates
`MUSIC_DIR/Playlists/Chill Mix/`. Nothing is stored in a database, so the
folders make sense on their own — browse them in Finder, copy one to a USB
stick, and it still works.

Adding an existing library track creates a **relative symlink**, so a song can
sit in ten playlists without costing ten copies of disk. Downloads land in the
folder as real files. On a filesystem that can't do symlinks (exFAT, some SMB
shares) it silently falls back to copying.

Playlist tracks are indexed by the normal scan — that's how they're playable —
but hidden from the main Library list, otherwise every song would show up twice.
Add `?include=playlists` to `/api/library` to see them.

Two deletions are deliberately awkward, because they'd be unrecoverable:
removing a **real file** (a download) from a playlist, and deleting a playlist
that **contains** real files. Both need a confirmation; symlinks are removed
without ceremony since the original is untouched.

## Downloading from YouTube

Requires `yt-dlp` and `ffmpeg` on the server:

```bash
brew install yt-dlp ffmpeg          # macOS
sudo apt install ffmpeg && pipx install yt-dlp   # Debian/Ubuntu
```

Debian's `yt-dlp` package lags badly and breaks when YouTube changes; `pipx`
or the [standalone binary](https://github.com/yt-dlp/yt-dlp/releases) is worth
the extra step. The Docker image already bundles both.

Pick a playlist, paste a link, hit Download. Progress streams live over the
WebSocket, and the track is playable the moment it finishes — the library
rescans itself. Tick **whole playlist** to grab every video behind a
`&list=…` link instead of just the one.

Audio is saved as **m4a**, preferring YouTube's native AAC stream so extraction
is a remux rather than a re-encode — no generation loss. Title, artist and
thumbnail are embedded as tags.

If yt-dlp isn't installed the download box is disabled and tells you so, rather
than failing at the moment you paste a link.

**On the legal side:** downloading from YouTube generally violates their Terms
of Service, and re-uploading or distributing what you download may infringe
copyright regardless. Content you own, public-domain material, and
Creative-Commons-licensed uploads are the safe cases. Worth knowing where you
stand before pointing this at a commercial music video.

## Schedules

The **Schedule** tab has two jobs. Both are off until you enable them, both save
the moment you change them, and both fire on the timezone set at the top of the
tab — **Asia/Manila** by default, so "15:00" means 3PM Philippine time no matter
what the server's own clock says.

### Daily podcast (3PM)

Points at *Our Daily Bread* by default:

```
https://feeds.transistor.fm/our-daily-bread-podcast
```

**How it "increments" to the right episode:** it doesn't compute a date. At the
scheduled time it re-reads the RSS feed and takes the item with the newest
`pubDate`. A daily show publishes a new item every morning, so reading the feed
*is* the increment — no episode counter to drift, nothing to fix when the show
skips a day or posts a bonus episode.

mpv streams the episode URL directly. Nothing is downloaded, so this works fine
with a small disk.

At 3PM it stops whatever music is playing, plays that episode, and stops when
it ends — the music queue is left untouched, so you can hit play afterwards and
carry on where you were.

To use a different show: find it on Apple Podcasts, take the numeric id from the
URL, and ask iTunes for the real feed:

```bash
curl -s "https://itunes.apple.com/lookup?id=383323406" | grep -o '"feedUrl":"[^"]*"'
```

Paste that into the Feed URL box. Any standard RSS podcast feed works.

### Auto-stop

At the configured time it ramps the volume to zero over `fadeSeconds`, stops,
then puts the volume back where you had it — otherwise tomorrow would start
silent. Set the fade to `0` for a hard stop. Pressing play during a fade cancels
it and restores the volume immediately.

### Behaviour worth knowing

- **Fires once per day per job.** Restarting the server at 4PM will not
  retroactively fire the 3PM podcast.
- **15-minute grace window.** If the server was asleep and comes back more than
  15 minutes late, the job is skipped for that day rather than firing at a
  random hour. Logged as `[schedule] podcast skipped`.
- **Settings live in `config.json`** next to the app. Override the location with
  `CONFIG_PATH`. Under Docker, mount it so it survives rebuilds.
- **Test without waiting.** The buttons in the tab run each job on demand, or:

  ```bash
  curl -X POST localhost:3000/api/schedule/run -H 'Content-Type: application/json' -d '{"job":"podcast"}'
  ```

### Extra endpoints

| Method | Path                    | Body                            |
| ------ | ----------------------- | ------------------------------- |
| GET    | `/api/settings`         | — (returns settings + schedule) |
| PUT    | `/api/settings`         | partial settings object         |
| GET    | `/api/schedule`         | —                               |
| GET    | `/api/time`             | — (wall clock in your timezone) |
| GET    | `/api/podcast/latest`   | `?refresh=1` to bypass cache    |
| POST   | `/api/podcast/play`     | —                               |
| POST   | `/api/schedule/run`     | `{job: "podcast"\|"autoStop"}`  |
| POST   | `/api/fade-stop`        | `{seconds}`                     |

## Development

Two terminals:

```bash
npm run dev          # backend on :3000, restarts on change
npm run client:dev   # Vite on :5173, proxies /api and /ws to :3000
```

Open `http://localhost:5173`. If you're editing from your PC but the server is
elsewhere, run Vite locally with `BACKEND=http://server-ip:3000 npm run client:dev`.

## Docker

**Linux hosts only.** Docker Desktop for Mac and Windows runs containers inside a
Linux VM that has no sound device — there is no `/dev/snd` to pass through, so a
container there can never make noise. On a Mac, run the server natively
(`brew install mpv && npm start`). Docker is for the Linux box that owns the speakers.

```bash
touch config.json          # first run only — Docker would otherwise
                           # create a *directory* at this bind mount
MUSIC_DIR=/srv/music docker compose up -d --build
docker compose logs -f
```

Open `http://<server-ip>:3000`.

### Getting audio out of the container

Two approaches; `docker-compose.yml` ships with the first enabled.

**A — ALSA directly.** Passes `/dev/snd` in and adds the container user to the
`audio` group. Simplest, and the right choice on a headless box with no sound
server. Nothing else on the host may hold the card open.

**B — PipeWire/PulseAudio socket.** Mount the host's sound-server socket and set
`PULSE_SERVER`. Use this if the server is also a desktop, so audio mixes with
everything else instead of fighting for the device. Swap the commented block in
`docker-compose.yml` and set the uid in `/run/user/1000` to match `id -u`.

Check what mpv can see from inside:

```bash
docker exec music-server mpv --audio-device=help
docker exec music-server speaker-test -t sine -f 440 -l 1   # should be audible
```

If `speaker-test` is silent, the problem is the device passthrough, not this app.

### Notes

- Music is mounted read-write at `/music` — playlists are folders and downloads
  are files, both created under `/music/Playlists`. Nothing outside that folder
  is ever written.
- The image bundles `ffmpeg` and the official standalone `yt-dlp` build, so
  downloads work out of the box.
- The image runs as the non-root `node` user.
- `docker compose up -d --build` after pulling changes — the client build is baked
  into the image, so a rebuild is needed for UI changes.

## Tests

```bash
npm test
```

141 assertions, no network and no mpv required:

- `test/schedule-test.js` — timezone conversion, the fire-once-per-day rule,
  the grace window, settings validation, RSS parsing.
- `test/playlist-test.js` — name sanitising, path-traversal refusal, symlink
  creation, the confirm-before-deleting-real-files rules, and the whole
  download queue against `test/fake-ytdlp.js` (progress, failure reporting,
  cancellation, partial-file cleanup).
- `test/smoke-test.js` — the full API against `test/fake-mpv.js`, a stub that
  speaks mpv's IPC protocol but plays nothing. The podcast tests run against a
  throwaway local feed server.

## Raspberry Pi one-shot install

```bash
cd music-server
chmod +x install-pi.sh
./install-pi.sh --music-dir /mnt/usb/Music
```

Installs mpv, ffmpeg, Node 22 and yt-dlp, checks the sound card, adds you to the
`audio` group, builds the UI, writes a systemd unit with the right paths and uid,
enables lingering (so audio works with nobody logged in), and starts it. Prints
the URL when it's done.

It's safe to re-run — a second pass skips what's already installed and just
rebuilds and restarts. See what it would do first with `--dry-run`, and remove
the service with `--uninstall` (your music is never touched). `--help` lists
the rest.

Needs 64-bit Raspberry Pi OS on a Pi 3 or newer; it refuses to run on armv6.

## Run as a service

Copy `music-player.service` to `/etc/systemd/system/`, edit the paths and user, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now music-player
journalctl -u music-player -f
```

The unit runs as a normal user so mpv can reach that user's audio session. If the
server is headless with no logged-in session, either enable lingering
(`sudo loginctl enable-linger youruser`) or set `AUDIO_DEVICE` to an ALSA device
directly to bypass PipeWire/PulseAudio.

## API

| Method | Path                  | Body                                   |
| ------ | --------------------- | -------------------------------------- |
| GET    | `/api/state`          | —                                      |
| GET    | `/api/library?q=`     | —                                      |
| POST   | `/api/library/scan`   | —                                      |
| POST   | `/api/play`           | `{id}` \| `{index}` \| `{}` to resume  |
| POST   | `/api/pause`          | —                                      |
| POST   | `/api/toggle`         | —                                      |
| POST   | `/api/next`           | —                                      |
| POST   | `/api/previous`       | —                                      |
| POST   | `/api/stop`           | —                                      |
| POST   | `/api/seek`           | `{position}` seconds                   |
| POST   | `/api/volume`         | `{volume}` 0–130                       |
| POST   | `/api/mute`           | `{muted}`                              |
| POST   | `/api/repeat`         | `{mode: "off"\|"all"\|"one"}`          |
| POST   | `/api/shuffle`        | `{shuffle}`                            |
| POST   | `/api/queue`          | `{ids, mode, startIndex}`              |
| POST   | `/api/queue/add`      | `{ids}`                                |
| POST   | `/api/queue/remove`   | `{index}`                              |
| POST   | `/api/queue/move`     | `{from, to}`                           |
| POST   | `/api/queue/clear`    | —                                      |
| GET    | `/api/audio-devices`  | —                                      |
| GET    | `/api/playlists`      | —                                      |
| GET    | `/api/playlists/:name`| —                                      |
| POST   | `/api/playlists`      | `{name}`                               |
| POST   | `/api/playlists/:name/rename` | `{name}`                       |
| POST   | `/api/playlists/:name/delete` | `{force}`                      |
| POST   | `/api/playlists/:name/tracks` | `{ids}` (symlinks them in)     |
| POST   | `/api/playlists/:name/tracks/remove` | `{id, force}`           |
| POST   | `/api/playlists/:name/play`   | `{mode, startIndex}`           |
| GET    | `/api/downloads`      | —                                      |
| POST   | `/api/downloads`      | `{url, playlist, wholePlaylist}`       |
| POST   | `/api/downloads/:id/cancel` | —                                |

`ws://host/ws` pushes `{type:"state", state}` roughly once a second and on every change.

Every mutating endpoint returns the full player state, so the UI stays in sync
without a follow-up request.

## Keyboard shortcuts

`Space` play/pause · `Shift+→` next · `Shift+←` previous

## On a phone

The UI is responsive, and a phone makes a good remote. Open the same
`http://<server-ip>:3000` in mobile Safari or Chrome, then Add to Home Screen
for a full-screen, chrome-free launcher.

Touch-specific behaviour:

- **Single tap plays a track** (double-click on desktop) — detected via
  `pointer: coarse`, so a laptop with a touchscreen still behaves like a laptop.
- The **volume slider hides behind the 🔊 button** so the player bar stays two
  rows tall; on desktop it's always visible.
- Playlists become a horizontally scrolling chip strip instead of a sidebar.
- Layout respects the notch and home indicator via `env(safe-area-inset-*)`,
  and uses `dvh` so the player bar isn't buried under the address bar.
- Inputs are 16px on mobile, which stops iOS zooming in when you focus them.

## Notes and gotchas

- **No sound but state says playing?** mpv picked the wrong output. Check
  `GET /api/audio-devices` and set `AUDIO_DEVICE`.
- **Track tags look like filenames.** `music-metadata` is an optional dependency;
  if it failed to install, the scanner falls back to `Artist - Title.mp3` parsing.
  `npm install music-metadata` fixes it.
- **Exposing to the internet:** set `AUTH_TOKEN`, put nginx with TLS in front, and
  bind `HOST=127.0.0.1`. The token in a query string is fine on a LAN, weak on the
  open internet — a reverse proxy with real auth is better.
- **Library files are never served over HTTP.** Only metadata leaves the server;
  the audio path is stripped from every response.
