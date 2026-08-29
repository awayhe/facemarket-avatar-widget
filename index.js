import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import express from "express";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";

const {
  FACEMARKET_API_KEY,
  FACEMARKET_BASE_URL = "https://facemarket.ai/vih/dispatcher",
  PORT = 8787,
  TRUST_PROXY,
  BASE_PATH: RAW_BASE_PATH,
} = process.env;

if (!FACEMARKET_API_KEY) {
  throw new Error("Missing FACEMARKET_API_KEY in .env");
}

// Same platform/host as FACEMARKET_BASE_URL, but the "asset" service (avatar
// CRUD) lives under a different path prefix than the "dispatcher" (sessions).
const FACEMARKET_ASSET_BASE_URL = `${new URL(FACEMARKET_BASE_URL).origin}/vih/asset`;

// Path prefix this whole app (API + frontend) is mounted under, e.g.
// "/liveavatar" if reverse-proxied there — "" (default) means root-mounted.
// web/vite.config.js reads this SAME env var for its build `base`, and
// forwards it into the client bundle for main.js's apiBaseUrl/basePath —
// one value drives the backend's routes, the built asset URLs, and the
// frontend's own API calls, instead of three things to keep in sync by
// hand. See docs/nginx/ for the reverse-proxy side of this.
const trimmedBasePath = (RAW_BASE_PATH ?? "").trim().replace(/^\/+|\/+$/g, "");
const BASE_PATH = trimmedBasePath ? `/${trimmedBasePath}` : "";

// Gets BASE_PATH to the client by injecting it as an inline global, not via
// Vite's `define`/`import.meta.env` substitution: that reliably gets baked
// in by `vite build` (confirmed in the built output), but does NOT get
// applied to files served live through vite.middlewares in dev mode with
// this programmatic middlewareMode + appType:"custom" setup (confirmed via
// isolated repro — a real Vite dev-server limitation here, not a fluke) —
// so main.js/demo.js would see the literal, undeclared identifier
// `__BASE_PATH__` and throw a ReferenceError. One mechanism, used the same
// way in both dev and prod, avoids relying on that dev-mode gap at all.
function injectBasePathScript(html) {
  return html.replace("<head>", `<head>\n    <script>window.__BASE_PATH__ = ${JSON.stringify(BASE_PATH)};</script>`);
}

const app = express();
// Off by default: trusting X-Forwarded-For with nothing actually in front of
// this process would let any direct client spoof its own IP and dodge the
// /api/session/start rate limiter below. Only set TRUST_PROXY (to the number
// of reverse-proxy hops in front of this process, usually "1") when actually
// deployed behind one — see docs/nginx/.
if (TRUST_PROXY) {
  app.set("trust proxy", Number.isNaN(Number(TRUST_PROXY)) ? TRUST_PROXY : Number(TRUST_PROXY));
}
// No CORS middleware: frontend and API are served from this same origin, so
// same-origin requests need no CORS headers at all. Leaving this absent means
// the browser blocks cross-origin fetches by default — if a specific partner
// domain ever needs to embed this widget against a different backend origin,
// add it to an explicit allowlist here rather than reflecting any Origin.
app.use(express.json());


// ---------- Abuse mitigation for /api/session/start ----------
// Request-rate limiter, keyed by IP: bounds how fast any one network can
// mint FaceMarket sessions (real cost/volume defense).
//
// There used to also be a hard "one active call at a time" lock here
// (keyed by a per-browser cookie, rejecting a second session/start with
// 409). Dropped it: a page refresh mid-call never calls /api/session/stop
// (no beforeunload handler, and the cookie survives the refresh anyway),
// so it was trivially easy for a completely normal refresh to lock a
// browser out of starting a new call for up to the lock's own TTL, with no
// way for the user to self-recover in the UI. Replaced with the simpler
// "reconnect" behavior below: starting a session for an avatar+IP that
// already has one tracked just supersedes it (stops the old one, starts
// the new one) instead of refusing the new one.
const sessionStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many session requests from this network — try again in a minute." },
});

