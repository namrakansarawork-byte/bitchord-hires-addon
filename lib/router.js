import { qobuz } from './providers/qobuz.js';
import { tidal } from './providers/tidal.js';
import { deezer } from './providers/deezer.js';
import { archive } from './providers/archive.js';
import { streamCache } from './cache.js';

// Tidal's public upstream has been unstable. It is opt-in until it passes live
// playback checks: set ENABLE_TIDAL_UPSTREAM=true to re-enable it.
const TIDAL_ENABLED = process.env.ENABLE_TIDAL_UPSTREAM === 'true';
const AUDIO_SOURCES = [qobuz, ...(TIDAL_ENABLED ? [tidal] : []), archive];
const CATALOGUE_SOURCES = [qobuz, ...(TIDAL_ENABLED ? [tidal] : []), deezer, archive];

function tierKey(raw) {
  const value = String(raw || 'LOSSLESS').toUpperCase();
  if (value.includes('HIGH') || value.includes('HI_RES')) return 'HIGH';
  if (value.includes('LOW')) return 'LOW';
  return 'LOSSLESS';
}

function decodeRow(row) {
  const { _isrc, _hiRes, _maxSampleRate, ...publicRow } = row;
  return publicRow;
}

export async function searchAll(query, quality) {
  const term = String(query || '').trim();
  if (!term) return { tracks: [], perSource: {} };

  const results = await Promise.allSettled(CATALOGUE_SOURCES.map((provider) => provider.search(term, quality)));
  const tracks = [];
  const seen = new Set();
  const perSource = {};

  for (let index = 0; index < results.length; index += 1) {
    const provider = CATALOGUE_SOURCES[index];
    const result = results[index];
    if (result.status === 'rejected') {
      perSource[provider.id] = { ok: false, count: 0, error: String(result.reason?.message || result.reason) };
      continue;
    }

    const value = result.value || {};
    const rows = Array.isArray(value.tracks) ? value.tracks : [];
    perSource[provider.id] = {
      ok: !value.error,
      count: rows.length,
      ...(value.error ? { error: String(value.error).slice(0, 180) } : {}),
    };

    for (const row of rows) {
      if (!row?.id || !row?.title) continue;
      const key = `${String(row.title).toLowerCase()}|${String(row.artist || '').toLowerCase()}|${row.duration || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(decodeRow(row));
      if (tracks.length >= 40) break;
    }
  }
  return { tracks, perSource };
}

export async function resolveStream(id, quality) {
  const raw = String(id || '');
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const providerId = raw.slice(0, separator);
  const key = `final:${raw}:${tierKey(quality)}`;
  const cached = streamCache.get(key);
  if (cached !== undefined) return cached;

  let resolved = null;
  try {
    if (providerId === 'qb') resolved = await qobuz.resolve(raw, quality);
    else if (providerId === 'ia') resolved = await archive.resolve(raw, quality);
    else if (providerId === 'td' && TIDAL_ENABLED) resolved = await tidal.resolve(raw, quality);
    else if (providerId === 'dz') resolved = await resolveDeezerMatch(raw, quality);
  } catch (error) {
    console.error(`[Router] ${providerId} resolution failed:`, error?.message || error);
  }

  // Only successful resolutions are cached. A transient miss must be retried.
  if (resolved?.url) return streamCache.set(key, resolved);
  return null;
}

async function resolveDeezerMatch(deezerId, quality) {
  const metadata = await deezer.getTrack(deezerId);
  if (!metadata?.title || !metadata?.artist) return null;

  const cleanTitle = String(metadata.title)
    .replace(/\s*[([{](?:feat|ft|with|prod)[^)}\]]*[)}\]]/gi, '')
    .trim();
  const query = `${metadata.artist} ${cleanTitle || metadata.title}`.trim();

  const candidates = [];
  for (const source of [qobuz, ...(TIDAL_ENABLED ? [tidal] : []), archive]) {
    try {
      const result = await source.search(query, quality);
      for (const row of result?.tracks || []) {
        const score = matchScore(row, metadata);
        if (score >= 75) candidates.push({ source, row, score });
      }
    } catch (error) {
      console.warn(`[Router] ${source.name} catalogue match failed:`, error?.message || error);
    }
  }

  // Resolve in score order, preferring Qobuz when recordings score equally.
  const preference = { qb: 0, td: 1, ia: 2 };
  candidates.sort((a, b) => b.score - a.score || preference[a.source.id] - preference[b.source.id]);
  for (const candidate of candidates) {
    try {
      const stream = await candidate.source.resolve(candidate.row.id, quality);
      if (stream?.url) return stream;
    } catch (error) {
      console.warn(`[Router] ${candidate.source.name} stream failed:`, error?.message || error);
    }
  }
  return null;
}

function normalise(value) {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function artistParts(value) {
  return String(value || '').split(/\s*(?:,|;|&|\bfeat\.?\b|\bft\.?\b|\band\b|\bx\b)\s*/i)
    .map(normalise).filter((part) => part.length > 2);
}

function artistMatch(a, b) {
  const left = artistParts(a);
  const right = artistParts(b);
  if (!left.length || !right.length) return false;
  return left.some((x) => right.some((y) => x === y || x.split(' ').reverse().join(' ') === y));
}

function matchScore(row, metadata) {
  const cleanedTitle = String(metadata.title || '').replace(/\s*[([{](?:feat|ft|with|prod)[^)}\]]*[)}\]]/gi, '').trim();
  const title = normalise(row.title);
  if (title !== normalise(metadata.title) && title !== normalise(cleanedTitle)) return 0;
  if (!artistMatch(row.artist, metadata.artist)) return 0;
  let score = 80;
  if (metadata.duration > 0 && row.duration > 0) {
    const drift = Math.abs(Number(row.duration) - Number(metadata.duration));
    if (drift > 12) return 0;
    score += drift <= 3 ? 20 : drift <= 7 ? 12 : 5;
  }
  if (metadata.isrc && row._isrc && metadata.isrc === row._isrc) score += 50;
  return score;
}

async function checkEndpoint(provider, url, { timeoutMs = 6000, validate } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const status = response.status;
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return { provider, configured: true, reachable: false, httpStatus: status, latencyMs: Date.now() - started, error: `HTTP ${status}` };
    }
    if (validate) {
      let body;
      try { body = await response.json(); }
      catch { return { provider, configured: true, reachable: false, httpStatus: status, latencyMs: Date.now() - started, error: 'invalid JSON' }; }
      if (!validate(body)) {
        return { provider, configured: true, reachable: false, httpStatus: status, latencyMs: Date.now() - started, error: 'unexpected response format' };
      }
    } else {
      try { await response.body?.cancel(); } catch { /* ignore */ }
    }
    return { provider, configured: true, reachable: true, httpStatus: status, latencyMs: Date.now() - started };
  } catch (error) {
    return { provider, configured: true, reachable: false, latencyMs: Date.now() - started, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function health() {
  const checks = await Promise.all([
    checkEndpoint('qobuz', `${process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://soundfean-musics.onrender.com/a'}/search?q=healthcheck&quality=LOSSLESS`, {
      validate: (body) => Array.isArray(body?.tracks),
    }),
    checkEndpoint('deezer', 'https://api.deezer.com/search?q=healthcheck&limit=1', {
      validate: (body) => Array.isArray(body?.data),
    }),
    checkEndpoint('archive', 'https://archive.org/advancedsearch.php?q=mediatype%3Aaudio&rows=1&output=json', {
      validate: (body) => Array.isArray(body?.response?.docs),
    }),
    ...(TIDAL_ENABLED
      ? [checkEndpoint('tidal', `${process.env.TIDAL_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com'}/search?q=healthcheck`, {
          validate: (body) => Array.isArray(body?.tracks),
        })]
      : [Promise.resolve({ provider: 'tidal', configured: false, enabled: false, reachable: false, error: 'disabled until upstream is verified' })]),
  ]);
  const audioIds = new Set(AUDIO_SOURCES.map((source) => source.id));
  return {
    ok: checks.some((check) => ['qobuz', 'archive', 'tidal'].includes(check.provider) && audioIds.has(check.provider === 'qobuz' ? 'qb' : check.provider === 'archive' ? 'ia' : 'td') && check.reachable),
    node: process.version,
    audioSources: AUDIO_SOURCES.map((source) => source.name),
    providers: checks,
  };
}
