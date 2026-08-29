import { createClient } from "@sanseng/liveavatar-js-sdk";

// ---------------------------------------------------------------------------
// FaceMarketWidget — a self-contained, embeddable FaceMarket live-avatar call
// UI. Renders into Shadow DOM so its styles never leak into (or are affected
// by) the host page. See docs/FaceMarketWidget.md for the full API reference.
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS = {
  // Initializes the widget straight onto a single avatar's dial screen
  // ("tap to call"), the same as opening a "/avatar/<id>" deep link — for
  // the common case where a host page only ever embeds one specific avatar
  // and would otherwise have to call showAvatar()/callAvatar() itself right
  // after construction. Takes priority over the current URL path and
  // autoLoadPicker. null (default) leaves startup behavior unchanged.
  avatarId: null,
  // Which control-bar / top-bar buttons to render. Every key defaults true.
  buttons: {
    mic: true,
    keyboard: true,
    captions: true,
    interrupt: true,
    disconnect: true,
    chatToggle: true,
    share: true,
  },
  // Multiplier applied to the caption pacing rate. 1 = default pace,
  // 2 = twice as fast (shorter hold per line), 0.5 = half speed.
  captionScrollSpeed: 1,
  // Whether the widget reads "/avatar/<id>" from the page URL on load, and
  // updates the URL/history/title as the user navigates within it. Defaults
  // off, since most embeds are one part of a larger page that owns its own
  // routing/title — turn this on for a widget that owns the whole page (as
  // this repo's own main.js demo does).
  manageUrl: false,
  // Whether the widget shows its own avatar-picker grid on load. Turn this
  // off if a host page drives avatar selection itself (its own UI, outside
  // the widget) and calls callAvatar() to start calls — the widget then
  // stays idle until told which avatar to call.
  autoLoadPicker: true,
  // Prefix for backend API calls (GET /api/avatars, POST /api/session/start,
  // etc). Leave "" for same-origin relative requests (the default — works
  // when the widget's page is served by the same backend in this repo).
  // Set to e.g. "https://api.example.com" if the widget is embedded on a
  // different origin than the backend.
  apiBaseUrl: "",
  // Path prefix this widget's own page is mounted under — e.g. "/liveavatar"
  // if reverse-proxied there — used only when manageUrl is true, so deep
  // links are read/written as "<basePath>/avatar/<id>" instead of assuming
  // the widget owns the domain's root at "/avatar/<id>". Independent of
  // apiBaseUrl: the page's own mount path and the backend's API location
  // aren't necessarily the same thing. "" (default) means root-mounted.
  basePath: "",
};

// Strips any trailing slash and ensures a single leading slash, so callers
// can pass "/liveavatar", "/liveavatar/", or "liveavatar" interchangeably.
function normalizeBasePath(basePath) {
  if (!basePath) return "";
  const trimmed = String(basePath).trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function mergeOptions(defaults, overrides) {
  const merged = { ...defaults, ...overrides };
  merged.buttons = { ...defaults.buttons, ...(overrides && overrides.buttons) };
  const speed = Number(merged.captionScrollSpeed);
  merged.captionScrollSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  merged.basePath = normalizeBasePath(merged.basePath);
  return merged;
}

function resolveTarget(target) {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) throw new Error(`FaceMarketWidget: target "${target}" not found`);
  return el;
}

