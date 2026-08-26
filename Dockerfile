# ---------- stage 1: build the React UI ----------
FROM node:22-bookworm-slim AS client

WORKDIR /build
COPY client/package*.json ./client/
RUN npm --prefix client install

COPY client/ ./client/
RUN npm --prefix client run build

# ---------- stage 2: runtime ----------
FROM node:22-bookworm-slim

# mpv is what actually produces sound. --no-install-recommends keeps the
# image from dragging in X11 and a desktop's worth of dependencies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      mpv \
      libasound2-plugins \
      alsa-utils \
      ffmpeg \
      atomicparsley \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp changes fast and Debian's package lags badly — take the official
# standalone build so downloads keep working as sites change.
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY --from=client /build/client/dist ./client/dist

# The `node` user (uid 1000) ships with the base image. Adding it to `audio`
# lets the container open /dev/snd without running as root.
RUN usermod -aG audio node
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MUSIC_DIR=/music \
    MPV_SOCKET=/tmp/mpv-music-server.sock

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
