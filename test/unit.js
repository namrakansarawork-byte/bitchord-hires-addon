import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';
import { describeAudioUrl, qualityLabel, __test } from '../lib/flac.js';
import { health } from '../lib/router.js';

function buildFlacHeader(sampleRate, channels, bitDepth, totalSamples) {
  const bytes = new Uint8Array(64);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22], 0);
  const si = 8;
  bytes[si + 10] = (sampleRate >> 12) & 0xff;
  bytes[si + 11] = (sampleRate >> 4) & 0xff;
  bytes[si + 12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | (((bitDepth - 1) >> 4) & 1);
  bytes[si + 13] = (((bitDepth - 1) & 0x0f) << 4) | ((Math.floor(totalSamples / 2 ** 32)) & 0x0f);
  bytes[si + 14] = (totalSamples >>> 24) & 0xff;
  bytes[si + 15] = (totalSamples >>> 16) & 0xff;
  bytes[si + 16] = (totalSamples >>> 8) & 0xff;
  bytes[si + 17] = totalSamples & 0xff;
  return bytes;
}

async function run() {
  const parsed = __test.parseStreamInfo(buildFlacHeader(192000, 2, 24, 547 * 192000));
  assert.equal(parsed.sampleRate, 192000);
  assert.equal(parsed.channels, 2);
  assert.equal(parsed.bitDepth, 24);
  assert.ok(Math.abs(parsed.duration - 547) < 0.001);
  assert.equal(__test.parseStreamInfo(new Uint8Array(42)), null);
  const invalidLength = buildFlacHeader(44100, 2, 16, 1000);
  invalidLength[6] = 0x21;
  assert.equal(__test.parseStreamInfo(invalidLength), null);
  assert.equal(__test.totalBytesFromRange('bytes 0-4095/123456'), 123456);
  assert.equal(__test.hasMp3Frame(new Uint8Array([0xff, 0xfb, 0x90, 0x64])), true);
  assert.equal(__test.totalBytesFromRange('bytes 0-63/*'), null);

  assert.equal(qualityLabel({ codec: 'mp3' }), 'MP3');
  assert.equal(qualityLabel({ codec: 'mp3', bitrate: 320000 }), 'MP3 320 kbps');
  assert.match(qualityLabel({ codec: 'flac', sampleRate: 192000, bitDepth: 24 }), /24-bit \/ 192 kHz/);

  // A cache should coalesce concurrent requests and avoid caching misses.
  const cache = createCache(60_000);
  let calls = 0;
  const [a, b] = await Promise.all([
    cache.wrap('same', async () => { calls += 1; await Promise.resolve(); return { ok: true }; }),
    cache.wrap('same', async () => { calls += 1; return { ok: true }; }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  let misses = 0;
  await cache.wrap('miss', async () => { misses += 1; return null; });
  await cache.wrap('miss', async () => { misses += 1; return null; });
  assert.equal(misses, 2);
  let emptySearches = 0;
  await cache.wrap('empty', async () => { emptySearches += 1; return { tracks: [] }; }, {
    shouldCache: (result) => result.tracks.length > 0,
  });
  await cache.wrap('empty', async () => { emptySearches += 1; return { tracks: [] }; }, {
    shouldCache: (result) => result.tracks.length > 0,
  });
  assert.equal(emptySearches, 2);

  // Health checks validate status/shape and do not require disabled Tidal.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('soundfean-musics')) return Response.json({ tracks: [] });
    if (value.includes('api.deezer.com')) return Response.json({ data: [] });
    if (value.includes('archive.org')) return Response.json({ response: { docs: [] } });
    return new Response('', { status: 404 });
  };
  try {
    const report = await health();
    assert.equal(report.ok, true);
    assert.equal(report.providers.find((provider) => provider.provider === 'tidal')?.enabled, false);
    assert.equal(report.providers.find((provider) => provider.provider === 'qobuz')?.httpStatus, 200);
  } finally {
    globalThis.fetch = savedFetch;
  }

  // Range ignored (HTTP 200): only the requested prefix should be consumed.
  const header = buildFlacHeader(44100, 2, 16, 44100 * 180);
  let cancelled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(header);
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() { cancelled = true; },
  }), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  try {
    const result = await describeAudioUrl('https://unit.test/audio.flac');
    assert.equal(result.codec, 'flac');
    assert.equal(result.bitDepth, 16);
    assert.equal(result.verified, true);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('UNIT OK: FLAC parsing, quality labels, bounded probing, cache coalescing and negative-cache prevention');
}

run().catch((error) => {
  console.error('UNIT FAIL:', error);
  process.exit(1);
});