// ---------- Link detection (chat history + captions) ----------
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;
// Trailing punctuation that's almost always sentence punctuation rather
// than part of the URL itself (e.g. "visit https://example.com." or
// "see (https://example.com)").
const URL_TRAILING_PUNCTUATION_REGEX = /[.,!?;:)\]]+$/;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Small external-link glyph, inlined right after each linkified URL (see
// linkifyText's linkSuffix) — an SVG contributes no characters to
// textContent, so it can't throw off character-offset math anywhere text
// is measured (e.g. getVisualLineTexts) or compared (e.g. showCaption's
// startsWith check against captionText.textContent).
const LINK_ICON =
  '<svg class="link-icon" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

// Returns escaped HTML with any http(s) URLs turned into clickable <a>
// tags — safe to assign directly to innerHTML, since every piece (URL and
// surrounding text alike) is escaped before being placed in the markup.
// `linkSuffix` is extra (trusted, module-level-constant) HTML appended
// inside each <a>, right after the URL text — used to inline a small link
// icon after links in captions (see showCaption); chat history leaves it
// off since the link text itself is enough there.
function linkifyText(text, { linkSuffix = "" } = {}) {
  const parts = text.split(URL_REGEX);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    // String#split with a single-capture-group regex interleaves the
    // captured matches (URLs, here) at odd indices with the surrounding
    // plain text at even indices.
    if (i % 2 === 0) {
      html += escapeHtml(parts[i]);
      continue;
    }
    let url = parts[i];
    let trailing = "";
    const trailingMatch = url.match(URL_TRAILING_PUNCTUATION_REGEX);
    if (trailingMatch) {
      trailing = trailingMatch[0];
      url = url.slice(0, -trailing.length);
    }
    const safeUrl = escapeHtml(url);
    html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}${linkSuffix}</a>${escapeHtml(trailing)}`;
  }
  return html;
}

// ---------- Icons (module-level: no instance state needed) ----------
const MIC_ON_ICON =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const MIC_OFF_ICON =
  '<svg class="icon" viewBox="0 0 24 24"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><path d="M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><path d="M19 10v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const SHARE_ICON =
  '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
const PHONE_ICON =
  '<svg class="icon" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

// ---------- Caption pacing constants (module-level, speed-scaled per instance) ----------
const ENGLISH_MS_PER_WORD = 60000 / 150; // ~150 wpm
const CJK_MS_PER_CHAR = 1000 / 5; // ~300 characters/min
const CJK_CHAR_REGEX = /[㐀-䶿一-鿿豈-﫿぀-ヿㇰ-ㇿ가-힯]/;
const CAPTION_LINE_HOLD_MIN_MS = 1000;
const CAPTION_LINE_HOLD_MAX_MS = 6000;
const CAPTION_ADVANCE_TRANSITION_S = 0.5;
// Minimum pointer movement before a press-and-hold on the caption counts as
// a manual-scroll drag rather than a tap — below this, pointerup is left
// alone so a tap on a caption link still produces a normal click.
const CAPTION_DRAG_THRESHOLD_PX = 8;

const STYLE_TEXT = `
  :host {
    display: block;
    width: 100%;
    height: 100%;
    color-scheme: dark;
    --glass-bg: rgba(255, 255, 255, 0.14);
    --glass-bg-strong: rgba(255, 255, 255, 0.24);
    --glass-border: rgba(255, 255, 255, 0.22);
    --green: #30d158;
    --red: #ff453a;
    --text: #fff;
    --text-dim: rgba(255, 255, 255, 0.72);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  button { font: inherit; color: inherit; border: none; background: none; cursor: pointer; }

  #app {
    /* Establishes a query container so descendants can size themselves off
       *this element's* box (cqw/cqh, @container) instead of the browser
       viewport — required for the widget to look right when embedded in a
       small floating window rather than filling the whole page. */
    container-type: size;
    container-name: live-avatar;
    position: relative;
    width: 100%;
    height: 100%;
    background: #000;
    color: var(--text);
    overflow: hidden;
  }

  #avatar {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: radial-gradient(circle at 50% 35%, #1c1c1e 0%, #000 70%);
  }
  #avatar video { object-fit: cover; }

  .icon { width: 22px; height: 22px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  /* ---------- Pre-call screen: avatar picker ---------- */
  .call-screen {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.6rem;
    padding: max(3.5rem, calc(env(safe-area-inset-top) + 2.5rem)) 1.5rem max(2rem, env(safe-area-inset-bottom));
    overflow-y: auto;
    background: linear-gradient(180deg, #1c1c1e 0%, #000 100%);
    transition: opacity 0.3s ease, visibility 0.3s ease;
    z-index: 20;
  }
  .picker-header { text-align: center; }
  .picker-title { font-size: 1.6rem; font-weight: 700; }
  .picker-subtitle { color: var(--text-dim); font-size: 0.95rem; margin-top: 0.4rem; min-height: 1.2em; }

  .avatar-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    justify-content: center;
    gap: 1rem;
    width: min(760px, 100%);
  }
  .avatar-card {
    position: relative;
    flex: 0 1 150px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.55rem;
    padding: 1.1rem 0.8rem;
    border-radius: 20px;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    text-align: center;
    cursor: pointer;
    transition: transform 0.15s ease, background 0.15s ease;
  }
  .avatar-card:active { transform: scale(0.96); background: var(--glass-bg-strong); }

  button.avatar-card-share {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    color: var(--text-dim);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .avatar-card-share:hover { background: rgba(255, 255, 255, 0.22); color: var(--text); }
  .avatar-card-share.copied { color: var(--green); }
  .avatar-card-share svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .avatar-card-circle {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: linear-gradient(145deg, #3a3a3c, #1c1c1e);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.7rem;
    font-weight: 600;
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--glass-border);
  }
  .avatar-card-circle img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-card-name { font-size: 0.95rem; font-weight: 600; }
  .avatar-card-desc {
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--text-dim);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: calc(1.35em * 2);
  }
  .avatar-card-call-icon {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--green);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: auto;
  }
  .avatar-card-call-icon .icon { width: 15px; height: 15px; }

  @container live-avatar (min-width: 768px) {
    .avatar-grid { width: min(920px, 100%); gap: 1.25rem; }
    .avatar-card { flex-basis: 200px; padding: 1.5rem 1.1rem; gap: 0.75rem; }
    .avatar-card-circle { width: 100px; height: 100px; font-size: 2.3rem; }
    .avatar-card-name { font-size: 1.1rem; }
    .avatar-card-desc { font-size: 0.85rem; -webkit-line-clamp: 3; min-height: calc(1.35em * 3); }
    button.avatar-card-share { width: 30px; height: 30px; }
    .avatar-card-share svg { width: 16px; height: 16px; }
    .avatar-card-call-icon { width: 36px; height: 36px; }
    .avatar-card-call-icon .icon { width: 17px; height: 17px; }
  }

  /* ---------- Single-avatar call screen (deep link / picked from grid) ---------- */
  .avatar-single {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
    width: min(360px, 100%);
    margin: auto 0;
    transform: translateY(-6cqh);
    text-align: center;
  }
  .single-share-slot {
    position: absolute;
    top: max(1.2rem, calc(env(safe-area-inset-top) + 0.8rem));
    right: 1.2rem;
    z-index: 1;
  }
  button.avatar-single-share {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    color: var(--text-dim);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .avatar-single-share:hover { background: var(--glass-bg-strong); color: var(--text); }
  .avatar-single-share.copied { color: var(--green); }
  .avatar-single-share svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .avatar-single-circle {
    width: 132px;
    height: 132px;
    border-radius: 50%;
    background: linear-gradient(145deg, #3a3a3c, #1c1c1e);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 3rem;
    font-weight: 600;
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--glass-border);
  }
  .avatar-single-circle img { width: 100%; height: 100%; object-fit: cover; }
  .avatar-single-name {
    font-size: 1.5rem;
    font-weight: 700;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Fixed to a 2-line box regardless of actual length, so switching between
     avatars with shorter/longer descriptions never shifts the call button
     (or anything else below) up or down. */
  .avatar-single-desc {
    color: var(--text-dim);
    font-size: 0.88rem;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    height: calc(1.4em * 2);
  }
  /* Fixed to a 2-line box for the same reason as .avatar-single-desc above —
     but 2 lines (not 1) since this doubles as the error-message slot (rate
     limited, upstream failure, network unreachable, etc.), which needs more
     room than the default "Tap to call X" prompt to stay readable. */
  .avatar-single-status {
    color: var(--text-dim);
    font-size: 0.85rem;
    line-height: 1.3;
    max-width: 100%;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    height: calc(1.3em * 2);
  }

  .call-accept-btn {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    background: var(--green);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 6px 20px rgba(48, 209, 88, 0.45);
    transition: transform 0.15s ease;
    margin-top: 0.4rem;
  }
  .call-accept-btn .icon { width: 30px; height: 30px; }
  .call-accept-btn:active { transform: scale(0.92); }
  .call-accept-btn.calling { animation: pulse-ring-accept 1.2s ease-in-out infinite; }
  .call-accept-btn.disabled { opacity: 0.5; pointer-events: none; box-shadow: none; }

  @keyframes pulse-ring-accept {
    0%, 100% { box-shadow: 0 6px 20px rgba(48, 209, 88, 0.45); }
    50% { box-shadow: 0 6px 20px rgba(48, 209, 88, 0.45), 0 0 0 12px rgba(48, 209, 88, 0.25); }
  }

  /* ---------- In-call overlay ---------- */
  .in-call-ui {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
    transition: opacity 0.3s ease, visibility 0.3s ease;
    padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
  }
  .in-call-ui * { pointer-events: auto; }

  .top-bar { display: flex; align-items: center; justify-content: space-between; }
  .avatar-name-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.85rem;
    border-radius: 999px;
    background: var(--glass-bg);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--glass-border);
    font-weight: 600;
    font-size: 0.95rem;
  }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #8e8e93; transition: background 0.2s ease; }
  .status-dot.connecting { background: #ffd60a; }
  .status-dot.connected { background: var(--green); }
  .status-dot.error { background: var(--red); }

  .icon-btn {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--glass-bg);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--glass-border);
  }
  .icon-btn:active { background: var(--glass-bg-strong); }
  .icon-btn.small { width: 34px; height: 34px; }

  /* ---------- Bottom area: captions + controls ---------- */
  .bottom-area { display: flex; flex-direction: column; align-items: center; gap: 0.9rem; }

  .caption-bar {
    max-width: min(640px, 90cqw);
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    padding: 0.7rem 1rem;
    border-radius: 16px;
    background: rgba(0, 0, 0, 0.75);
    transition: opacity 0.2s ease, visibility 0.2s ease;
  }
  .caption-viewport {
    overflow: hidden;
    height: calc(1.35em * 3);
    font-size: 1.05rem;
    /* Manual scroll-back is handled entirely via pointer/wheel listeners
       (see _onCaptionPointerDown etc.) — this stops the browser from also
       treating the same gesture as a native page scroll/pull-to-refresh. */
    touch-action: none;
  }
  .caption-bar #caption-text {
    font-size: 1.05rem;
    line-height: 1.35;
    text-align: center;
    transition: transform linear;
  }
  .caption-bar #caption-text a {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .caption-bar #caption-text a .link-icon {
    display: inline-block;
    width: 0.75em;
    height: 0.75em;
    margin-left: 0.15em;
    vertical-align: -0.05em;
    stroke: currentColor;
    fill: none;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .caption-close {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.18);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    line-height: 1;
  }

  .control-bar {
    display: flex;
    align-items: center;
    gap: 1.1rem;
    padding: 0.7rem 1.1rem;
    border-radius: 999px;
    background: var(--glass-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--glass-border);
  }
  .control-btn {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.16);
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .control-btn:active { transform: scale(0.94); }
  .control-btn.active { background: var(--text); color: #000; }
  .control-btn--end { background: var(--red); }
  .control-btn--end .icon { transform: rotate(135deg); }

  @container live-avatar (max-width: 480px) {
    .control-bar { gap: 0.5rem; padding: 0.55rem 0.7rem; }
    .control-btn { width: 44px; height: 44px; }
    .control-btn .icon { width: 20px; height: 20px; }
  }
  @container live-avatar (max-width: 360px) {
    .control-bar { gap: 0.35rem; padding: 0.45rem 0.55rem; }
    .control-btn { width: 38px; height: 38px; }
    .control-btn .icon { width: 18px; height: 18px; }
  }

  .text-input-bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: min(560px, 92cqw);
    padding: 0.5rem 0.6rem;
    border-radius: 999px;
    background: var(--glass-bg);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--glass-border);
  }
  .text-input-bar input {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font-size: 1rem;
    padding: 0.5rem 0.3rem;
  }
  .text-input-bar input::placeholder { color: var(--text-dim); }
  .send-btn { background: var(--green); color: #000; }
  .send-btn:disabled { background: rgba(255, 255, 255, 0.16); color: var(--text-dim); pointer-events: none; }

  .control-row { display: grid; justify-items: center; }
  .control-row > * { grid-area: 1 / 1; }

  /* ---------- Chat history drawer ---------- */
  .chat-panel {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(380px, 88cqw);
    z-index: 30;
    display: flex;
    flex-direction: column;
    background: rgba(20, 20, 22, 0.78);
    backdrop-filter: blur(26px) saturate(180%);
    -webkit-backdrop-filter: blur(26px) saturate(180%);
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: -12px 0 40px rgba(0, 0, 0, 0.4);
    transform: translateX(100%);
    transition: transform 0.32s cubic-bezier(0.32, 0.72, 0, 1);
    padding: max(1rem, env(safe-area-inset-top)) 0 max(1rem, env(safe-area-inset-bottom));
  }
  .chat-panel.open { transform: translateX(0); }

  .chat-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 1.1rem 0.9rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .chat-panel-header h3 { margin: 0; font-size: 1.05rem; font-weight: 700; }

  .chat-log {
    flex: 1;
    overflow-y: auto;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .chat-msg {
    max-width: 88%;
    padding: 0.55rem 0.8rem;
    border-radius: 16px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.92rem;
    line-height: 1.4;
  }
  .chat-msg.user { align-self: flex-end; background: linear-gradient(145deg, #0a84ff, #0066cc); border-bottom-right-radius: 4px; }
  .chat-msg.bot { align-self: flex-start; background: rgba(255, 255, 255, 0.12); border-bottom-left-radius: 4px; }
  .chat-msg .role { display: block; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.02em; opacity: 0.65; margin-bottom: 0.2rem; text-transform: uppercase; }
  .chat-msg a { color: inherit; text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .chat-msg a:hover { opacity: 0.85; }

  .hidden { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }

  /* ---------- Session-ended modal ---------- */
  .modal-overlay {
    position: absolute;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.55);
    transition: opacity 0.2s ease, visibility 0.2s ease;
  }
  .modal-card {
    width: min(320px, 100%);
    padding: 1.6rem 1.4rem;
    border-radius: 22px;
    background: rgba(28, 28, 30, 0.92);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--glass-border);
    text-align: center;
  }
  .modal-title { font-size: 1.15rem; font-weight: 700; margin-bottom: 0.5rem; }
  .modal-message { color: var(--text-dim); font-size: 0.9rem; line-height: 1.4; margin-bottom: 1.3rem; }
  .modal-actions { display: flex; gap: 0.7rem; }
  .modal-btn { flex: 1; padding: 0.65rem 0; border-radius: 12px; font-weight: 600; font-size: 0.9rem; }
  .modal-btn:active { transform: scale(0.97); }
  .modal-btn-secondary { background: var(--glass-bg); border: 1px solid var(--glass-border); color: var(--text); }
  .modal-btn-primary { background: var(--green); color: #fff; }

  /* ---------- Hover tooltips ---------- */
  [data-tooltip] { position: relative; }
  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 10px);
    left: 50%;
    transform: translateX(-50%) translateY(4px);
    background: rgba(28, 28, 30, 0.95);
    color: #fff;
    padding: 0.35rem 0.65rem;
    border-radius: 8px;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    z-index: 50;
  }
  [data-tooltip].tooltip-bottom::after {
    bottom: auto;
    top: calc(100% + 10px);
    transform: translateX(-50%) translateY(-4px);
  }
  [data-tooltip]:hover::after,
  [data-tooltip]:focus-visible::after {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  @media (hover: none) {
    [data-tooltip]::after { display: none; }
  }
`;

export class FaceMarketWidget {
  constructor(target, options = {}) {
    this.options = mergeOptions(DEFAULT_OPTIONS, options);
    this.hostEl = resolveTarget(target);

    // ---- call/session state ----
    this.client = null;
    this.currentSessionId = null;
    this.isIntentionalDisconnect = false;
    this.avatarDisplayName = "Avatar";
    this.answerByQuestion = new Map();
    this.botBubbleByQuestion = new Map();
    this.handledQuestionIds = new Set();

    // ---- caption state ----
    this.captionsEnabled = true;
    this.captionLines = [];
    this.captionCurrentLine = 0;
    this.captionAdvanceTimer = null;
    // True once the user has manually scrolled the caption away from the
    // live tail (see _onCaptionPointerUp/_onCaptionWheel) — while true,
    // scheduleCaptionAdvance leaves their position alone even as more text
    // streams in, until they scroll back to the tail themselves or a new
    // turn starts (see showCaption's fresh-turn branch).
    this.captionReviewing = false;
    // Transient state for an in-progress manual-scroll gesture, or null
    // between gestures — see _onCaptionPointerDown.
    this.captionDragState = null;

    this._buildDom();
    this._queryElements();
    this._bindStaticListeners();

    if (this.options.manageUrl) {
      window.addEventListener("popstate", this._onPopState);
    }
    if (this.options.avatarId) {
      this._navigateToAvatarPath(this.options.avatarId);
      this.loadSingleAvatar(this.options.avatarId);
    } else if (this.options.autoLoadPicker) {
      this._renderForCurrentPath();
    } else {
      this.pickerStatus.textContent = "";
    }
  }

  // Shows the single-avatar dial screen for a specific avatar — the same
  // "tap to call" state as landing on a deep link — without connecting.
  // Driven from outside the widget, e.g. a host page with its own
  // avatar-selection UI. Accepts either an avatarId (fetched via
  // GET /api/avatars/:id) or an already-loaded avatar object.
  showAvatar = async (avatarOrId) => {
    const avatar = typeof avatarOrId === "string" ? await this._fetchAvatar(avatarOrId) : avatarOrId;
    this._navigateToAvatarPath(avatar.id);
    this.showSingleAvatarScreen(avatar);
  };

  // Starts (or switches to) a call with a specific avatar immediately, from
  // outside the widget — e.g. a host page rendering its own avatar-selection
  // UI instead of relying on the widget's built-in picker grid. Accepts
  // either an avatarId (fetched via GET /api/avatars/:id) or an
  // already-loaded avatar object ({ id, name, description, cover }), so
  // callers who already have the avatar list (from GET /api/avatars) can
  // skip the extra fetch. Use showAvatar() instead if you want to land on
  // the dial screen first and let the user tap to connect.
  callAvatar = async (avatarOrId) => {
    const avatar = typeof avatarOrId === "string" ? await this._fetchAvatar(avatarOrId) : avatarOrId;
    this.selectAvatar(avatar);
  };

  _fetchAvatar = async (avatarId) => {
    const response = await fetch(this._api(`/api/avatars/${encodeURIComponent(avatarId)}`));
    if (!response.ok) {
      throw new Error(`FaceMarketWidget: failed to load avatar "${avatarId}" (HTTP ${response.status})`);
    }
    return response.json();
  };

  // Tears down the call (if any) and removes the widget's DOM from its
  // container. The instance shouldn't be reused after calling this.
  destroy() {
    if (this.options.manageUrl) {
      window.removeEventListener("popstate", this._onPopState);
    }
    this.hangUp().catch(() => {});
    this.hostEl.innerHTML = "";
  }

  // ---------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------

  _buildDom() {
    this.hostEl.innerHTML = "";
    const shadowHost = document.createElement("div");
    shadowHost.style.width = "100%";
    shadowHost.style.height = "100%";
    this.hostEl.appendChild(shadowHost);
    this.root = shadowHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    this.root.appendChild(style);

    const wrapper = document.createElement("div");
    wrapper.innerHTML = this._template();
    this.root.appendChild(wrapper.firstElementChild);
  }

  _template() {
    const b = this.options.buttons;
    return `
    <div id="app">
      <div id="avatar"></div>

      <div id="call-screen" class="call-screen">
        <div class="picker-header" id="picker-header">
          <div class="picker-title" id="picker-title">Live Avatar</div>
          <div class="picker-subtitle" id="picker-status">Loading avatars…</div>
        </div>
        <div id="avatar-grid" class="avatar-grid"></div>
        <div id="avatar-single" class="avatar-single hidden"></div>
        <div id="single-share-slot" class="single-share-slot hidden"></div>
      </div>

      <div id="in-call-ui" class="in-call-ui hidden">
        <div class="top-bar">
          <div class="avatar-name-badge">
            <span class="status-dot" id="status-dot"></span>
            <span id="avatar-name-label"></span>
          </div>
          ${
            b.chatToggle
              ? `<button id="chat-toggle" class="icon-btn tooltip-bottom" aria-label="Toggle chat history" data-tooltip="Chat History">
            <svg class="icon" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          </button>`
              : ""
          }
        </div>

        <div class="bottom-area">
          ${
            b.captions
              ? `<div id="caption-bar" class="caption-bar hidden">
            <div class="caption-viewport">
              <div id="caption-text"></div>
            </div>
            <button id="caption-close" class="caption-close" aria-label="Close captions" data-tooltip="Close Captions">&times;</button>
          </div>`
              : ""
          }

          <div class="control-row">
            ${
              b.keyboard
                ? `<div id="text-input-bar" class="text-input-bar hidden">
              <button id="back-to-mic" class="icon-btn small" aria-label="Back to voice" data-tooltip="Switch to Voice">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </button>
              <input id="question" placeholder="Message..." autocomplete="off" />
              <button id="send" class="icon-btn small send-btn" aria-label="Send" data-tooltip="Send" disabled>
                <svg class="icon" viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            </div>`
                : ""
            }

            <div class="control-bar" id="control-bar">
              ${
                b.mic
                  ? `<button id="mic" class="control-btn active" aria-label="Mute microphone" data-tooltip="Mute Microphone">
                <svg class="icon" viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </button>`
                  : ""
              }
              ${
                b.keyboard
                  ? `<button id="keyboard-toggle" class="control-btn" aria-label="Switch to text input" data-tooltip="Type a Message">
                <svg class="icon" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="18" y2="14"/></svg>
              </button>`
                  : ""
              }
              ${
                b.captions
                  ? `<button id="captions-toggle" class="control-btn active" aria-label="Hide captions" data-tooltip="Hide Captions">
                <svg class="icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="10" x2="10" y2="10"/><line x1="6" y1="14" x2="12" y2="14"/><line x1="14" y1="10" x2="18" y2="10"/></svg>
              </button>`
                  : ""
              }
              ${
                b.interrupt
                  ? `<button id="interrupt" class="control-btn" aria-label="Interrupt" data-tooltip="Interrupt">
                <svg class="icon" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>
              </button>`
                  : ""
              }
              ${
                b.disconnect
                  ? `<button id="disconnect" class="control-btn control-btn--end" aria-label="End call" data-tooltip="End Call">
                <svg class="icon" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
              </button>`
                  : ""
              }
            </div>
          </div>
        </div>
      </div>

      ${
        b.chatToggle
          ? `<aside id="chat-panel" class="chat-panel">
        <div class="chat-panel-header">
          <h3>Chat History</h3>
          <button id="chat-panel-close" class="icon-btn small tooltip-bottom" aria-label="Close chat history" data-tooltip="Close">&times;</button>
        </div>
        <div id="chat-log" class="chat-log"></div>
      </aside>`
          : ""
      }

      <div id="session-ended-modal" class="modal-overlay hidden">
        <div class="modal-card">
          <div class="modal-title">Session Ended</div>
          <div class="modal-message" id="session-ended-message">The call ended unexpectedly.</div>
          <div class="modal-actions">
            <button id="session-ended-close" class="modal-btn modal-btn-secondary" type="button">Close</button>
            <button id="session-ended-reconnect" class="modal-btn modal-btn-primary" type="button">Reconnect</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  _queryElements() {
    const $ = (id) => this.root.getElementById(id);

    this.container = $("avatar");
    this.callScreen = $("call-screen");
    this.pickerHeader = $("picker-header");
    this.pickerTitle = $("picker-title");
    this.pickerStatus = $("picker-status");
    this.avatarGrid = $("avatar-grid");
    this.avatarSingle = $("avatar-single");
    this.singleShareSlot = $("single-share-slot");

    this.inCallUi = $("in-call-ui");
    this.statusDot = $("status-dot");
    this.avatarNameLabel = $("avatar-name-label");

    this.captionBar = $("caption-bar");
    this.captionViewport = this.root.querySelector(".caption-viewport");
    this.captionText = $("caption-text");
    this.captionCloseButton = $("caption-close");
    this.captionsToggleButton = $("captions-toggle");

    this.controlBar = $("control-bar");
    this.micButton = $("mic");
    this.keyboardToggleButton = $("keyboard-toggle");
    this.interruptButton = $("interrupt");
    this.disconnectButton = $("disconnect");

    this.textInputBar = $("text-input-bar");
    this.backToMicButton = $("back-to-mic");
    this.questionInput = $("question");
    this.sendButton = $("send");

    this.chatToggleButton = $("chat-toggle");
    this.chatPanel = $("chat-panel");
    this.chatPanelCloseButton = $("chat-panel-close");
    this.chatLogEl = $("chat-log");

    this.sessionEndedModal = $("session-ended-modal");
    this.sessionEndedMessage = $("session-ended-message");
    this.sessionEndedCloseButton = $("session-ended-close");
    this.sessionEndedReconnectButton = $("session-ended-reconnect");
  }

  _bindStaticListeners() {
    this.micButton?.addEventListener("click", this._onMicClick);
    this.questionInput?.addEventListener("input", this._updateSendButtonState);
    this._updateSendButtonState();
    this.keyboardToggleButton?.addEventListener("click", this.enterTextMode);
    this.backToMicButton?.addEventListener("click", this._onBackToMicClick);
    this.sendButton?.addEventListener("click", this.sendQuestion);
    this.questionInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.sendQuestion();
    });
    this.interruptButton?.addEventListener("click", () => this.client?.interrupt());
    this.disconnectButton?.addEventListener("click", this.hangUp);

    this.chatToggleButton?.addEventListener("click", () =>
      this.setChatPanelOpen(!this.chatPanel.classList.contains("open"))
    );
    this.chatPanelCloseButton?.addEventListener("click", () => this.setChatPanelOpen(false));

    this.captionCloseButton?.addEventListener("click", () => this.setCaptionsEnabled(false));
    this.captionsToggleButton?.addEventListener("click", () => this.setCaptionsEnabled(!this.captionsEnabled));

    this.captionViewport?.addEventListener("pointerdown", this._onCaptionPointerDown);
    this.captionViewport?.addEventListener("pointermove", this._onCaptionPointerMove);
    this.captionViewport?.addEventListener("pointerup", this._onCaptionPointerUp);
    this.captionViewport?.addEventListener("pointercancel", this._onCaptionPointerUp);
    this.captionViewport?.addEventListener("wheel", this._onCaptionWheel, { passive: false });

    this.sessionEndedCloseButton?.addEventListener("click", () => {
      this.sessionEndedModal.classList.add("hidden");
    });
  }

  // ---------------------------------------------------------------------
  // API base helper
  // ---------------------------------------------------------------------

  _api(path) {
    return `${this.options.apiBaseUrl}${path}`;
  }

  // ---------------------------------------------------------------------
  // Avatar picker (pre-call screen)
  // ---------------------------------------------------------------------

  avatarShareUrl = (avatarId) =>
    `${window.location.origin}${this.options.basePath}/avatar/${encodeURIComponent(avatarId)}`;

  copyAvatarLink = async (avatar, buttonEl) => {
    try {
      await navigator.clipboard.writeText(this.avatarShareUrl(avatar.id));
    } catch (error) {
      console.error("Failed to copy avatar link", error);
      return;
    }
    buttonEl.innerHTML = CHECK_ICON;
    buttonEl.classList.add("copied");
    setTimeout(() => {
      buttonEl.innerHTML = SHARE_ICON;
      buttonEl.classList.remove("copied");
    }, 1400);
  };

  loadAvatars = async () => {
    this.pickerHeader.classList.remove("hidden");
    this.avatarGrid.classList.remove("hidden");
    this.avatarSingle.classList.add("hidden");
    this.avatarSingle.innerHTML = "";
    this.singleShareSlot.classList.add("hidden");
    this.singleShareSlot.innerHTML = "";
    try {
      const response = await fetch(this._api("/api/avatars"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { avatars } = await response.json();
      if (!avatars || avatars.length === 0) {
        this.pickerStatus.textContent = "No avatars available for this account.";
        return;
      }
      this.pickerTitle.textContent = "Live Avatar";
      this.pickerStatus.textContent = "Choose an avatar to start a video call";
      this.renderAvatarGrid(avatars);
    } catch (error) {
      console.error("Failed to load avatars", error);
      this.pickerStatus.textContent = "Couldn't load avatars — check the server and reload.";
    }
  };

  loadSingleAvatar = async (avatarId) => {
    try {
      const response = await fetch(this._api(`/api/avatars/${encodeURIComponent(avatarId)}`));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const avatar = await response.json();
      this.showSingleAvatarScreen(avatar);
    } catch (error) {
      console.error("Failed to load avatar from link", error);
      this.pickerStatus.textContent = "This avatar link isn't valid — showing all avatars instead.";
      await this.loadAvatars();
    }
  };

  showSingleAvatarScreen = (avatar) => {
    if (this.options.manageUrl) document.title = `${avatar.name} — Live Avatar`;
    this.pickerHeader.classList.add("hidden");
    this.avatarGrid.classList.add("hidden");
    this.avatarGrid.innerHTML = "";
    this.avatarSingle.classList.remove("hidden");
    this.singleShareSlot.classList.remove("hidden");
    return this.renderSingleAvatarCallScreen(avatar);
  };

  renderSingleAvatarCallScreen = (avatar) => {
    this.avatarSingle.innerHTML = "";
    this.singleShareSlot.innerHTML = "";

    if (this.options.buttons.share) {
      const shareBtn = document.createElement("button");
      shareBtn.type = "button";
      shareBtn.className = "avatar-single-share";
      shareBtn.setAttribute("aria-label", `Copy link to ${avatar.name}`);
      shareBtn.dataset.tooltip = "Copy Link";
      shareBtn.innerHTML = SHARE_ICON;
      shareBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.copyAvatarLink(avatar, shareBtn);
      });
      this.singleShareSlot.appendChild(shareBtn);
    }

    const circle = document.createElement("div");
    circle.className = "avatar-single-circle";
    if (avatar.cover) {
      const img = document.createElement("img");
      img.src = avatar.cover;
      img.alt = "";
      circle.appendChild(img);
    } else {
      circle.textContent = (avatar.name || "?").trim().charAt(0).toUpperCase();
    }

    const name = document.createElement("div");
    name.className = "avatar-single-name";
    name.textContent = avatar.name;

    const desc = document.createElement("div");
    desc.className = "avatar-single-desc";
    desc.textContent = avatar.description;

    const statusEl = document.createElement("div");
    statusEl.className = "avatar-single-status";
    statusEl.textContent = `Tap to call ${avatar.name}`;

    const callBtn = document.createElement("button");
    callBtn.type = "button";
    callBtn.className = "call-accept-btn";
    callBtn.setAttribute("aria-label", `Call ${avatar.name}`);
    callBtn.dataset.tooltip = "Start Call";
    callBtn.innerHTML = PHONE_ICON;
    const startCall = () => this.connectToAvatar(avatar, callBtn, statusEl);
    callBtn.addEventListener("click", startCall);

    this.avatarSingle.append(circle, name, desc, statusEl, callBtn);
    return { callBtn, statusEl, startCall };
  };

  _navigateToAvatarPath = (avatarId) => {
    if (!this.options.manageUrl) return;
    const path = `${this.options.basePath}/avatar/${encodeURIComponent(avatarId)}`;
    if (window.location.pathname !== path) {
      history.pushState({ avatarId }, "", path);
    }
  };

  selectAvatar = (avatar) => {
    this._navigateToAvatarPath(avatar.id);
    const { startCall } = this.showSingleAvatarScreen(avatar);
    startCall();
  };

  renderAvatarGrid = (avatars) => {
    this.avatarGrid.innerHTML = "";
    for (const avatar of avatars) {
      const card = document.createElement("div");
      card.className = "avatar-card";
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.setAttribute("aria-label", `Call ${avatar.name}`);

      if (this.options.buttons.share) {
        const shareBtn = document.createElement("button");
        shareBtn.type = "button";
        shareBtn.className = "avatar-card-share";
        shareBtn.setAttribute("aria-label", `Copy link to ${avatar.name}`);
        shareBtn.dataset.tooltip = "Copy Link";
        shareBtn.innerHTML = SHARE_ICON;
        shareBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          this.copyAvatarLink(avatar, shareBtn);
        });
        card.appendChild(shareBtn);
      }

      const circle = document.createElement("div");
      circle.className = "avatar-card-circle";
      if (avatar.cover) {
        const img = document.createElement("img");
        img.src = avatar.cover;
        img.alt = "";
        circle.appendChild(img);
      } else {
        circle.textContent = (avatar.name || "?").trim().charAt(0).toUpperCase();
      }

      const name = document.createElement("div");
      name.className = "avatar-card-name";
      name.textContent = avatar.name;

      const desc = document.createElement("div");
      desc.className = "avatar-card-desc";
      desc.textContent = avatar.description;

      const callIcon = document.createElement("div");
      callIcon.className = "avatar-card-call-icon";
      callIcon.innerHTML = PHONE_ICON;

      card.append(circle, name, desc, callIcon);
      card.addEventListener("click", () => this.selectAvatar(avatar));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectAvatar(avatar);
        }
      });
      this.avatarGrid.appendChild(card);
    }
  };

  resetCallScreenState = () => {
    this.avatarSingle.querySelectorAll(".call-accept-btn").forEach((el) => {
      el.classList.remove("disabled", "calling");
    });
    const statusEl = this.avatarSingle.querySelector(".avatar-single-status");
    if (statusEl) statusEl.textContent = `Tap to call ${this.avatarDisplayName}`;
  };

  avatarIdFromPath = () => {
    const { pathname } = window.location;
    const prefix = this.options.basePath;
    if (prefix && !pathname.startsWith(prefix)) return null;
    const rest = prefix ? pathname.slice(prefix.length) : pathname;
    const match = rest.match(/^\/avatar\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  };

  _renderForCurrentPath = () => {
    const avatarId = this.options.manageUrl ? this.avatarIdFromPath() : null;
    if (avatarId) {
      this.loadSingleAvatar(avatarId);
    } else {
      this.pickerTitle.textContent = "Live Avatar";
      if (this.options.manageUrl) document.title = "Live Avatar";
      this.loadAvatars();
    }
  };

  _onPopState = async () => {
    if (this.client) await this.hangUp();
    this._renderForCurrentPath();
  };

  // ---------------------------------------------------------------------
  // Chat history drawer
  // ---------------------------------------------------------------------

  setChatPanelOpen = (open) => {
    this.chatPanel?.classList.toggle("open", open);
  };

  resetChatHistory = () => {
    if (!this.chatLogEl) return;
    this.chatLogEl.innerHTML = "";
    this.botBubbleByQuestion.clear();
    this.handledQuestionIds.clear();
  };

  handleUserTurn = (questionId, text) => {
    if (!this.chatLogEl || this.handledQuestionIds.has(questionId)) return;
    this.handledQuestionIds.add(questionId);
    this.appendChatMessage("user", text);
    this.botBubbleByQuestion.set(questionId, this.appendChatMessage("bot", ""));
  };

  appendChatMessage = (role, text) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-msg ${role}`;
    const roleLabel = document.createElement("span");
    roleLabel.className = "role";
    roleLabel.textContent = role === "user" ? "You" : this.avatarDisplayName;
    const body = document.createElement("span");
    body.innerHTML = linkifyText(text);
    bubble.append(roleLabel, body);
    this.chatLogEl.appendChild(bubble);
    this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    return { bubble, body };
  };

  // ---------------------------------------------------------------------
  // Live captions
  // ---------------------------------------------------------------------

  refreshCaptionVisibility = () => {
    if (!this.captionBar) return;
    const hasContent = this.captionText.textContent.trim().length > 0;
    this.captionBar.classList.toggle("hidden", !this.captionsEnabled || !hasContent);
  };

  estimateLineHoldMs = (lineText) => {
    if (!lineText) return CAPTION_LINE_HOLD_MIN_MS;
    let cjkCount = 0;
    let latinText = "";
    for (const ch of lineText) {
      if (CJK_CHAR_REGEX.test(ch)) cjkCount++;
      else latinText += ch;
    }
    const words = latinText.trim().split(/\s+/).filter(Boolean).length;
    const ms =
      (cjkCount * CJK_MS_PER_CHAR + words * ENGLISH_MS_PER_WORD - 4 * CJK_MS_PER_CHAR + 1 * ENGLISH_MS_PER_WORD) /
      this.options.captionScrollSpeed;
    return Math.min(CAPTION_LINE_HOLD_MAX_MS, Math.max(CAPTION_LINE_HOLD_MIN_MS, ms));
  };

  // Splits textContent into strings matching each actual rendered line, by
  // walking character-by-character and watching for the point where a
  // single-character Range's vertical position jumps to the next line.
  // Walks every text node under `element` (via TreeWalker), not just its
  // first child — so inline elements mixed into the caption (e.g. a link's
  // <a> plus its trailing icon, see showCaption) don't break character-by-
  // character measurement. A global index tracks each character's position
  // in element.textContent (which concatenates all text nodes in the same
  // document order the walker visits them in), so line-slicing stays
  // correct across node boundaries. Non-text content (the icon SVG itself)
  // contributes no characters here, but its rendered width still shows up
  // in the *real* rects we measure — wrapping stays accurate to what's
  // actually on screen either way.
  getVisualLineTexts = (element) => {
    const text = element.textContent;
    if (!text) return [];

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const lines = [];
    let lineStart = 0;
    let lineTop = null;
    let globalIndex = 0;
    let textNode;

    while ((textNode = walker.nextNode())) {
      for (let i = 0; i < textNode.data.length; i++) {
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const rect = range.getClientRects()[0];
        if (rect) {
          if (lineTop === null) lineTop = rect.top;
          else if (Math.abs(rect.top - lineTop) > 1) {
            lines.push(text.slice(lineStart, globalIndex));
            lineStart = globalIndex;
            lineTop = rect.top;
          }
        }
        globalIndex++;
      }
    }
    lines.push(text.slice(lineStart));
    return lines;
  };

  _captionLineHeight = () => {
    return parseFloat(getComputedStyle(this.captionViewport).height) / 3 || this.captionText.clientHeight || 24;
  };

  // Highest valid captionCurrentLine — the position where the last 3 lines
  // are showing and there's nothing further to scroll to in either
  // direction beyond it.
  captionMaxLine = () => Math.max(0, this.captionLines.length - 3);

  // True once auto-advance has nothing left to do: no timer pending, and
  // already showing the tail. Manual scroll-back only ever starts from
  // this state (see _onCaptionPointerDown/_onCaptionWheel) — that way it
  // never has to interrupt an in-flight advance transition.
  captionIsAtRest = () => !this.captionAdvanceTimer && this.captionCurrentLine >= this.captionMaxLine();

  applyCaptionLinePosition = () => {
    const lineHeight = this._captionLineHeight();
    this.captionText.style.transitionDuration = `${CAPTION_ADVANCE_TRANSITION_S}s`;
    this.captionText.style.transform = `translateY(${-(this.captionCurrentLine * lineHeight)}px)`;
  };

  scheduleCaptionAdvance = () => {
    // Leave the user's manually-scrolled-back position alone even as more
    // text streams in — they return to live by scrolling back themselves
    // (see _onCaptionPointerUp/_onCaptionWheel), not by having it yanked
    // out from under them.
    if (this.captionReviewing) return;
    if (this.captionAdvanceTimer) return;
    if (this.captionLines.length <= this.captionCurrentLine + 3) return;
    const holdMs = this.estimateLineHoldMs(this.captionLines[this.captionCurrentLine]);
    this.captionAdvanceTimer = setTimeout(() => {
      this.captionAdvanceTimer = null;
      this.captionCurrentLine += 1;
      this.applyCaptionLinePosition();
      this.scheduleCaptionAdvance();
    }, holdMs);
  };

  // ---- Manual scroll-back (caption review) ----
  // Only ever engages from captionIsAtRest() — see that getter's comment.
  // Pointer Events cover mouse + touch + pen in one set of handlers.

  _onCaptionPointerDown = (event) => {
    // Allowed once already at rest, OR already mid-review (so touch users,
    // who have no wheel to fall back on, can keep dragging further back —
    // or back down to live — rather than getting only one drag ever).
    if (!event.isPrimary || this.captionLines.length === 0) return;
    if (!this.captionIsAtRest() && !this.captionReviewing) return;
    this.captionDragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startLine: this.captionCurrentLine,
      dragging: false,
      lineHeight: this._captionLineHeight(),
    };
  };

  _onCaptionPointerMove = (event) => {
    const drag = this.captionDragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(deltaY) < CAPTION_DRAG_THRESHOLD_PX) return; // could still just be a tap
      drag.dragging = true;
      this.captionViewport.setPointerCapture(drag.pointerId);
      this.captionText.style.transitionDuration = "0s"; // track the pointer 1:1, no easing lag
    }
    event.preventDefault();
    // Dragging down reveals earlier lines (lower index) — same sense as
    // pulling a list down to see what's above.
    const rawLine = drag.startLine - deltaY / drag.lineHeight;
    const clampedLine = Math.min(this.captionMaxLine(), Math.max(0, rawLine));
    this.captionText.style.transform = `translateY(${-(clampedLine * drag.lineHeight)}px)`;
  };

  _onCaptionPointerUp = (event) => {
    const drag = this.captionDragState;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.captionDragState = null;
    if (!drag.dragging) return; // a tap — let the normal click (e.g. a link) fire on its own
    this.captionViewport.releasePointerCapture(drag.pointerId);
    const deltaY = event.clientY - drag.startY;
    const maxLine = this.captionMaxLine();
    const rawLine = drag.startLine - deltaY / drag.lineHeight;
    this.captionCurrentLine = Math.round(Math.min(maxLine, Math.max(0, rawLine)));
    this._settleCaptionReview(maxLine);
  };

  _onCaptionWheel = (event) => {
    if (this.captionLines.length === 0) return;
    if (!this.captionIsAtRest() && !this.captionReviewing) return;
    event.preventDefault();
    if (this.captionAdvanceTimer) {
      clearTimeout(this.captionAdvanceTimer);
      this.captionAdvanceTimer = null;
    }
    const maxLine = this.captionMaxLine();
    const direction = event.deltaY > 0 ? 1 : -1; // wheel down -> later lines, wheel up -> earlier
    this.captionCurrentLine = Math.min(maxLine, Math.max(0, this.captionCurrentLine + direction));
    this._settleCaptionReview(maxLine);
  };

  // Shared tail end of a manual-scroll gesture: apply the snapped position,
  // and either mark this as "reviewing" (paused) or resume auto-advance,
  // depending on whether the user landed back on the live tail.
  _settleCaptionReview = (maxLine) => {
    this.captionReviewing = this.captionCurrentLine < maxLine;
    this.applyCaptionLinePosition();
    if (!this.captionReviewing) this.scheduleCaptionAdvance();
  };

  showCaption = (text) => {
    if (!this.captionText || !this.captionsEnabled) return;
    const nextText = text || "";
    if (!nextText.startsWith(this.captionText.textContent)) {
      this.captionCurrentLine = 0;
      this.captionReviewing = false;
      if (this.captionAdvanceTimer) {
        clearTimeout(this.captionAdvanceTimer);
        this.captionAdvanceTimer = null;
      }
      this.applyCaptionLinePosition();
    }
    // innerHTML (not textContent): linkifyText turns any http(s) URL into a
    // real <a> with a trailing icon (see LINK_ICON) — getVisualLineTexts
    // walks every text node under the element, so this mix of text + <a>
    // nodes still measures real rendered line breaks correctly (icon width
    // included), and the .startsWith() check above compares against
    // textContent, which strips the tags back out to plain text again.
    this.captionText.innerHTML = linkifyText(nextText, { linkSuffix: LINK_ICON });
    this.captionLines = this.getVisualLineTexts(this.captionText);
    this.scheduleCaptionAdvance();
    this.refreshCaptionVisibility();
  };

  setCaptionsEnabled = (enabled) => {
    this.captionsEnabled = enabled;
    this.captionsToggleButton?.classList.toggle("active", enabled);
    this.captionsToggleButton?.setAttribute("aria-label", enabled ? "Hide captions" : "Show captions");
    this.captionsToggleButton?.setAttribute("data-tooltip", enabled ? "Hide Captions" : "Show Captions");
    this.refreshCaptionVisibility();
  };

  // ---------------------------------------------------------------------
  // Mic
  // ---------------------------------------------------------------------

  setMicActive = (active) => {
    if (!this.micButton) return;
    this.micButton.classList.toggle("active", active);
    this.micButton.innerHTML = active ? MIC_ON_ICON : MIC_OFF_ICON;
    const label = active ? "Mute microphone" : "Unmute microphone";
    this.micButton.setAttribute("aria-label", label);
    this.micButton.setAttribute("data-tooltip", active ? "Mute Microphone" : "Unmute Microphone");
  };

  // Attempts to start the mic and reflects the *real* outcome in the UI.
  tryStartMic = async () => {
    try {
      // The SDK's public "sdk:connected" (all:true) event can fire a beat
      // before its internal state machine flips to "connected" in Direct
      // mode, so startAudioCapture() throws SDK_NOT_CONNECTED right after
      // connecting even though the call is genuinely live. Give it a brief
      // window to catch up before treating it as a real failure.
      const deadline = Date.now() + 3000;
      while (!this.client.isConnected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await this.client.startAudioCapture();
      this.setMicActive(true);
      return true;
    } catch (error) {
      console.error("Microphone start failed", error);
      this.setMicActive(false);
      this.setCaptionsEnabled(true);
      this.showCaption(
        "Couldn't access the microphone — check this site's mic permission in your browser, then tap the mic button to retry."
      );
      return false;
    }
  };

  _onMicClick = async () => {
    if (!this.client) return;
    if (this.client.isAudioCapturing) {
      await this.client.stopAudioCapture();
      this.setMicActive(false);
    } else {
      await this.tryStartMic();
    }
  };

  _updateSendButtonState = () => {
    if (!this.sendButton || !this.questionInput) return;
    this.sendButton.disabled = this.questionInput.value.trim().length === 0;
  };

  enterTextMode = () => {
    this.controlBar?.classList.add("hidden");
    this.textInputBar?.classList.remove("hidden");
    this.questionInput?.focus();
    if (this.client?.isAudioCapturing) this.client.stopAudioCapture().catch(() => {});
  };

  exitTextMode = () => {
    this.textInputBar?.classList.add("hidden");
    this.controlBar?.classList.remove("hidden");
    if (this.questionInput) this.questionInput.value = "";
    this._updateSendButtonState();
  };

  _onBackToMicClick = async () => {
    this.exitTextMode();
    if (this.client?.isConnected) await this.tryStartMic();
  };

  sendQuestion = async () => {
    if (!this.questionInput) return;
    const text = this.questionInput.value.trim();
    if (!this.client?.isConnected || !text) return;
    this.questionInput.value = "";
    this._updateSendButtonState();
    await this.client.sendTextQuestion(text);
    this.questionInput.focus();
  };

  // ---------------------------------------------------------------------
  // Backend session lifecycle
  // ---------------------------------------------------------------------

  startSession = async (avatarId) => {
    let response;
    try {
      response = await fetch(this._api("/api/session/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarId }),
      });
    } catch {
      throw new Error("Couldn't reach the server — check your connection and try again.");
    }
    if (!response.ok) {
      // The backend returns a human-readable { error } for the cases callers
      // actually hit in practice (rate limited, already on a call, upstream
      // FaceMarket failure) — surface that instead of a bare status code.
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || `Couldn't start the call (HTTP ${response.status}). Please try again.`);
    }
    return response.json(); // { sessionId, sfuUrl, userToken }
  };

  stopSession = async (sessionId) => {
    if (!sessionId) return;
    await fetch(this._api("/api/session/stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  };

  // True only while we're the ones tearing down the call (End Call button or
  // back-navigation). Lets the "sdk:disconnected" handler tell an intentional
  // hang-up apart from the server/network dropping the call on its own.
  hangUp = async () => {
    this.isIntentionalDisconnect = true;
    await this.client?.disconnect().catch(() => {});
    await this.stopSession(this.currentSessionId);
    this.currentSessionId = null;
  };

  showSessionEndedModal = (avatar) => {
    if (!this.sessionEndedModal) return;
    this.sessionEndedMessage.textContent = `The call with ${avatar.name} ended unexpectedly.`;
    this.sessionEndedModal.classList.remove("hidden");
    this.sessionEndedReconnectButton.onclick = () => {
      this.sessionEndedModal.classList.add("hidden");
      this.selectAvatar(avatar);
    };
  };

  showInCallUi = () => {
    this.callScreen.classList.add("hidden");
    this.inCallUi.classList.remove("hidden");
  };

  showCallScreen = () => {
    this.inCallUi.classList.add("hidden");
    this.setChatPanelOpen(false);
    this.exitTextMode();
    if (this.captionAdvanceTimer) {
      clearTimeout(this.captionAdvanceTimer);
      this.captionAdvanceTimer = null;
    }
    if (this.captionText) {
      this.captionText.style.transitionDuration = "0s";
      this.captionText.style.transform = "translateY(0px)";
      this.captionText.textContent = "";
    }
    this.captionCurrentLine = 0;
    this.captionLines = [];
    this.captionReviewing = false;
    this.captionDragState = null;
    this.setCaptionsEnabled(true);
    this.callScreen.classList.remove("hidden");
    this.resetCallScreenState();
    // Fully release the previous call's resources (video pipeline, RTC room,
    // listeners) — disconnect() alone leaves the client object allocated for
    // a possible reconnect, and its video element stayed in the shared
    // #avatar container. Across repeated back → reconnect cycles those stale
    // elements piled up and the next call's video ended up hidden behind
    // them, which showed as a black screen.
    // This runs from inside the client's own "sdk:disconnected" handler, so
    // guard the dispose in case its disconnect() call is still unwinding.
    try {
      this.client?.dispose();
    } catch (error) {
      console.error("Error disposing client", error);
    }
    this.container.innerHTML = "";
    this.client = null;
  };

  connectToAvatar = async (avatar, triggerEl, statusEl) => {
    try {
      triggerEl.classList.add("disabled", "calling");
      statusEl.textContent = `Calling ${avatar.name}…`;
      this._setStatus("Calling…", "connecting");

      const { sessionId, sfuUrl, userToken } = await this.startSession(avatar.id);
      this.currentSessionId = sessionId;
      this.avatarDisplayName = avatar.name;
      if (this.avatarNameLabel) this.avatarNameLabel.textContent = avatar.name;
      this.resetChatHistory();

      this.client?.dispose();
      this.container.innerHTML = "";

      this.client = createClient({
        connectConfig: { type: "direct", config: { sfuUrl, userToken } },
        video: { containerElement: this.container, fitMode: "cover" },
        debug: true,
      });

      this.client.events.on("sdk:connected", async ({ all }) => {
        if (!all) {
          this._setStatus("Connecting…", "connecting");
          return;
        }
        this._setStatus("Connected", "connected");
        this.showInCallUi();
        if (this.client.isAudioCapturing) {
          this.setMicActive(true);
        } else {
          await this.tryStartMic();
        }
      });

      this.client.events.on("sdk:disconnected", () => {
        this._setStatus("Disconnected", "idle");
        const wasIntentional = this.isIntentionalDisconnect;
        this.isIntentionalDisconnect = false;
        this.showCallScreen();
        if (!wasIntentional) this.showSessionEndedModal(avatar);
      });

      this.client.events.on("conversation:question:sent", ({ questionId, text }) => {
        this.handleUserTurn(questionId, text);
        this.showCaption(text);
      });

      this.client.events.on("conversation:asr:chunk", ({ text }) => {
        this.showCaption(text);
      });

      this.client.events.on("conversation:asr:received", ({ questionId, text }) => {
        this.handleUserTurn(questionId, text);
        this.showCaption(text);
      });

      this.client.events.on("conversation:answer:chunk", ({ questionId, chunk }) => {
        const next = (this.answerByQuestion.get(questionId) ?? "") + chunk;
        this.answerByQuestion.set(questionId, next);
        this.showCaption(next);

        const botBubble = this.botBubbleByQuestion.get(questionId);
        if (botBubble) {
          botBubble.body.innerHTML = linkifyText(next);
          this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
        }
      });

      this.client.events.on("conversation:answer:completed", ({ questionId, fullAnswer }) => {
        this.answerByQuestion.delete(questionId);
        this.showCaption(fullAnswer);

        const botBubble = this.botBubbleByQuestion.get(questionId);
        if (botBubble) {
          botBubble.body.innerHTML = linkifyText(fullAnswer);
          this.botBubbleByQuestion.delete(questionId);
        }
      });

      this.client.events.on("sdk:error", ({ code, message }) => {
        console.error(code, message);
        this._setStatus(`${code}: ${message}`, "error");
        statusEl.textContent = `${code}: ${message}`;
      });

      await this.client.preConnect();
      await this.client.connect();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "Connection failed";
      // Re-enable the call button directly rather than via
      // resetCallScreenState() — that also resets statusEl back to "Tap to
      // call X", which would erase this error message the instant it's set.
      this.avatarSingle.querySelectorAll(".call-accept-btn").forEach((el) => {
        el.classList.remove("disabled", "calling");
      });
      statusEl.textContent = message;
      this._setStatus(message, "error");
      this.client?.dispose();
      this.container.innerHTML = "";
      this.client = null;
    }
  };

  _setStatus = (message, tone = "idle") => {
    if (!this.statusDot) return;
    this.statusDot.className = `status-dot ${tone}`;
    this.statusDot.title = message;
  };
}
