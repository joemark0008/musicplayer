/**
 * Podcast feed reader.
 *
 * "Increment to today's episode" needs no date arithmetic: a daily show
 * publishes a new <item> every morning, so re-reading the feed and taking
 * the newest item IS the increment. We pick by max pubDate rather than
 * trusting feed order.
 *
 * mpv streams the episode URL directly — nothing is downloaded to disk.
 */

const cache = new Map(); // feedUrl -> { at, episode, feedTitle }
const CACHE_MS = 5 * 60 * 1000;

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&apos;': "'", '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ',
};

function decode(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

/** "01:23:45" or "204" (seconds) -> seconds */
function parseDuration(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function parseFeed(xml) {
  const feedTitle = tag(xml.split('<item')[0] || '', 'title');
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

  const episodes = [];
  for (const item of items.slice(0, 100)) {
    const enclosure = item.match(/<enclosure\b[^>]*?\burl=["']([^"']+)["'][^>]*>/i);
    if (!enclosure) continue;

    const pubDate = tag(item, 'pubDate');
    const published = pubDate ? new Date(pubDate) : null;

    episodes.push({
      title: tag(item, 'title') || 'Untitled episode',
      url: decode(enclosure[1]),
      pubDate: Number.isNaN(published?.getTime()) ? null : published?.toISOString() ?? null,
      published: Number.isNaN(published?.getTime()) ? 0 : published?.getTime() ?? 0,
      duration: parseDuration(tag(item, 'itunes:duration')),
      guid: tag(item, 'guid'),
      season: tag(item, 'itunes:season'),
      episodeNumber: tag(item, 'itunes:episode'),
    });
  }

  episodes.sort((a, b) => b.published - a.published);
  return { feedTitle, episodes };
}

export async function fetchLatestEpisode(feedUrl, { force = false, timeoutMs = 20000 } = {}) {
  const hit = cache.get(feedUrl);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let xml;
  try {
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'remote-music-server/1.0 (+podcast scheduler)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`feed returned ${res.status} ${res.statusText}`);
    xml = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`feed timed out after ${timeoutMs}ms: ${feedUrl}`);
    // A stale episode beats no episode when the network hiccups at 3pm.
    if (hit) return hit.value;
    throw new Error(`could not read feed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const { feedTitle, episodes } = parseFeed(xml);
  if (!episodes.length) throw new Error(`no playable episodes found in ${feedUrl}`);

  const value = {
    feedTitle,
    feedUrl,
    episode: episodes[0],
    fetchedAt: new Date().toISOString(),
  };
  cache.set(feedUrl, { at: Date.now(), value });
  return value;
}

export function clearPodcastCache() {
  cache.clear();
}
