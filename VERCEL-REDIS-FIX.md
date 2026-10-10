# Vercel / Redis check-in fix

The supplied code has several independent causes for the reported symptoms. This package fixes the application state handling. Your live deployment and Redis database were not accessible during this review.

## What was wrong

| Finding in the original files | Effect |
| --- | --- |
| Missing `UPSTASH_REDIS_REST_URL` or `UPSTASH_REDIS_REST_TOKEN` silently enables `global.__checkin`; `KV_REST_API_*` is ignored. | Different Vercel instances can show different competitions and check-ins. |
| `setMeta()` sets a 24-hour expiry. Only changing competitions renews it; polling and checking in do not. | Once it expires, the app falls back to competition `3529162`, potentially displaying its earlier check-ins. |
| Check-in requests contain only a player/group name and a boolean. | A click made while viewing competition A can update the current competition B, particularly when both contain `Group 1`. |
| Upstash JSON-deserializes values by default, while the payload tests `status === '1'`. | A numeric `1` is displayed as unchecked. |
| A poll starts every two seconds, even while the previous request or a write is outstanding. | Delayed responses can replace newer data on the screen. |
| There is one global competition selector, without organizer authentication. | Any visitor or deployment using the same Redis keys can change the event for everyone. |

The original per-player `HSET` writes are atomic. The problems are event selection, expiry, request context and response ordering around those writes.

## Install

Overlay the ZIP onto your existing project, preserving these paths. Keep your existing `css/styles.css`; it was not included in the uploaded files and is not replaced by this package.

| Uploaded filename | Project location |
| --- | --- |
| `competition.js` | `api/competition.js` |
| `stateStore.js` | `lib/stateStore.js` |
| `competitionLogic.js` | `lib/competitionLogic.js` |
| `main.js` | `js/main.js` |
| `index.html`, `package.json`, `package-lock.json`, `vercel.json` | Project root |

Also include the new `lib/errors.js`, `api/health.js`, `scripts/check-redis.js` and `test/` files supplied in the ZIP. Deploy the frontend and backend together, then reload every open check-in tab. The updated backend rejects old check-in requests that lack event context.

This app uses exported Node.js handlers in `/api`; it does not require an always-running `server.js` process or Socket.IO server. Keep your existing Vercel project configuration for this static frontend and API functions.

## Vercel environment variables

In Project Settings → Environment Variables, configure **one complete writable REST credential pair for Production**, then redeploy:

| Option | Required variables |
| --- | --- |
| Upstash REST | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Vercel KV / Upstash integration | `KV_REST_API_URL`, `KV_REST_API_TOKEN` |

Use the writable token. A read-only token can answer health reads but cannot save check-ins. `REDIS_URL` alone is a TCP connection string; this project's `@upstash/redis` client requires the REST URL and token above.

Optional settings:

| Variable | Behavior |
| --- | --- |
| `CHECKIN_ADMIN_PIN` | Requires an organizer PIN for changing or refreshing the competition. Set this to stop ordinary visitors changing the shared event. The PIN field appears when configured. |
| `CHECKIN_ROSTER_TTL_SECONDS` | External roster cache lifetime; default `86400`. The former `CHECKIN_STATE_TTL_SECONDS` is accepted for this cache only. |
| `CHECKIN_REDIS_PREFIX` | Explicit key namespace when multiple apps share Redis. Leave unset to preserve this app's existing Production keys. An explicit prefix overrides automatic environment isolation. |

Production retains `checkin:v1:` keys. Preview deployments use a separate namespace per branch; local development uses a separate namespace. Selection and check-ins no longer receive a TTL. Only the external player roster expires and refreshes.

On the first ordinary read, the patch removes expiry from existing selection and active-event check-in keys without clearing their contents. Data that already expired cannot be recovered by this patch. If the old selection has expired, select the correct competition again after deployment. Older deployments still running the original backend can continue writing the original shared keys; use the updated Production URL for check-ins.

Exact Metrix player names remain the status keys so existing check-ins are preserved. Duplicate names within one competition now produce an explicit error rather than silently sharing a check-in. Give those players distinct names upstream before loading that competition.

## Verify the deployed connection

1. Open the main app once, then open `https://YOUR-SITE.vercel.app/api/health`.
2. Expect HTTP `200`, `ok: true`, `storage: "redis"`, the correct `currentCompetitionId`, and `ttlSeconds.selection` / `ttlSeconds.checkIns` equal to `-1` for initialized keys. A positive roster TTL is normal; `-2` means a key does not exist yet. HTTP `503` includes a safe configuration/connectivity error and never falls back to memory.
3. Open the app on two devices. Check in different people concurrently, then confirm both devices show both check-ins. Switch the competition intentionally and confirm the new event appears on both devices. Stale requests return `409` and reload the correct list.

The health endpoint is read-only and labels write permission `not-tested`. To verify write/read permission too, run the supplied diagnostic locally with your server-side environment variables loaded. For Node.js 22 or later:

```sh
node --env-file=.env.local scripts/check-redis.js
```

Include `CHECKIN_REDIS_PREFIX=checkin:v1` in that local environment file if you also want its read-only report to inspect the Production selection. The diagnostic creates one uniquely named key with a 60-second expiry, reads it back, and deletes it. It never changes the competition or player statuses. Successful output includes `writeAccess: "verified"` and `readBack: "verified"`. Do not put Redis tokens in frontend JavaScript.

For an explicit, disposable local demonstration without Redis, `CHECKIN_ALLOW_MEMORY=true` enables local memory mode. It is refused on Vercel and in Production.

## Validation performed

28 automated checks passed, using the actual `@upstash/redis` SDK against an isolated local Redis 7.2.4 server. They cover legacy key migration, 80 concurrent user writes, wrong-event group clicks, a switch during mutation validation, A→B→A revisions, roster refresh races, expiry, storage failure, optional organizer protection, and the diagnostic script's disposable key cleanup.

Six additional checks executed the actual frontend script in a DOM environment, covering serialized polling/writes, capture of event context at the click, stale-request recovery, persistent connection errors, organizer PIN submission and literal rendering of player names.

To rerun the packaged checks:

```sh
npm ci
npm test
```

The Redis integration suite starts its own temporary local instance when `redis-server` and `redis-cli` are installed. It is explicitly skipped if those binaries are unavailable. It never connects to your Production database. You can supply nonstandard executable paths using `CHECKIN_TEST_REDIS_BINARY` and `CHECKIN_TEST_REDIS_CLI`.

Official references: [Vercel Node.js functions](https://vercel.com/docs/functions/runtimes/node-js), [Upstash JSON deserialization](https://upstash.com/docs/redis/sdks/ts/advanced), [Upstash Lua EVAL](https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval).
