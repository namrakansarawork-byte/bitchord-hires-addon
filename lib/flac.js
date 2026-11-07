// Inspect only the first bytes of a remote audio file. Some servers ignore Range;
// in that case read a small prefix from the response stream and cancel the rest.
const HEADER_BYTES = 4096;

function parseStreamInfo(bytes) {
  if (!bytes || bytes.length < 42) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') return null;
  if ((bytes[4] & 0x7f) !== 0) return null; // STREAMINFO must be first metadata block
  const blockLength = (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  if (blockLength !== 34) return null;

  const si = bytes.subarray(8, 42);
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 0x7) + 1;
  const bitDepth = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
  const totalSamples =
    (si[13] & 0x0f) * 2 ** 32 +
    ((si[14] << 24) >>> 0) +
    (si[15] << 16) +
    (si[16] << 8) +
    si[17];

  if (sampleRate < 1 || sampleRate > 655350) return null;
  if (channels < 1 || channels > 8 || bitDepth < 4 || bitDepth > 32) return null;
  const duration = totalSamples > 0 ? totalSamples / sampleRate : undefined;
  return { sampleRate, channels, bitDepth, totalSamples, ...(duration ? { duration } : {}) };
}

function hasMp3Frame(bytes) {
  let start = 0;
  if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3') {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    start = 10 + size;
  }
  for (let i = start; i + 3 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 0x03;
    const layer = (bytes[i + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[i + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[i + 2] >> 2) & 0x03;
    if (version !== 1 && layer !== 0 && bitrateIndex !== 0 && bitrateIndex !== 15 && sampleRateIndex !== 3) return true;
  }
  return false;
}

function totalBytesFromRange(contentRange) {
  if (!contentRange) return null;
  const match = /\/(\d+)\s*$/.exec(contentRange);
  return match ? Number(match[1]) : null;
}

async function readPrefix(response, limit) {
  if (!response.body?.getReader) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, Math.max(0, limit - length));
      if (part.length) {
        chunks.push(part);
        length += part.length;
      }
      if (value.length > part.length || length >= limit) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* response may already be closed */ }
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function describeAudioUrl(url, { timeoutMs = 9000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${HEADER_BYTES - 1}`, 'User-Agent': 'bitchord-hires-addon/1.0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (response.status !== 200 && response.status !== 206) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return { url, error: `probe returned ${response.status}` };
    }

    const bytes = await readPrefix(response, HEADER_BYTES);
    const totalBytes = totalBytesFromRange(response.headers.get('content-range'));
    const stream = parseStreamInfo(bytes);

    if (stream) {
      const bitrate = stream.duration && totalBytes
        ? Math.round((totalBytes * 8) / stream.duration)
        : undefined;
      return {
        url, codec: 'flac', container: 'flac', manifest: 'none', encrypted: false,
        ...stream,
        ...(bitrate ? { bitrate } : {}),
        verified: true,
      };
    }

    if (hasMp3Frame(bytes)) {
      return { url, codec: 'mp3', container: 'mp3', manifest: 'none', encrypted: false, verified: true };
    }
    return { url, error: bytes.length < 2 ? 'empty or truncated response' : 'unrecognised container' };
  } catch (error) {
    return { url, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export const __test = { parseStreamInfo, totalBytesFromRange, hasMp3Frame };

export function qualityLabel(description) {
  if (description.codec === 'flac' && description.sampleRate) {
    const depth = Number.isFinite(Number(description.bitDepth))
      ? `${description.bitDepth}-bit`
      : 'lossless';
    return `Lossless · ${depth} / ${(description.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
  }
  if (description.codec === 'mp3') {
    const kbps = Number(description.bitrate) > 0
      ? ` ${Math.round(Number(description.bitrate) / 1000)} kbps`
      : '';
    return `MP3${kbps}`;
  }
  return 'Unknown';
}
