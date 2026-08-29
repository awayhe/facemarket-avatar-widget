# Server API (Communication Protocol)

This document describes the HTTP API exposed by the project's single Express
server (`index.js` at the repo root). It's a thin proxy in front of
FaceMarket's platform APIs — it exists so `FACEMARKET_API_KEY` never reaches
the browser, and so the frontend never needs to know FaceMarket's actual
endpoint shapes.

中文版本: [`api.zh-CN.md`](./api.zh-CN.md)

Deploying this behind nginx? See [`nginx.md`](./nginx.md) (or the Chinese
version, [`nginx.zh-CN.md`](./nginx.zh-CN.md)) for reverse-proxy setup,
including the `BASE_PATH` option covered below.

## Base URL

Same origin as the frontend — one process, one port (`PORT`, default
`8787`). There is no CORS layer: the server sends no `Access-Control-*`
headers, so only same-origin requests work. A cross-origin `fetch()` from a
different page origin is blocked by the browser. If a specific partner
origin ever needs to call this API directly (e.g. the widget's
`apiBaseUrl` option pointed at a different backend), add an explicit
origin allowlist server-side rather than reflecting any `Origin`.

### Base path (`BASE_PATH`)

By default every route below lives at the paths shown (`/api/avatars`,
etc.) — the whole app is mounted at your domain's root. Set the `BASE_PATH`
env var (e.g. `BASE_PATH=/liveavatar`) to mount the whole app (API and
frontend alike) under a path prefix instead — every route in this document
then lives at `<BASE_PATH>/api/...` instead. This is the same value
`web/vite.config.js` reads to build matching asset URLs and this repo's own
demo (`web/src/main.js`) reads for its `apiBaseUrl`/`basePath` widget
options — one setting keeps the backend routes, the built frontend, and the
demo all in agreement. See [`nginx.md`](./nginx.md) for how this interacts
with a reverse proxy in front of the app.

A request outside `BASE_PATH` (e.g. plain `/api/avatars` when `BASE_PATH` is
set to `/liveavatar`) gets a normal `404` — it doesn't fall through to the
frontend or return anything from another route.

## Conventions

- All request/response bodies are JSON (`Content-Type: application/json`).
- Error responses are always `{ "error": string, ...extra }`. Proxy errors
  from FaceMarket additionally include `status` (FaceMarket's own HTTP
  status) and `detail` (FaceMarket's raw response body, parsed as JSON when
  possible).
