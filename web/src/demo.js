import { FaceMarketWidget } from "./FaceMarketWidget.js";

// This page owns avatar selection itself (the chip list below is plain page
// markup, not the widget's built-in picker) and drives the widget entirely
// through showAvatar() — autoLoadPicker: false keeps the widget idle until
// told which avatar to call, so it doesn't render its own grid too.
//
// window.__BASE_PATH__ is injected by index.js as an inline <script> in the
// served HTML — see main.js for the fuller explanation. Both this page's
// own fetch() below and the widget's apiBaseUrl need it: without it,
// requests would go to the unprefixed "/api/..." instead of
// "<BASE_PATH>/api/...", which 404s whenever BASE_PATH is actually set.
const BASE_PATH = window.__BASE_PATH__ ?? "";

const widget = new FaceMarketWidget("#widget-frame", {
  autoLoadPicker: false,
  captionScrollSpeed: 1,
  apiBaseUrl: BASE_PATH,
  basePath: BASE_PATH,
});

const listEl = document.getElementById("avatar-list");

async function loadAvatarList() {
  try {
    const response = await fetch(`${BASE_PATH}/api/avatars`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { avatars } = await response.json();
    listEl.innerHTML = "";
    for (const avatar of avatars) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "avatar-chip";
      chip.textContent = avatar.name;
      chip.addEventListener("click", () => {
        listEl.querySelectorAll(".avatar-chip").forEach((el) => el.classList.remove("active"));
        chip.classList.add("active");
        // Land on the dial screen first — the user still taps the call
        // button to actually connect, same as a deep link.
        widget.showAvatar(avatar);
      });
      listEl.appendChild(chip);
    }
  } catch (error) {
    console.error("Failed to load avatar list", error);
    listEl.textContent = "Couldn't load avatars — check the server and reload.";
  }
}

loadAvatarList();