// Mounted at `${BASE_PATH}/api` below, so every route here is written
// relative to that ("/avatars", not "/api/avatars") — the router doesn't
// need to know BASE_PATH itself, only where app.use() attaches it.
const apiRouter = express.Router();

// Lists every avatar available to this API key, so the pre-call screen can
// let the caller pick one instead of always dialing a single hardcoded avatar.
apiRouter.get("/avatars", async (req, res) => {
  try {
    const response = await fetch(`${FACEMARKET_ASSET_BASE_URL}/avatar/v2/avatars?page=1&size=100`, {
      headers: { Authorization: `Bearer ${FACEMARKET_API_KEY}` },
    });

    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    if (!response.ok) {
      console.error("FaceMarket list avatars failed:", response.status, raw);
      return res.status(502).json({ error: "Failed to list avatars", status: response.status, detail: body });
    }

    // Field names confirmed against FaceMarket's published Avatar User V2
    // API docs (avatarId/avatarName/avatarDesc/cover, "records" array,
    // wrapped in "data") and cross-checked against @sanseng/liveavatar-js-sdk's
    // own compiled bundle, which calls this exact service.
    const records = (body?.data ?? body)?.records ?? [];
    const avatars = records.map((record) => ({
      id: record.avatarId,
      name: record.avatarName,
      description: record.avatarDesc ?? "",
      cover: record.cover ?? null,
    }));

    res.json({ avatars });
  } catch (err) {
    console.error("list avatars error:", err);
    res.status(500).json({ error: "Internal error listing avatars" });
  }
});

// Single-avatar lookup, used for shareable "/avatar/{id}" deep links so the
// landing page can show just that avatar without fetching the whole list.
apiRouter.get("/avatars/:avatarId", async (req, res) => {
  try {
    const response = await fetch(
      `${FACEMARKET_ASSET_BASE_URL}/avatar/v2/avatars/${encodeURIComponent(req.params.avatarId)}`,
      { headers: { Authorization: `Bearer ${FACEMARKET_API_KEY}` } }
    );

    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    if (!response.ok) {
      console.error("FaceMarket get avatar failed:", response.status, raw);
      return res
        .status(response.status === 404 ? 404 : 502)
        .json({ error: "Failed to fetch avatar", status: response.status, detail: body });
    }

    // Field names confirmed — see the comment in GET /avatars above.
    const record = body?.data ?? body;
    const id = record?.avatarId;
    const name = record?.avatarName;
    // FaceMarket returns HTTP 200 with an empty/nameless body for an unknown
    // avatarId instead of a 404 (undocumented — not confirmed by FaceMarket's
    // published API reference, only observed), so treat "no id" as
    // not-found ourselves.
    if (!id || !name) {
      return res.status(404).json({ error: "Avatar not found" });
    }

    res.json({
      id,
      name,
      description: record.avatarDesc ?? "",
      cover: record.cover ?? null,
    });
  } catch (err) {
    console.error("get avatar error:", err);
    res.status(500).json({ error: "Internal error fetching avatar" });
  }
});

// Tracks the most recent session per (IP, avatarId) pair, so starting a
// session for an avatar+network that already has one tracked supersedes it
// (stops the old one, starts the new one) rather than being blocked by it —
// see the note above sessionStartLimiter for why this replaced a hard
// concurrency lock. The TTL here is just a bound on memory growth (so a
// session nobody ever explicitly stops doesn't sit here forever), not a
// lock — nothing rejects a request because of this map's contents.
const SESSION_TRACKING_TTL_MS = 30 * 60 * 1000;
const activeSessionByIpAndAvatar = new Map(); // "ip:avatarId" -> { sessionId, expiresAt }

function activeSessionKey(ip, avatarId) {
  return `${ip}:${avatarId}`;
}

