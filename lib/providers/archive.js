// Internet Archive: independent catalogue and direct FLAC files.
import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'ia';
const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata';
const UA = { 'User-Agent': 'bitchord-hires-addon/1.0' };

async function fetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: UA, signal: controller.signal });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    try { return await response.json(); }
    catch { return { error: 'invalid JSON response' }; }
  } catch (error) {
    return { error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

// Only surface items with an explicit, recognized Creative Commons or
// Creative Commons public-domain license. IA uploads are user-submitted;
// an audio file being present on IA is not proof that it is authorized.
function isAllowedLicense(value) {
  const license = String(value || '').trim().toLowerCase();
  return /^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses\/[a-z0-9-]+\/|publicdomain\/(?:zero|mark)\/)/i.test(license);
}

export async function search(query) {
  const term = String(query || '').trim();
  if (!term) return { tracks: [] };
  return searchCache.wrap(`ia:${term.toLowerCase()}`, async () => {
    const params = new URLSearchParams({
      q: `mediatype:audio AND format:"Flac" AND licenseurl:http* AND (title:(${term}) OR creator:(${term}))`,
      rows: '12', page: '1', output: 'json',
    });
    params.append('fl[]', 'identifier');
    params.append('fl[]', 'title');
    params.append('fl[]', 'creator');
    params.append('fl[]', 'licenseurl');
    params.append('sort[]', 'downloads desc');
    const payload = await fetchJson(`${SEARCH}?${params}`);
    if (payload?.error) return { tracks: [], error: payload.error };
    const docs = payload?.response?.docs || [];
    const tracks = docs.filter((doc) => doc?.identifier && doc?.title && isAllowedLicense(doc?.licenseurl)).slice(0, 8).map((doc) => ({
      id: `${PREFIX}:${doc.identifier}`,
      title: String(doc.title),
      artist: Array.isArray(doc.creator) ? doc.creator.join(', ') : String(doc.creator || ''),
      album: '',
      artworkURL: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
      format: 'flac',
      audioQuality: 'LOSSLESS',
      source: 'Internet Archive',
      licenseURL: String(doc.licenseurl),
    }));
    return { tracks };
  }, { shouldCache: (result) => Boolean(result?.tracks?.length) });
}

function qualityScore(description) {
  // Prefer genuine bit depth first, then sample rate. File size is not a quality metric.
  return (Number(description.bitDepth) || 0) * 1_000_000 + (Number(description.sampleRate) || 0);
}

export async function resolve(id, quality) {
  const identifier = String(id || '').replace(/^ia:/, '');
  if (!identifier || identifier.includes('/') || identifier.includes('..')) return null;
  const tier = String(quality || 'LOSSLESS').toUpperCase();

  return streamCache.wrap(`ia:${identifier}:${tier}`, async () => {
    const payload = await fetchJson(`${META}/${encodeURIComponent(identifier)}`, 12000);
    if (payload?.error) return null;

    const licenseURL = payload?.metadata?.licenseurl;
    if (!isAllowedLicense(licenseURL)) return null;

    const files = (payload?.files || []).filter((file) =>
      typeof file?.name === 'string' && /\.flac$/i.test(file.name) && Number(file.size) > 200_000,
    );
    if (!files.length) return null;

    // Probe a few candidates and select by verified audio properties, not file size.
    const candidates = files.slice(0, 8);
    const verified = [];
    for (const file of candidates) {
      const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(file.name)}`;
      const description = await probeCache.wrap(url, () => describeAudioUrl(url, { timeoutMs: 12000 }), {
        shouldCache: (result) => result?.verified === true,
      });
      if (description?.verified && description.codec === 'flac' && description.container === 'flac') {
        verified.push({ file, description });
      }
    }
    if (!verified.length) return null;

    verified.sort((a, b) => qualityScore(b.description) - qualityScore(a.description));
    const selected = tier === 'LOW' ? verified[verified.length - 1] : verified[0];
    const { file, description } = selected;
    return {
      url: description.url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      ...(description.sampleRate ? { sampleRate: description.sampleRate } : {}),
      ...(description.bitDepth ? { bitDepth: description.bitDepth } : {}),
      ...(description.channels ? { channels: description.channels } : {}),
      ...(description.duration ? { duration: description.duration } : {}),
      ...(description.bitrate ? { bitrate: description.bitrate } : {}),
      format: 'flac',
      quality: qualityLabel(description),
      provider: 'Internet Archive',
      note: file.name,
      licenseURL: String(licenseURL),
    };
  }, { shouldCache: (result) => Boolean(result?.url) });
}

export const archive = { id: PREFIX, name: 'Internet Archive', search, resolve };
export const __test = { isAllowedLicense };
