// Resilient browser-support gate: depends only on local device_detection.js (no CDN), so the
// warning always renders — even if the esptool-js import in main.js fails to load. Kept in its
// own file (not inline) so index.html can enforce a strict `script-src 'self'` CSP.
import { webSerialStatus } from "./device_detection.js";

const status = webSerialStatus();
if (!status.supported) {
  const warning = document.getElementById("supportWarning");
  const connect = document.getElementById("connectButton");
  if (warning) {
    warning.textContent = status.message;
    warning.hidden = false;
  }
  if (connect) connect.disabled = true;
}