function getTrackedSession(key) {
  const entry = activeSessionByIpAndAvatar.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    activeSessionByIpAndAvatar.delete(key);
    return null;
  }
  return entry;
}

async function stopFaceMarketSession(sessionId) {
  if (!sessionId) return;
  try {
    await fetch(`${FACEMARKET_BASE_URL}/v1/session/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FACEMARKET_API_KEY}`,
      },
      body: JSON.stringify({ sessionId }),
    });
  } catch (err) {
    console.error("session/stop error (ignored):", err);
  }
}

// TODO: before minting a session, verify the caller is allowed to use this
// avatar (check your own app's login/session). Skipped here — POC only.
apiRouter.post("/session/start", sessionStartLimiter, async (req, res) => {
  const { avatarId } = req.body ?? {};
  if (!avatarId) {
    return res.status(400).json({ error: "Missing avatarId" });
  }

  const key = activeSessionKey(req.ip, avatarId);
  const previous = getTrackedSession(key);
  if (previous) {
    // Same avatar, same network — most likely a refresh/reconnect rather
    // than a different person on a shared IP dialing the same avatar.
    // Release the old session before minting a new one.
    await stopFaceMarketSession(previous.sessionId);
    activeSessionByIpAndAvatar.delete(key);
  }

  try {
    const response = await fetch(`${FACEMARKET_BASE_URL}/v1/session/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FACEMARKET_API_KEY}`,
      },
      body: JSON.stringify({ avatarId }),
    });

    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }

    if (!response.ok) {
      console.error("FaceMarket session/start failed:", response.status, raw);
      return res.status(502).json({
        error: "Failed to start FaceMarket session",
        status: response.status,
        detail: body,
      });
    }

    // This endpoint wraps its response as { code, msg, data } (code 0 =
    // success) even on HTTP 200 — confirmed from @sanseng/liveavatar-js-sdk's
    // own compiled bundle, which calls this exact same dispatcher endpoint
    // for its "auth mode" and checks `code` the same way. A non-zero code
    // here is a business-level failure that response.ok alone wouldn't catch.
    if (typeof body?.code === "number" && body.code !== 0) {
      console.error("FaceMarket session/start returned error code:", body.code, body.msg, raw);
      return res.status(502).json({
        error: body.msg || "FaceMarket session/start returned an error",
        code: body.code,
        detail: body,
      });
    }

    // Field names confirmed via the same SDK bundle cross-check.
    const data = body?.data ?? body;
    const sessionId = data?.sessionId;
    const sfuUrl = data?.sfuUrl;
    const userToken = data?.userToken;

    if (!sfuUrl || !userToken) {
      console.error("Unexpected session/start response shape:", raw);
      return res.status(502).json({
        error: "FaceMarket response missing sfuUrl/userToken",
        detail: body,
      });
    }

    activeSessionByIpAndAvatar.set(key, { sessionId, expiresAt: Date.now() + SESSION_TRACKING_TTL_MS });
    res.json({ sessionId, sfuUrl, userToken });
  } catch (err) {
    console.error("session/start error:", err);
    res.status(500).json({ error: "Internal error starting session" });
  }
});

apiRouter.post("/session/stop", async (req, res) => {
  const { sessionId } = req.body ?? {};
  await stopFaceMarketSession(sessionId);

  // Only sessionId is known here (not avatarId), so find whichever tracked
  // entry it belongs to rather than requiring the client to resend avatarId
  // just for bookkeeping cleanup.
  for (const [key, entry] of activeSessionByIpAndAvatar) {
    if (entry.sessionId === sessionId) {
      activeSessionByIpAndAvatar.delete(key);
      break;
    }
  }

  res.json({ ok: true });
});

