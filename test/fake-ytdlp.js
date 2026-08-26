#!/usr/bin/env node
/**
 * A stand-in for yt-dlp: prints realistic progress output and writes a file
 * where the real thing would, without touching the network.
 *
 * Behaviour is driven by the URL so tests can pick a scenario:
 *   .../ok        → downloads one file successfully
 *   .../slow      → takes ~5s, for cancellation tests
 *   .../fail      → prints an ERROR line and exits 1
 *   .../noffmpeg  → simulates a missing ffmpeg
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log('2026.01.01');
  process.exit(0);
}

const outputIndex = argv.indexOf('--output');
const template = outputIndex === -1 ? null : argv[outputIndex + 1];
const url = argv[argv.length - 1];

if (!template) {
  console.error('ERROR: no output template');
  process.exit(1);
}

const dir = path.dirname(template);
const name = new URL(url).pathname.split('/').filter(Boolean).pop() || 'video';
const target = path.join(dir, `Fake ${name}.m4a`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (url.endsWith('/fail')) {
    console.log('[youtube] Extracting URL');
    console.error('ERROR: Video unavailable');
    process.exit(1);
  }

  // Exits 0 but writes nothing — what a partial YouTube 403 looks like.
  if (url.endsWith('/silentfail')) {
    console.log('[youtube] Extracting URL: ' + url);
    console.log(`[download] Destination: ${target}`);
    console.log('[download]  42.0% of 3.42MiB at 1.20MiB/s ETA 00:02');
    console.error('WARNING: unable to download video data: HTTP Error 403: Forbidden');
    process.exit(0);
  }

  if (url.endsWith('/noffmpeg')) {
    console.error('ERROR: ffprobe and ffmpeg not found. Please install or provide the path');
    process.exit(1);
  }

  const slow = url.endsWith('/slow');
  const steps = slow ? 25 : 5;

  console.log('[youtube] Extracting URL: ' + url);
  console.log(`[download] Destination: ${target}`);

  // A .part file, exactly as the real thing leaves behind mid-download.
  fs.writeFileSync(target + '.part', '');

  for (let i = 1; i <= steps; i++) {
    const pct = ((i / steps) * 100).toFixed(1);
    console.log(`[download]  ${pct}% of 3.42MiB at 1.20MiB/s ETA 00:0${steps - i}`);
    await sleep(slow ? 200 : 30);
  }

  fs.rmSync(target + '.part', { force: true });
  fs.writeFileSync(target, 'fake audio payload');
  console.log(`[ExtractAudio] Destination: ${target}`);
  console.log('[download] 100% of 3.42MiB in 00:01');
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(143));
main();
