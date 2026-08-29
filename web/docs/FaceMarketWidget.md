# FaceMarketWidget

A self-contained, embeddable FaceMarket live-avatar video call UI. It renders
into a [Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)
subtree, so its styles never leak into (or are affected by) the host page —
you can drop it into any existing page without CSS collisions.

Source: `web/src/FaceMarketWidget.js`. Demo usage: `web/src/main.js`.

中文版本: [`FaceMarketWidget.zh-CN.md`](./FaceMarketWidget.zh-CN.md)

## What it includes

- An avatar picker (grid of avatars fetched from the backend), or a
  single-avatar "dial" screen when linked directly to one avatar.
- A full-screen in-call UI: mic mute, text-chat input, live captions,
  interrupt, end call, and a slide-in chat history drawer.
- A "session ended unexpectedly" modal with a one-tap reconnect, shown only
  when the call drops without the user having hung up themselves.

## Requirements

The widget talks to a backend that implements this repo's API contract (see
`index.js` at the project root):

- `GET /api/avatars` → `{ avatars: [{ id, name, description, cover }] }`
- `GET /api/avatars/:id` → `{ id, name, description, cover }`
- `POST /api/session/start` (body `{ avatarId }`) → `{ sessionId, sfuUrl, userToken }`
- `POST /api/session/stop` (body `{ sessionId }`)

By default it calls these as same-origin relative paths; point it at a
different backend with the `apiBaseUrl` option (see below).

## Quick start

```js
import { FaceMarketWidget } from "./FaceMarketWidget.js";

// Every option below is shown at its default value, for reference.
const widget = new FaceMarketWidget("#app", {
  avatarId: null,
  buttons: { mic: true, keyboard: true, captions: true, interrupt: true, disconnect: true, chatToggle: true, share: true },
  captionScrollSpeed: 1,
  manageUrl: false,
  autoLoadPicker: true,
  apiBaseUrl: "",
  basePath: "",
});
```

`#app` should be an element sized by the host page (the widget fills 100% of
its width/height — it does **not** assume it owns the whole viewport). For a
full-screen experience, size the container yourself, e.g.:

```css
#app { position: fixed; inset: 0; }
```

## `new FaceMarketWidget(target, options?)`

| Param     | Type                  | Description                                                                 |
| --------- | --------------------- | ----------------------------------------------------------------------------- |
| `target`  | `Element \| string`   | The container to render into, or a CSS selector resolved via `document.querySelector`. Required. |
| `options` | `object`              | Optional JSON config, see below. Partial objects are merged with defaults — you only need to specify what you want to change. |

Construction is synchronous and mounts immediately; the avatar list (or the
single deep-linked avatar) then loads asynchronously.

### Options

```ts
{
  // Initializes straight onto this avatar's dial screen ("tap to call"),
  // same as opening a "/avatar/<id>" deep link — for the common case where
  // a host page only ever embeds one specific avatar, so it doesn't have to
  // call showAvatar()/callAvatar() itself right after construction. Takes
  // priority over the current URL path and autoLoadPicker. null (default)
  // leaves startup behavior unchanged (picker grid, or URL-based deep link).
  avatarId: string | null,

  // Which control-bar / top-bar buttons to render. Every key defaults true.
  buttons: {
    mic: boolean,          // mute/unmute toggle
    keyboard: boolean,     // switch to typed-text input mode
    captions: boolean,     // live caption bar + its on/off toggle button
    interrupt: boolean,    // interrupt the avatar mid-response
    disconnect: boolean,   // end call button
    chatToggle: boolean,   // chat-history drawer + its toggle button
    share: boolean,        // "copy link to this avatar" button on picker cards / the dial screen
  },

  // Multiplier applied to the caption pacing rate.
  // 1 = default (~150 wpm English / ~300 chars/min CJK), 2 = twice as fast
  // (shorter hold per line), 0.5 = half speed. Must be > 0.
  captionScrollSpeed: number,

  // Whether the widget reads "/avatar/<id>" from the page URL on load, and
  // updates the URL/history/document title as the user navigates within it
  // (via history.pushState — no full reloads). Defaults off, since most
  // embeds are one part of a larger page that owns its own routing/title —
  // turn this on for a widget that owns the whole page.
  manageUrl: boolean,

  // Whether the widget shows its own avatar-picker grid on load. Turn this
  // off if a host page drives avatar selection with its own UI (outside the
  // widget) and calls callAvatar() instead — the widget then stays idle
  // until told which avatar to call, rather than loading its own grid.
  autoLoadPicker: boolean,

  // Prefix for backend API calls. "" (default) makes same-origin relative
  // requests — use this when the widget's page is served by the same
  // backend as this repo. Set to e.g. "https://api.example.com" if the
  // widget is embedded on a different origin than the backend.
  apiBaseUrl: string,

  // Path prefix this widget's own page is mounted under — e.g. "/liveavatar"
  // if reverse-proxied there — used only when manageUrl is true, so deep
  // links are read/written as "<basePath>/avatar/<id>" instead of assuming
  // the widget owns the domain's root at "/avatar/<id>". Independent of
  // apiBaseUrl: the page's own mount path and the backend's API location
  // aren't necessarily the same thing. "" (default) means root-mounted.
  basePath: string,
}
```

Setting `buttons.disconnect: false` removes the End Call button from the UI,
but you can still end an active call programmatically — see `hangUp()` below.

