import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import "dotenv/config"; // loads the repo-root .env when this runs standalone (`vite build`)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors index.js's own BASE_PATH normalization exactly (same env var) —
// keeps the built asset URLs and the backend's own route mounting in
// agreement automatically instead of having to hand-edit both. "" (default,
// unset) means root-mounted, matching direct access at the plain dev port
// with no reverse proxy in front at all.
const trimmedBasePath = (process.env.BASE_PATH ?? "").trim().replace(/^\/+|\/+$/g, "");
const BASE_PATH = trimmedBasePath ? `/${trimmedBasePath}` : "";

export default defineConfig({
  base: `${BASE_PATH}/`,
  // No `define` for BASE_PATH here: it's baked in reliably by `vite build`,
  // but confirmed NOT applied to files served live through vite.middlewares
  // in dev mode with this middlewareMode + appType:"custom" setup — a real
  // Vite dev-server gap, not a fluke (isolated repro reproduced it outside
  // this project entirely). index.js instead injects `window.__BASE_PATH__`
  // as an inline <script> into the served HTML itself, the same way in both
  // dev and prod — see injectBasePathScript() there, and main.js/demo.js.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        demo: path.resolve(__dirname, "demo.html"),
      },
    },
  },
});