// Mounted at BASE_PATH itself ("" = "/") so every route above lives at
// "<BASE_PATH>/api/...". A request outside BASE_PATH (e.g. plain /api/... on
// a deployment configured with BASE_PATH=/liveavatar) simply doesn't match
// any route below and falls through to Express's normal 404 — it no longer
// silently falls into the frontend catch-all and comes back as a fake 200
// full of index.html.
app.use(`${BASE_PATH}/api`, apiRouter);

// ---------- Frontend ----------
// Same process, same port as the API above — in dev, Vite runs as Express
// middleware (HMR still works); in production it's just static files. Vite
// middleware is mounted *after* the /api routes so it never intercepts them.
// "/demo" is a separate page (web/demo.html) showing FaceMarketWidget
// embedded in a fixed-size box inside a larger page, instead of the main
// app's full-screen "/" + "/avatar/:id" experience. Both are relative to
// BASE_PATH, same as the API above.
const isDemoRequest = (req) => {
  const pathname = req.originalUrl.split("?")[0];
  const demoPath = `${BASE_PATH}/demo`;
  return pathname === demoPath || pathname.startsWith(`${demoPath}/`);
};
// Matches everything under BASE_PATH ("*" itself when BASE_PATH is "").
// Only for the production branch below — see the comment on the dev
// branch's own catch-all for why dev needs a plain "*" instead.
const catchAllPath = BASE_PATH ? `${BASE_PATH}/*` : "*";

if (isProd) {
  const distPath = path.join(__dirname, "web/dist");
  // Mounted at BASE_PATH ("/" when root-mounted) so a built asset URL like
  // "<BASE_PATH>/assets/x.js" (which is what vite.config.js's matching
  // `base` actually emits into the HTML) resolves to dist/assets/x.js —
  // express.static has no base-path awareness of its own, unlike Vite's own
  // dev middleware below, which already handles this internally.
  app.use(BASE_PATH || "/", express.static(distPath));
  app.get(catchAllPath, async (req, res) => {
    const htmlPath = path.join(distPath, isDemoRequest(req) ? "demo.html" : "index.html");
    const html = injectBasePathScript(await fs.readFile(htmlPath, "utf-8"));
    res.status(200).set({ "Content-Type": "text/html" }).send(html);
  });
} else {
  const vite = await createViteServer({
    root: path.join(__dirname, "web"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  // Mounted unprefixed on purpose: Vite's own middleware already reads
  // `base` from web/vite.config.js (the same BASE_PATH) and handles
  // "<BASE_PATH>/..." requests correctly on its own.
  app.use(vite.middlewares);
  // Deliberately registered as plain "*", NOT a BASE_PATH-prefixed pattern:
  // vite.middlewares strips BASE_PATH from req.url (while leaving
  // req.originalUrl alone) before calling next() for anything it doesn't
  // handle itself, so Express's own pattern matching below — which runs
  // against that already-stripped req.url — would never match a
  // BASE_PATH-prefixed pattern here. Scoping to BASE_PATH is instead done
  // by hand below, against the untouched req.originalUrl.
  app.use("*", async (req, res, next) => {
    const pathname = req.originalUrl.split("?")[0];
    if (BASE_PATH && pathname !== BASE_PATH && !pathname.startsWith(`${BASE_PATH}/`)) {
      return next(); // outside our mount path — fall through to a real 404
    }
    try {
      const indexHtmlPath = path.join(__dirname, isDemoRequest(req) ? "web/demo.html" : "web/index.html");
      const rawHtml = injectBasePathScript(await fs.readFile(indexHtmlPath, "utf-8"));
      const html = await vite.transformIndexHtml(req.originalUrl, rawHtml);
      res.status(200).set({ "Content-Type": "text/html" }).end(html);
    } catch (err) {
      vite.ssrFixStacktrace(err);
      next(err);
    }
  });
}

app.listen(PORT, () => {
  console.log(`facemarket-avatar-widget listening on http://localhost:${PORT} (${isProd ? "production" : "dev + Vite HMR"})`);
});
