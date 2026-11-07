// Optional live smoke test. Unlike `npm test`, this requires working public upstreams.
import { health, searchAll, resolveStream } from '../lib/router.js';

const report = await health();
console.log('\n== Live provider health ==');
console.log(JSON.stringify(report.providers, null, 2));

console.log('\n== Live catalogue and playback ==');
const result = await searchAll('so what miles davis', 'LOSSLESS');
console.log('Search counts:', JSON.stringify(result.perSource));
console.log('Tracks returned:', result.tracks.length);
if (!result.tracks.length) {
  console.error('LIVE FAIL: no provider returned catalogue results. Check /health and upstream availability.');
  process.exit(1);
}

const audioRows = result.tracks.filter((track) => /^(qb|ia|td):/.test(track.id));
let resolved = null;
let resolvedFrom = null;
for (const track of audioRows) {
  const stream = await resolveStream(track.id, 'LOSSLESS');
  if (stream?.url) {
    resolved = stream;
    resolvedFrom = track.id;
    break;
  }
}
if (!resolved) {
  console.error('LIVE FAIL: search returned rows, but none of the direct audio rows resolved.');
  process.exit(1);
}
if (resolved.encrypted !== false || !/^https:\/\//i.test(resolved.url)) {
  console.error('LIVE FAIL: resolved stream violated the URL/encryption contract.');
  process.exit(1);
}
console.log('LIVE OK:', JSON.stringify({ id: resolvedFrom, provider: resolved.provider, codec: resolved.codec, quality: resolved.quality }));