### Example: minimal read-only-ish embed, faster captions, remote API

```js
new FaceMarketWidget(document.getElementById("call-widget"), {
  buttons: { keyboard: false, share: false }, // everything else stays default (true)
  captionScrollSpeed: 1.5,
  apiBaseUrl: "https://avatar-backend.example.com",
});
```

### Example: single fixed avatar (most common embed)

```js
new FaceMarketWidget("#call-widget", {
  avatarId: "avatar_01m0zwzpntef4tcsam1sxfcgcm",
});
```

### Example: host page picks the avatar, not the widget

```js
const widget = new FaceMarketWidget("#call-widget", {
  autoLoadPicker: false, // don't render the widget's own avatar grid
});

// Elsewhere in your own avatar-list UI (built however you like):
myAvatarListEl.querySelector(".avatar-item").addEventListener("click", () => {
  widget.showAvatar("avatar_01m0zwzpntef4tcsam1sxfcgcm"); // lands on the dial screen, tap to connect
  // or, if you already have the record from GET /api/avatars:
  // widget.showAvatar({ id, name, description, cover });
  // Skip straight to connecting instead: widget.callAvatar(...) — same args.
});
```

## Instance methods

| Method               | Description                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `showAvatar(avatarIdOrAvatar)` | `async`. Shows the single-avatar dial screen ("tap to call") for a specific avatar, driven from outside the widget, without connecting — the user still taps the call button. Same argument shape as `callAvatar()`. Use this when a host page's own avatar-selection UI should land on the normal tap-to-connect state rather than dialing immediately. |
| `callAvatar(avatarIdOrAvatar)` | `async`. Starts (or switches to) a call with a specific avatar immediately, driven from outside the widget. Pass either an avatar id (the widget fetches its details via `GET /api/avatars/:id`) or an avatar object you already have (`{ id, name, description, cover }`), e.g. from your own `GET /api/avatars` call. Most useful with `autoLoadPicker: false`, so the widget never shows its own picker grid and the host page is the only source of avatar selection. |
| `destroy()`           | Ends any active call, tears down SDK resources, and removes the widget's DOM from its container. The instance should not be reused after this. |
| `hangUp()`             | `async`. Ends the current call, if any (same action as the End Call button). Useful when `buttons.disconnect: false`, or to end the call from outside the widget (e.g. a page-level "leave" action). |

There's no `mount()` — construction mounts immediately. To move the widget,
`destroy()` it and construct a new one against the new target.

## Notes

- **Styling**: all CSS lives inside the widget's Shadow DOM (`STYLE_TEXT` in
  the source), scoped automatically — you can't (and don't need to) override
  it with page-level CSS. If you need visual customization beyond the
  `buttons`/`captionScrollSpeed` options, edit `STYLE_TEXT` directly.
- **One call at a time**: a single `FaceMarketWidget` instance manages one
  active call. Mount a second instance (in a different container) if you
  need more than one simultaneously.
- **Caption pacing algorithm**: captions advance one full rendered line at a
  time, holding each line on screen for a duration based on *that line's*
  word count (character count for CJK text, which has no word breaks) before
  sliding to the next — not a continuous scroll. Line boundaries are measured
  from actual rendered layout (`Range.getClientRects()`, walking every text
  node under the caption element via `TreeWalker` — not just assuming a
  single text node, since a caption's text can include inline links, see
  **Links** below), not guessed from the raw string, since CSS text wrapping
  depends on the rendered width.
- **Manual caption review**: once auto-advance has fully caught up (nothing
  left to scroll to), dragging or wheel-scrolling over the caption lets you
  manually scroll back through earlier lines — press-and-hold with the
  mouse, touch-drag, or use the wheel. This only ever engages once
  auto-advance is at rest, never mid-animation, so it can't fight with an
  in-progress line transition. While scrolled back, new streaming text
  won't yank your position forward — it resumes auto-advancing (from
  wherever you left off) once you scroll back to the live tail yourself, or
  a new question/answer turn starts.
- **Deep links**: with `manageUrl: true` (off by default — turn it on for a
  widget that owns the whole page), opening `<basePath>/avatar/<id>` lands
  directly on that avatar's dial screen. Every avatar card also has a "copy
  link" button (`buttons.share`) that copies
  `location.origin + basePath + /avatar/<id>` to the clipboard — this only
  makes sense with `manageUrl: true`, since it's useless if the widget can't
  read that URL back on load.
- **Small/floating containers**: layout is sized off the widget's own
  container (via [CSS Container Queries](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries),
  `container-type: size` on the internal root), not the browser viewport —
  so a small floating window (e.g. a 320×480px chat widget) lays out
  correctly rather than assuming it owns the full screen. Just size the
  `target` element to whatever footprint you want.
- **Links**: `http(s)://` URLs anywhere text is shown to the user — chat
  history (typed questions, voice questions, and the avatar's answers) and
  live captions alike — render as real, clickable `<a target="_blank">`
  links, each followed by a small external-link icon. Text is HTML-escaped
  first, so this is safe even if a message happens to contain `<`/`>`/`&`.
  In captions specifically, the link (and its icon) is inlined directly
  into the same text node structure the line-measurement algorithm walks
  (see the caption pacing note above) — not a separately-positioned
  overlay — so it scrolls naturally with the surrounding text instead of
  needing its own position tracking.
