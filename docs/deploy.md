# Deploy and operate the PinCheck workbench

The workbench is one Node.js process with no dependencies and no database. It reads X Layer through a JSON-RPC endpoint and keeps a small in-memory cache, so any host that runs Node.js 22 or a container works. The GitHub Action does not depend on it.

## Cloudflare Workers (the public site)

The public site at https://pincheck.kiwiprotocol.workers.dev is a Cloudflare Worker with static assets:

```sh
npm install          # installs wrangler, the only dev dependency
npm run deploy       # node scripts/build-site.mjs && wrangler deploy
```

- `scripts/build-site.mjs` writes `dist/`: the site with the version filled in, `/docs` rendered from `docs/install.md`, the recorded examples, the vendored libraries, a 404 page, and a `_headers` file with the CSP and caching rules.
- `wrangler.jsonc` routes only `/api/*` to `worker.mjs` (`run_worker_first`); every other request is a static asset, which Cloudflare compresses and caches.
- `worker.mjs` uses the same `src/api.mjs` as the Node server, so validation, per-client limits, the pinned-result cache and response headers are identical. The cache lives per Worker isolate.
- Set `X_LAYER_RPC` with `npx wrangler secret put X_LAYER_RPC` to use a private endpoint. `PINCHECK_MAX_CONCURRENCY` is a plain variable in `wrangler.jsonc`.
- `npm run dev:worker` runs the same build in the local Workers runtime on port 8787. `npx wrangler tail` streams production logs; `npx wrangler rollback` restores the previous version.

## Launch on your own server

```sh
NODE_ENV=production HOST=0.0.0.0 PORT=8080 node server.mjs
```

or with the container in this repository:

```sh
docker build -t pincheck .
docker run --rm -p 8080:8080 -e X_LAYER_RPC="$X_LAYER_RPC" pincheck
```

Put it behind your usual HTTPS proxy or platform load balancer. Run one instance per host; instances share nothing, so more instances only spread load.

The site's JavaScript libraries and fonts (three.js, TypeGPU, Geist) are bundled into `web/vendor` and served from the same origin, so the strict Content Security Policy needs no third-party hosts. `npm run vendor` rebuilds them from pinned npm versions; the server gzips text assets on the fly.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4173` (`8080` in the container) | Listen port |
| `HOST` | `127.0.0.1` (`0.0.0.0` in the container) | Listen address |
| `X_LAYER_RPC` | `https://rpc.xlayer.tech` | X Layer mainnet RPC. May contain a key; it is never returned in responses, reports or logs. Use an archive endpoint if visitors rerun old permalinks. |
| `PINCHECK_MAX_CONCURRENCY` | `4` | Comparisons running at once across all clients. Each client may run one at a time. |
| `PINCHECK_TRUST_PROXY` | unset | Set to `1` only behind a proxy you control, so the per-client limit uses `X-Forwarded-For`. |
| `PINCHECK_RPC_TRANSPORT` | unset | `curl` sends RPC calls through curl, for networks where Node fetch cannot reach the RPC. |
| `NODE_ENV` | unset | `production` caches the rendered docs page. |

## Health

- `GET /api/health` returns `200` with the version, the number of comparisons running and the cache size. Use it for liveness.
- `GET /api/health?deep=1` also asks the RPC for its chain ID with a 5-second timeout. It returns `503` with `rpcError` when the RPC is down or is not chain 196. Use it for alerting, not for restarts: restarting does not fix an RPC outage.

The server writes one JSON line per comparison (`status`, `code`, duration, cache result) and one per unexpected error. It does not log client addresses or circuit inputs.

## Limits enforced by the server

The workbench evaluates up to 24 input bits exhaustively within 2^28 gate-word operations and a 20-second evaluation budget. Every comparison also has a 60-second RPC budget, 15 seconds per call, 400 calls and 2.5 MB per response. Requests are capped at 75 seconds. Comparisons pinned to a block hash are cached (200 entries), and identical requests in flight share one run.

## Runbook: the RPC is failing

PinCheck retries HTTP 429, 502, 503 and 504 and JSON-RPC rate-limit errors up to three times per call, honoring `Retry-After`, before giving up. Public endpoints rate-limit shared egress addresses such as Cloudflare's, so occasional retries are normal.

Symptoms: comparisons return **Inconclusive** with `rpc-unavailable`, `rpc-timeout` or `rpc-error`, and `/api/health?deep=1` returns `503`.

1. Confirm the endpoint from the host: `curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$X_LAYER_RPC"` should print `"result":"0xc4"`.
2. If the public endpoint is down, set `X_LAYER_RPC` to another X Layer mainnet endpoint and restart. Reports record only whether a configured endpoint was used, never its URL.
3. Nothing else needs to change. Recorded examples, saved reports and the docs keep working without an RPC, and the workbench keeps evidence on screen when a live rerun fails.
4. GitHub checks that ran during the outage are **Inconclusive** and block merges. They never pass. After recovery, rerun the failed jobs.

If reruns of old permalinks fail with `historical-state-unavailable`, the RPC has pruned that block. The recorded report is still valid; use an archive endpoint to rerun it.

If a comparison returns `replay-disagrees`, a deployed processor returned a different output than PinCheck. Treat it as a defect: keep the report and open an issue. The check stays failed.