- Every route reshapes FaceMarket's response into the normalized shape
  documented below (e.g. `avatarId` → `id`, unwrapping the `data`/`records`
  envelope) — deliberately, so the frontend has a stable contract with this
  server regardless of what FaceMarket itself calls things, or if that ever
  changes. The field names FaceMarket actually uses are confirmed from two
  sources: its published [Avatar User V2 API reference](https://doc.facemarket.ai/docs/API%20Reference/)
  for the avatar endpoints (`avatarId`/`avatarName`/`avatarDesc`/`cover`,
  wrapped in `data.records` for the list), and, for `/v1/session/start`
  (undocumented publicly), by reading `@sanseng/liveavatar-js-sdk`'s own
  compiled bundle — its "auth mode" calls this exact same dispatcher
  endpoint and parses `{ code, msg, data: { sessionId, sfuUrl, userToken } }`
  (`code === 0` for success), which is what this server checks for too (see
  `POST /api/session/start` below).

  > FaceMarket's response format also isn't guaranteed to hold in the
  > future — it's just externally confirmed as of this writing, not
  > enforced by a contract with them. Note this is different from claiming
  > the format is somehow "unstable" day-to-day; it's simply not something
  > this server has a guarantee about long-term.

## Endpoints

### `GET /api/avatars`

Lists every avatar available to this server's `FACEMARKET_API_KEY`.

**Response `200`**
```json
{
  "avatars": [
    { "id": "avatar_...", "name": "Clara", "description": "...", "cover": "https://..." }
  ]
}
```

**Response `502`** — FaceMarket's list-avatars call failed:
```json
{ "error": "Failed to list avatars", "status": 500, "detail": { "...": "..." } }
```

**Response `500`** — unexpected internal error.

---

### `GET /api/avatars/:avatarId`

Looks up a single avatar, used for shareable `/avatar/<id>` deep links so
the page doesn't have to fetch the whole list just to show one avatar.

**Response `200`**
```json
{ "id": "avatar_...", "name": "Clara", "description": "...", "cover": "https://..." }
```

**Response `404`** — unknown `avatarId`.
> FaceMarket itself returns HTTP `200` with an empty/nameless body for an
> unknown avatar id instead of a real `404`. This server detects that case
> (missing `id`/`name` in FaceMarket's response) and returns a proper `404`
> so clients don't need to special-case FaceMarket's quirk.

**Response `502` / `500`** — same shape as above.

---

### `POST /api/session/start`

Mints a FaceMarket session (SFU connection details) for a given avatar, so
the browser can join the call directly in **Direct Mode** — it never sees
`FACEMARKET_API_KEY`.

**Request body**
```json
{ "avatarId": "avatar_..." }
```

**Response `200`**
```json
{
  "sessionId": "9f6f366e4c804918",
  "sfuUrl": "wss://....livekit.cloud",
  "userToken": "eyJhbGciOi..."
}
```
If this caller's IP already has a tracked session for this same
`avatarId` (see [Session tracking](#session-tracking--reconnect-behavior)
below), that old session is stopped first, then this new one is started —
the response is always for the new session, there's no separate "already in
a call" error to handle.

**Response `400`** — missing `avatarId`:
```json
{ "error": "Missing avatarId" }
```

**Response `429`** — rate limited (see [Rate limiting](#rate-limiting)):
```json
{ "error": "Too many session requests from this network — try again in a minute." }
```

**Response `502`** — one of three cases, all logged server-side with the
raw FaceMarket response for debugging:
- The HTTP call to FaceMarket itself failed (non-2xx status).
- FaceMarket responded `200` but with a body-level error — `{ "code": N,
  "msg": "..." }` where `N !== 0` (this endpoint wraps even successful HTTP
  responses in `{ code, msg, data }`; a non-zero `code` is a business-level
  failure `response.ok` alone wouldn't catch). The `msg` FaceMarket sent is
  passed through as `error`, plus `code` on the response.
- The response was missing `sfuUrl`/`userToken` despite otherwise looking
  successful.

**Response `500`** — unexpected internal error.

---

### `POST /api/session/stop`

Best-effort release of a FaceMarket session. Always responds `200 { "ok":
true }` regardless of whether the upstream call to FaceMarket succeeded —
failures are logged server-side, not surfaced to the caller, since the
client is hanging up either way.

**Request body**
```json
{ "sessionId": "9f6f366e4c804918" }
```

If this `sessionId` matches a tracked session (see below), that tracking
entry is cleared too.

## Session tracking / reconnect behavior

The server keeps a small in-memory map from `(caller IP, avatarId)` to the
most recent session it minted for that pair. This is **not** a lock — it
never rejects a request. It only decides whether `POST /api/session/start`
should stop an old session first:

- **Same avatar, same IP, already has a tracked session** → that old
  session is stopped (best-effort call to FaceMarket), then the new one
  starts normally. This is what makes refreshing the page (or reconnecting)
  work cleanly: the browser calling `session/start` again for the same
  avatar just supersedes its own previous session instead of erroring.
- **Different avatar, or different IP** → starts independently, untouched
  by any other tracked session.

Each tracked entry also expires automatically after **30 minutes** if
nobody ever calls `session/stop` for it (closed tab, crash, network drop) —
this is purely to bound the map's memory growth, not a functional
requirement; a stale entry that's never cleaned up doesn't block or break
anything, it would just mean a `session/start` after the FaceMarket session
had already died naturally attempts one extra (harmless, ignored-on-failure)
stop call.

> **History**: an earlier version of this API used a `lac_id` cookie to hard
> **-reject** (`409`) a second `session/start` from the same browser while
> one was already active. That was dropped — a normal page refresh never
> calls `session/stop` (no `beforeunload` handler, and the cookie survives
> the refresh anyway), so an ordinary refresh could lock a browser out of
> starting a new call for up to that lock's own TTL, with no way to
> self-recover from the UI. The IP+avatarId supersede-instead-of-reject
> behavior above replaced it.

## Rate limiting

`POST /api/session/start` is limited to **6 requests per minute per IP
address** (`express-rate-limit`, window `60s`) — this is the actual defense
against cost/volume abuse (the session tracking above is a reconnect
convenience, not a security boundary). Responses include standard
rate-limit headers:

```
RateLimit-Policy: 6;w=60
RateLimit-Limit: 6
RateLimit-Remaining: 4
RateLimit-Reset: 60
```

and, once the limit is hit, a `Retry-After` header (seconds until the
window resets) alongside the `429` response.

`POST /api/session/stop`, `GET /api/avatars`, and `GET /api/avatars/:id`
are **not** rate-limited.

Both the rate limiter and the session-tracking key above use the caller's
IP (`req.ip`). If this app runs behind a reverse proxy, set `TRUST_PROXY`
(see `.env.example`) so `req.ip` reflects the real visitor instead of the
proxy's own address — see [`nginx.md`](./nginx.md).

## Known limitations (by design, for this POC)

- **No caller authentication.** Anyone who can reach this server can call
  every endpoint — the rate limit reduces abuse volume, but doesn't verify
  *who* is calling. A production deployment embedding this behind a real
  login system should check the caller's own session before minting a
  FaceMarket session (see the `TODO` comment above `POST /api/session/start`
  in `index.js`).
- **In-memory state.** The session-tracking map (`activeSessionByIpAndAvatar`)
  and rate-limit counters live in this single Node process's memory.
  Running multiple instances behind a load balancer would need to move this
  state to a shared store (e.g. Redis) to stay correct across instances.
