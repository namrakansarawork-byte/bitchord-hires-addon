// Qobuz audio provider. Stream metadata is checked against the actual file header.
import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'qb';
const UPSTREAM = process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://soundfean-musics.onrender.com/a';
const SELF_HOSTED = process.env.QOBUZ_REST_API || '';
const UA = { Accept: 'application/json', 'User-Agent': 'bitchord-hires-addon/1.0' };
const QUALITY_MAP = { LOSSLESS: 'LOSSLESS', HIGH: 'HI_RES', LOW: 'LOW' };

export function normaliseQuality(raw) {
  const value = String(raw || 'LOSSLESS').toUpperCase();
  if (value.includes('HIGH') || value.includes('HI_RES')) return 'HIGH';
  if (value.includes('LOW')) return 'LOW';
  return 'LOSSLESS';
}

async function getJson(base, path, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { headers: UA, signal: controller.signal });
    if (!response.ok) return { error: `upstream HTTP ${response.status}`, status: response.status };
    try {
      return await response.json();
    } catch {
      return { error: 'upstream returned invalid JSON', status: response.status };
    }
  } catch (error) {
    return { error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function trackFromUpstream(item) {
  const id = String(item?.id || '');
  if (!/^\d+$/.test(id) || typeof item?.title !== 'string' || !item.title.trim()) return null;
  const hires = /24[\s-]*bit/i.test(String(item.audioQuality || ''));
  return {
    id: `${PREFIX}:${id}`,
    title: item.title.trim(),
    artist: String(item.artist || ''),
    album: String(item.album || ''),
    duration: Number(item.duration) > 0 ? Number(item.duration) : undefined,
    artworkURL: /^https?:\/\//i.test(String(item.artworkURL || '')) ? item.artworkURL : undefined,
    format: 'flac',
    audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
    source: 'Qobuz',
    _isrc: item.isrc || null,
  };
}

export async function search(query, quality) {
  const term = String(query || '').trim();
  if (!term) return { tracks: [] };
  const key = `qb:${normaliseQuality(quality)}:${term.toLowerCase()}`;
  return searchCache.wrap(key, async () => {
    const payload = await getJson(UPSTREAM, `/search?q=${encodeURIComponent(term)}&quality=LOSSLESS`);
    if (payload?.error) return { tracks: [], error: payload.error };
    const tracks = [];
    const seen = new Set();
    for (const item of Array.isArray(payload?.tracks) ? payload.tracks : []) {
      const row = trackFromUpstream(item);
      if (!row) continue;
      const dedupe = `${row.title.toLowerCase()}|${row.artist.toLowerCase()}|${row.duration || ''}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      tracks.push(row);
      if (tracks.length >= 25) break;
    }
    return { tracks };
  }, { shouldCache: (result) => Boolean(result?.tracks?.length) });
}

function isAcceptable(description, tier) {
  if (!description?.verified) return false;
  if (tier === 'LOW') return description.codec === 'mp3';
  if (description.codec !== 'flac' || description.container !== 'flac') return false;
  if (tier === 'HIGH') return Number.isFinite(Number(description.bitDepth)) && Number(description.bitDepth) >= 24;
  return true;
}

async function probe(url) {
  return probeCache.wrap(url, () => describeAudioUrl(url), {
    shouldCache: (result) => result?.verified === true,
  });
}

async function makeStream(url, tier) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;
  const description = await probe(url);
  if (!isAcceptable(description, tier)) return null;
  return {
    url: description.url,
    codec: description.codec,
    container: description.container,
    manifest: 'none',
    encrypted: false,
    ...(description.sampleRate ? { sampleRate: description.sampleRate } : {}),
    ...(description.bitDepth ? { bitDepth: description.bitDepth } : {}),
    ...(description.channels ? { channels: description.channels } : {}),
    ...(description.duration ? { duration: description.duration } : {}),
    ...(description.bitrate ? { bitrate: description.bitrate } : {}),
    format: description.codec,
    quality: qualityLabel(description),
    provider: 'Qobuz',
  };
}

export async function resolve(id, quality) {
  const trackId = String(id || '').replace(/^qb:/, '');
  if (!/^\d+$/.test(trackId)) return null;
  const tier = normaliseQuality(quality);
  return streamCache.wrap(`qb:${trackId}:${tier}`, async () => {
    if (SELF_HOSTED) {
      const payload = await getJson(SELF_HOSTED, `/track/getStreamUrl?id=${encodeURIComponent(trackId)}&quality=${tier}`, 10000);
      if (payload?.error || payload?.encrypted === true) return null;
      return makeStream(payload?.url || payload?.data?.url, tier);
    }
    const payload = await getJson(UPSTREAM, `/stream/${encodeURIComponent(trackId)}?quality=${QUALITY_MAP[tier]}`);
    if (payload?.error || payload?.encrypted === true) return null;
    return makeStream(payload?.url, tier);
  }, { shouldCache: (result) => Boolean(result?.url) });
}

export const qobuz = { id: PREFIX, name: 'Qobuz', search, resolve };
