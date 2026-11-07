// Optional Tidal provider. Disabled by default until its public upstream is verified.
import { describeAudioUrl, qualityLabel } from '../flac.js';
import { streamCache, probeCache } from '../cache.js';

const PREFIX = 'td';
const UPSTREAM = process.env.TIDAL_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com';
const UA = { 'User-Agent': 'bitchord-hires-addon/1.0' };

function normaliseQuality(raw) {
  const value = String(raw || 'LOSSLESS').toUpperCase();
  if (value.includes('HIGH') || value.includes('HI_RES')) return 'HIGH';
  if (value.includes('LOW')) return 'LOW';
  return 'LOSSLESS';
}

async function getJson(path, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${UPSTREAM}${path}`, { headers: UA, signal: controller.signal });
    if (!response.ok) return { error: `upstream HTTP ${response.status}` };
    try { return await response.json(); }
    catch { return { error: 'upstream returned invalid JSON' }; }
  } catch (error) {
    return { error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function search(query) {
  const term = String(query || '').trim();
  if (!term) return { tracks: [] };
  const payload = await getJson(`/search?q=${encodeURIComponent(term)}`);
  if (payload?.error) return { tracks: [], error: payload.error };
  return {
    tracks: (Array.isArray(payload?.tracks) ? payload.tracks : [])
      .filter((track) => track?.id && track?.title)
      .slice(0, 25)
      .map((track) => ({
        id: `${PREFIX}:${String(track.id).replace(/^td:/, '')}`,
        title: String(track.title),
        artist: String(track.artist || ''),
        album: String(track.album || ''),
        duration: Number(track.duration) > 0 ? Number(track.duration) : undefined,
        artworkURL: /^https?:\/\//i.test(String(track.artworkURL || '')) ? track.artworkURL : undefined,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        source: 'Tidal',
      })),
  };
}

export async function resolve(id, quality) {
  const tidalId = String(id || '').replace(/^td:/, '');
  if (!tidalId || /[/:]/.test(tidalId)) return null;
  const tier = normaliseQuality(quality);
  return streamCache.wrap(`td:${tidalId}:${tier}`, async () => {
    const payload = await getJson(`/stream/${encodeURIComponent(tidalId)}?quality=${tier}`);
    if (payload?.error || payload?.encrypted === true || !/^https:\/\//i.test(String(payload?.url || ''))) return null;
    const description = await probeCache.wrap(payload.url, () => describeAudioUrl(payload.url), {
      shouldCache: (result) => result?.verified === true,
    });
    if (!description?.verified) return null;
    if (tier === 'LOW' ? description.codec !== 'mp3' : description.codec !== 'flac') return null;
    if (tier === 'HIGH' && (!Number.isFinite(Number(description.bitDepth)) || Number(description.bitDepth) < 24)) return null;
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
      provider: 'Tidal',
    };
  }, { shouldCache: (result) => Boolean(result?.url) });
}

export const tidal = { id: PREFIX, name: 'Tidal', search, resolve };
