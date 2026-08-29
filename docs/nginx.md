# Reverse Proxy Setup (nginx)

This app is a single Node/Express process serving both the API and the
frontend on one port (`PORT`, default `8787` — see [`api.md`](./api.md)).
Putting nginx in front of it is mostly about picking where it should live
on your domain, and (for production) letting nginx serve the built static
files directly instead of proxying them through Node.

中文版本: [`nginx.zh-CN.md`](./nginx.zh-CN.md)

The actual, copy-paste-able config snippets live in [`docs/nginx/`](./nginx/)
— they're meant to be `include`d into your *own* existing nginx config, not
used as a standalone `nginx.conf`. This document explains the concepts
behind them and which one to reach for.

## The core idea: `BASE_PATH`

Everything here builds on one env var, `BASE_PATH` (see `.env.example`). Set
it to a path prefix (e.g. `BASE_PATH=/liveavatar`) and the app itself — not
nginx — becomes aware that it's mounted there:

- `index.js` mounts every API route at `<BASE_PATH>/api/...` instead of
  `/api/...`, and serves the frontend from `<BASE_PATH>/` instead of `/`.
- `web/vite.config.js` reads the same variable for its build `base`, so
  built asset URLs (`<script>` tags, etc.) come out `<BASE_PATH>`-prefixed
  too.
- This repo's own demo (`web/src/main.js`) reads it (via a build-time
  constant Vite injects) to set the widget's `apiBaseUrl`/`basePath`
  options to match.

One setting, and the backend routes, the built frontend, and the demo all
agree — instead of three things to edit by hand and keep in sync. The
practical payoff for nginx: **it never needs to rewrite paths**. Every
config below is a plain passthrough (`proxy_pass http://liveavatar_backend;`
with no URI part), because the app already expects to receive whatever path
it's actually mounted at.

Leave `BASE_PATH` unset for the default: the whole app lives at your
domain's root.

## Which file do I need?

| Your situation | File |
| --- | --- |
| App owns your domain's root entirely (own subdomain, or nothing else running there); dev mode (`npm run dev`) | [`location.conf`](./nginx/location.conf) |
| App owns your domain's root; production build (`npm run build` + `npm start`) | Adapt [`location-static.conf`](./nginx/location-static.conf): use `root` instead of `alias`, drop the `/liveavatar` prefix from the `location` paths |
| App mounted under a path prefix (e.g. `/liveavatar`) on a domain that's otherwise free; dev mode | [`location-app-prefix.conf`](./nginx/location-app-prefix.conf) |
| Same, but production build | [`location-static.conf`](./nginx/location-static.conf) — nginx serves `web/dist/` directly, only `/liveavatar/api/*` hits Node |
| Embedding just the **widget** into an existing site that already owns `/` (and probably its own `/api/*`) — not this repo's own pages | [`location-api-prefix.conf`](./nginx/location-api-prefix.conf) — exposes only the API, under a non-colliding prefix |

All of them (except the API-only one, which doesn't need it) require
[`upstream.conf`](./nginx/upstream.conf) included once at the `http {}`
level — see that file's own comment for exactly where.

Every file has detailed comments inline; this table is just the map.

## Why dev and production need different files

`npm run dev` runs Vite's dev middleware inside the same Express process —
every request (even a `.js` file) is transformed on the fly and needs a
live Node process to handle it, so nginx has no choice but to proxy
everything through (`location.conf` / `location-app-prefix.conf`).

`npm run build` + `npm start` produces plain static files in `web/dist/`.
At that point, nginx serving them directly (`location-static.conf`, via
`alias` + `try_files`) is strictly better than proxying them through Node —
less load on the Node process, and nginx is simply better at serving static
files. Only the actual API calls (`/api/*`) still need to reach the backend
process.

## `TRUST_PROXY`

`POST /api/session/start` is rate-limited, and session-reconnect tracking
is also keyed, by the caller's IP (`req.ip` — see [`api.md`](./api.md)'s
"Rate limiting" section). Behind a reverse proxy, Express sees the proxy's
own IP for every request unless told to trust the proxy's
`X-Forwarded-For` header instead. Set in the app's `.env`:

```
TRUST_PROXY=1
```

("1" = trust exactly one hop in front of the process, i.e. this nginx.)
**Leave it unset** if the app is ever run directly with nothing in front of
it — trusting forwarded headers with no real proxy there would let any
client spoof its own IP and dodge the rate limit entirely. Every config in
`docs/nginx/` sets `X-Forwarded-For`/`X-Real-IP`/`X-Forwarded-Proto`
already; this env var is the other half of that — nginx sending the header
alone does nothing if the app isn't told to trust it.

## What's deliberately *not* proxied here

The actual call media/signaling never goes through this app or this nginx
config at all. `POST /api/session/start` returns an `sfuUrl` (`wss://...`)
that the browser connects to **directly** — straight to FaceMarket's SFU.
So none of this config needs (or should have) any WebRTC/media-specific
handling; it only ever carries plain HTTP request/response traffic, plus
(in dev) Vite's own HMR websocket.

## Testing locally

If you want to try any of this against a local nginx before deploying, the
pattern used while building these configs was: create your own
`server { listen 8081; ... }` block (a port that doesn't collide with
whatever else nginx already serves) referencing the relevant files above,
`nginx -t` to validate, `nginx -s reload`, then hit it directly — no need to
touch ports 80/443 or any existing config while iterating.
