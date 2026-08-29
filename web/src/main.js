import { FaceMarketWidget } from "./FaceMarketWidget.js";

// Demo bootstrap for this repo's page — mounts the widget full-screen into
// #app with the default config. See docs/FaceMarketWidget.md for everything
// the constructor accepts; embedding pages should follow this same pattern.
//
// window.__BASE_PATH__ is injected by index.js as an inline <script> in the
// served HTML (see injectBasePathScript() there) from the repo's BASE_PATH
// env var — the same value index.js itself reads for its own routes. Set
// BASE_PATH once in .env and this demo, the built asset URLs, and the
// backend's routes all agree automatically; nothing here needs hand-editing
// per deployment. "" (unset) = root-mounted.
const BASE_PATH = window.__BASE_PATH__ ?? "";

new FaceMarketWidget("#app", {
  buttons: {
    mic: true,
    keyboard: true,
    captions: true,
    interrupt: true,
    disconnect: true,
    chatToggle: true,
    share: true,
  },
  captionScrollSpeed: 1,
  manageUrl: true,
  apiBaseUrl: BASE_PATH,
  basePath: BASE_PATH,
});
