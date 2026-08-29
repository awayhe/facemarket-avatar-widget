# facemarket-avatar-widget

A proof-of-concept for real-time [FaceMarket](https://facemarket.ai) live-avatar
video calls: a single Node/Express server that proxies FaceMarket's platform
APIs (so your API key never reaches the browser), plus a reusable, embeddable,
framework-free `FaceMarketWidget` UI component built on
`@sanseng/liveavatar-js-sdk`'s Direct Mode.

中文版本: [`README.zh-CN.md`](./README.zh-CN.md)

## What's in here

- **Backend** (`index.js`) — one Express process, one port. Proxies
  FaceMarket's avatar-listing and session-start/stop APIs, normalizes their
  response shapes, rate-limits and tracks sessions per caller, and serves the
  frontend (dev: Vite middleware with HMR; production: prebuilt static files).
- **`FaceMarketWidget`** (`web/src/FaceMarketWidget.js`) — a self-contained
  video-call UI (avatar picker, in-call controls, live captions with
  manual scroll-back, chat history, deep links) that renders into Shadow DOM
  so it can be dropped into any page without CSS collisions. See
  [`web/docs/FaceMarketWidget.md`](web/docs/FaceMarketWidget.md) for the full
  API.
- **Demo pages** — `web/src/main.js` (full-page app) and `web/demo.html` +
  `web/src/demo.js` (widget embedded in a small box on a page that drives its
  own avatar selection).

This is a proof-of-concept, not a production-hardened service — see
[`docs/api.md`](docs/api.md)'s "Known limitations" section (no caller
authentication, in-memory state) before deploying it for real traffic.

## Requirements

- Node.js 18+ (uses native `fetch`).
- A FaceMarket account and API key.

## Quick start

```bash
npm install
cp .env.example .env   # then fill in FACEMARKET_API_KEY
npm run dev
```

Open the printed `http://localhost:8787` URL — one process serves both the
API and the frontend, with full HMR in dev.

Other commands:

```bash
npm run build   # production build of the frontend to web/dist/
npm start       # NODE_ENV=production node index.js — run this after building
```

## Configuration

All via `.env` at the project root (see `.env.example`):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `FACEMARKET_API_KEY` | yes | — | Server-side only; never sent to the browser. |
| `FACEMARKET_BASE_URL` | no | `https://facemarket.ai/vih/dispatcher` | FaceMarket's dispatcher service origin. |
| `PORT` | no | `8787` | The one port this whole app listens on. |
| `TRUST_PROXY` | no | unset | Set when deployed behind a reverse proxy — see [`docs/nginx.md`](docs/nginx.md). |
| `BASE_PATH` | no | unset (root-mounted) | Mounts the whole app under a path prefix, e.g. `/liveavatar` — see [`docs/nginx.md`](docs/nginx.md). |

## Documentation

- [`docs/api.md`](docs/api.md) ([中文](docs/api.zh-CN.md)) — the backend's
  HTTP API / communication protocol reference.
- [`web/docs/FaceMarketWidget.md`](web/docs/FaceMarketWidget.md)
  ([中文](web/docs/FaceMarketWidget.zh-CN.md)) — the widget component's full
  constructor options and instance-method reference.
- [`docs/nginx.md`](docs/nginx.md) ([中文](docs/nginx.zh-CN.md)) — reverse-proxy
  deployment setup, with copy-paste-able config snippets in
  [`docs/nginx/`](docs/nginx/).
- [`CLAUDE.md`](CLAUDE.md) — architecture notes and implementation details
  for anyone working on this codebase.
- [`plans/adaptive-leaping-fairy.md`](plans/adaptive-leaping-fairy.md) — the
  original design rationale, including why Direct Mode was chosen over
  FaceMarket's undocumented Auth Mode token endpoint.
