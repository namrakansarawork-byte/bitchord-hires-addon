# juanjob hi res — BitChord Addon

A lightweight BitChord HTTP addon that returns direct audio URLs only after checking the actual media response. It uses no runtime dependencies and runs on Node.js 20+ / Vercel.

## Sources and fallback policy

| Source | Role | Default |
|---|---|---|
| Qobuz | Preferred audio source; requests the selected quality tier | Enabled |
| Internet Archive | Independent audio catalogue; only verified FLAC files are returned | Enabled |
| Deezer | Search catalogue only; a result is resolved by matching the same recording against an audio source | Enabled |
| Tidal | Optional provider; public upstream is not considered reliable until tested | Disabled |

Set `ENABLE_TIDAL_UPSTREAM=true` only after confirming that your configured Tidal upstream can search and deliver valid audio files. Tidal is intentionally excluded from normal search and playback by default.

A Qobuz ID is resolved by Qobuz. A Deezer catalogue ID can be matched against Qobuz, optional Tidal, and Internet Archive. The addon cannot safely switch a failed Qobuz ID to a different provider without track metadata; it will return a clean 404 rather than guess a different recording.

## Audio verification

- FLAC is verified by parsing the `fLaC` signature and the 34-byte STREAMINFO block, including sample rate, channel count, bit depth, and duration.
- The probe requests a small byte range. If a server ignores Range and responds with HTTP 200, the addon reads only a bounded prefix and cancels the response stream.
- MP3 is accepted only when an MPEG audio frame header is found; a content-type header alone is not enough.
- `HIGH` requires a verified FLAC file with at least 24-bit sample depth.
- `LOSSLESS` requires verified FLAC. `LOW` requests MP3 from Qobuz/Tidal; Internet Archive may return a lower-quality verified FLAC because its catalogue search is FLAC-only.
- Unknown or failed probes are not labelled as FLAC and are not cached as successful results.

The addon verifies the media header, not every audio frame or the audible integrity of the complete file. A valid header does not prove that a remote file is complete or corruption-free.

## Reliability

- Failed searches and stream resolutions are not cached, so a temporary upstream failure does not poison later requests.
- Successful lookups are cached in memory with LRU eviction.
- Concurrent identical requests share one in-flight upstream request.
- Health checks run concurrently, have a timeout, and report HTTP status and response-shape errors.
- The health endpoint tests upstream API reachability; it does not download or fully decode an audio stream.

The in-memory cache is local to a running serverless instance. It is not a persistent or globally shared cache.

## Deploy

```bash
npm install
npm test
npm run dev
```

Deploy to Vercel:

```bash
npm i -g vercel
vercel deploy --prod
```

Install the deployed root URL or `/manifest.json` in BitChord.

## Endpoints

```text
GET /manifest.json
GET /health
GET /search?q=...
GET /stream/{id}?quality=LOSSLESS|HIGH|LOW
```

`/stream` returns 404 when the requested recording cannot be resolved. This lets BitChord continue to another installed source.

## Tests

```bash
npm test          # deterministic offline unit tests
npm run test:live # optional live checks against current public upstreams
npm run test:contract # optional live BitChord contract test
```

Live tests depend on third-party service availability and may fail when an upstream is down or network access is blocked. That is not a failure of the offline unit suite.

## Optional environment variables

| Variable | Purpose |
|---|---|
| `QOBUZ_UPSTREAM_BASE_URL` | Override the public Qobuz upstream base URL |
| `QOBUZ_REST_API` | Use a self-hosted Qobuz REST API instead of the public proxy |
| `ENABLE_TIDAL_UPSTREAM` | Set to `true` to opt in to the Tidal provider |
| `TIDAL_UPSTREAM_BASE_URL` | Override the Tidal upstream base URL |

Do not commit `.env` files, credentials, or private API tokens.
