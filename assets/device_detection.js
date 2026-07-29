// assets/device_detection.js — pure, framework-free detection/classification logic.
// No esptool-js, no DOM: importable from the browser app AND from Node tests.

/** USB vendor IDs that identify Custom Litt panels. */
export const VID = {
  SILABS: 0x10c4,    // CP2102N bridge — on legacy ESP32 AND the new S3 module; driver-dependent
  ESPRESSIF: 0x303a, // ESP32-S3 native USB (usbmodem) — driverless
};

/** Filter list to constrain the Web Serial port picker to our hardware. */
export const KNOWN_DEVICE_FILTERS = [
  { usbVendorId: VID.SILABS },
  { usbVendorId: VID.ESPRESSIF },
];

/**
 * Classify a selected serial port by its USB vendor id.
 * Note: 0x303A is definitively the new S3 board; 0x10C4 (CP2102N) is ambiguous
 * (present on legacy ESP32 and on the new module's CP210x path) — only the chip
 * read disambiguates generation.
 */
export function portBridge(port) {
  const { usbVendorId: vid, usbProductId: pid } = port?.getInfo?.() ?? {};
  if (vid === VID.ESPRESSIF) return { vid, pid, bridge: "s3-native", driverNeeded: false, gen: "new" };
  if (vid === VID.SILABS)    return { vid, pid, bridge: "cp210x",    driverNeeded: true,  gen: "ambiguous" };
  return { vid, pid, bridge: "unknown", driverNeeded: true, gen: "unknown" };
}

/**
 * Bucket a connect/open failure into an actionable category so the UI can show
 * the right guidance. Returns one of:
 * "no-port" | "blocked" | "download-mode" | "flaky" | "busy" | "unknown".
 *
 * Order matters: the picker errors (no-port/blocked) are unambiguous by name, but the
 * esptool-js sync failures and device-drop errors are only distinguishable by message, so
 * those are matched BEFORE the name-based "busy" fallback — otherwise a disconnect that
 * arrives as a NetworkError would be miscategorised as a port that's merely in use.
 */
export function classifyConnectError(error) {
  const name = error?.name;
  const message = error?.message ?? "";
  if (name === "NotFoundError") return "no-port";                       // empty picker or user cancelled
  if (name === "SecurityError" || name === "NotAllowedError") return "blocked"; // policy / no user gesture

  // Bootloader sync failed — esptool-js reached the port but couldn't talk to the ROM loader.
  // The fix is to enter download mode (hold BOOT, tap RESET), not to free a busy port, so these
  // win over the name-based "busy" below. Strings are taken verbatim from esptool-js@0.5.4.
  if (/failed to connect with the device|invalid head of packet|no serial data received|read timeout|download mode/i.test(message)) {
    return "download-mode";
  }
  // Device fell off the USB bus mid-handshake (charge-only cable / weak power). Web Serial
  // surfaces this as a "device lost/disconnected/removed" error; matched by message so a bare
  // NetworkError (port held by another program) still classifies as "busy" below.
  if (/device (?:has been )?(?:lost|disconnected|removed)|\bdisconnected\b/i.test(message)) {
    return "flaky";
  }

  if (name === "NetworkError" || name === "InvalidStateError") return "busy";   // open failed / already open
  if (/already open|access denied/i.test(message)) return "busy";
  return "unknown";
}

/** Serial speeds for a flash session. `ROM` is the rate the ROM bootloader syncs at. */
export const BAUD = { ROM: 115200, FAST: 921600 };

/**
 * Decide the serial link speeds for a flash session from the selected port.
 *
 * Returns `{ romBaudrate, baudrate, switchedByMain }` — the first two go straight into the
 * ESPLoader options; `switchedByMain` records whether that pair makes ESPLoader.main()
 * change the baud on its own.
 *
 * IMPORTANT — main() owns the switch, callers must not repeat it. esptool-js runs
 * `romBaudrate !== baudrate && await this.changeBaud()` right after it uploads the stub, and
 * changeBaud() sends `romBaudrate` as the stub's "what you're running at now" reference:
 *
 *     const old = this.IS_STUB ? this.romBaudrate : 0;   // hardcoded, not the live rate
 *     await this.command(this.ESP_CHANGE_BAUDRATE, [this.baudrate, old]);
 *
 * The stub rescales its UART divider by `old / new`, so that reference is only true the first
 * time. Call changeBaud() a second time and the stub is told it sits at 115200 when the link
 * already runs at 921600 — it divides by eight, ends up transmitting near 7.4 Mbaud, and the
 * host never sees another byte. The next command (FLASH_DEFL_BEGIN, the first one a flash
 * issues) dies on the 3 s DEFAULT_TIMEOUT with "No serial data received."
 *
 * ESP32-S3 native USB-Serial-JTAG (VID 0x303a) has no UART divider to change — the link runs
 * at USB speed and the "baud rate" is a fiction — so it stays at the ROM rate and never
 * switches. Only a real UART bridge (CP210x, on the legacy panels) gains anything from 921600.
 */
export function planBaudRates(portInfo, { fast = BAUD.FAST, rom = BAUD.ROM } = {}) {
  const baudrate = portInfo?.bridge === "s3-native" ? rom : fast;
  return { romBaudrate: rom, baudrate, switchedByMain: baudrate !== rom };
}

const CP210X_DRIVER_URL = "https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers";

/** CP210x VCP driver download (or null on Linux, where cp210x is in-kernel). */
export function driverLinkFor(os) {
  return os === "linux" ? null : CP210X_DRIVER_URL;
}

/**
 * Detect OS + browser engine for tailored guidance. `env` lets tests inject a UA;
 * defaults to the global navigator in the browser.
 */
export function detectPlatform(env = {}) {
  const ua = env.ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "") ?? "";
  const uaData = env.uaData ?? (typeof navigator !== "undefined" ? navigator.userAgentData : null);

  let os = (uaData?.platform || "").toLowerCase();
  if (!os || os === "") {
    os = /Win/i.test(ua) ? "windows"
       : /Mac/i.test(ua) ? "macos"
       : /Linux|X11|CrOS/i.test(ua) ? "linux"
       : "unknown";
  }

  const isChromium = !!uaData?.brands?.some((b) => /Chrom|Edge/i.test(b.brand))
                     || /Chrome|Chromium|Edg\//i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg\//i.test(ua);
  const isFirefox = /Firefox/i.test(ua);
  // Web Serial is desktop-only, so phones/tablets can never flash regardless of browser.
  // Prefer the structured uaData.mobile hint; fall back to UA sniffing. (Note: iPadOS Safari
  // masquerades as desktop macOS, so it isn't caught here — feature detection still blocks it.)
  const isMobile = (typeof uaData?.mobile === "boolean" ? uaData.mobile : false)
                   || /Android|iPhone|iPod|Mobile/i.test(ua);
  return { os, isChromium, isSafari, isFirefox, isMobile };
}

/**
 * Extract a SHA-256 hex digest from a published checksum file. Accepts either a bare
 * 64-char hex string or a `sha256sum`-style "<hash>  <filename>" line. Returns the hash
 * lowercased, or null if the text doesn't begin with exactly 64 hex characters — callers
 * MUST treat null as "no trustworthy checksum" and refuse to flash rather than skip the check.
 */
export function parseSha256(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^[0-9a-fA-F]{64}\b/);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Lowercase, zero-padded hex string for a digest. Accepts an ArrayBuffer (the shape
 * crypto.subtle.digest resolves to) or a Uint8Array.
 */
export function bytesToHex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Map an esptool-detected chip name to a Custom Litt firmware family. */
export function normalizeChipFamily(rawName) {
  if (!rawName) return null;
  const lowered = String(rawName).toLowerCase();
  if (lowered.includes("s3")) return "Pixlpro";
  if (lowered.includes("esp32")) return "Legacy Pixlpro";
  return null;
}

/**
 * Which products each module generation can be flashed as, and the firmware hardware ID for
 * each. Keyed by the chip family that normalizeChipFamily() returns, because the chip is the
 * ONLY thing the flasher can actually detect.
 *
 * Why the model can't be auto-detected: a product's hardware ID lives in its firmware image,
 * not in the board. The firmware build embeds `hardware_id.txt` into the binary
 * (CMake EMBED_TXTFILES) and the running app reports it via Board::GetHardwareId(). The flasher
 * talks to the ROM/stub bootloader in download mode, where no app is running — and even reading
 * the ID out of the currently-installed image would only say what was flashed last, not what
 * the board is, so a device mis-flashed once would stay mis-flashed forever. A clock and a 13"
 * panel are the same ESP32-S3 as far as the wire is concerned.
 *
 * So the operator picks the model, and these UUIDs are the only thing keeping panel firmware
 * off a clock. Source of truth for the mapping: pixlpro/firmware/out/README.md.
 * `bandgap-cable-hider-single` (910105d3…) is deliberately absent — it's the one-board
 * bring-up/testing build, not a product.
 *
 * Insertion order is dropdown order.
 */
export const FIRMWARE_MATRIX = {
  // Legacy module: ESP32, CP210x bridge. Panels only.
  "Legacy Pixlpro": {
    "13": { uuid: "ac79bb5e-dc0c-4799-bcc4-2587fd898faf", address: 0x0, label: "13 inch" },
    "15": { uuid: "d89d2bbd-d65c-4ec0-abd7-9967e0a461dd", address: 0x0, label: "15 inch" },
  },
  // New "bandgap" module: ESP32-S3. Panels plus the cable hider and clock form factors.
  "Pixlpro": {
    "13":           { uuid: "0c80a421-3cfb-4a5e-b93e-3f0024689582", address: 0x0, label: "13 inch" },
    "15":           { uuid: "2e40e56e-d0ed-4568-9879-c6938f52e773", address: 0x0, label: "15 inch" },
    // `hidden` keeps a model plumbed in but off the dropdown. Cable hider's firmware isn't
    // published under api/ yet, so offering it would only ever resolve "Unavailable" — drop
    // this flag once the firmware lands and it works with no other change.
    "cable-hider":  { uuid: "3481efbd-8ada-42e4-ab3f-05968546e82d", address: 0x0, label: "Cable hider", hidden: true },
    "clock":        { uuid: "8949218b-432c-4ffe-8f7d-73e80421fd1f", address: 0x0, label: "Clock" },
  },
};

/**
 * Ordered dropdown options for a chip family: `[{ value, label }]`, empty for an unknown or
 * missing family. Generated FROM FIRMWARE_MATRIX rather than listed separately, so an option
 * can never exist without firmware behind it. Entries marked `hidden` are skipped — they stay
 * flashable in the matrix but aren't offered to the operator.
 */
export function modelOptionsFor(chipFamily) {
  const models = chipFamily ? FIRMWARE_MATRIX[chipFamily] : null;
  if (!models) return [];
  return Object.entries(models)
    .filter(([, entry]) => !entry.hidden)
    .map(([value, entry]) => ({ value, label: entry.label }));
}

/** Merge the pre-connect port hint with the authoritative chip family into a label + generation. */
export function describeHardware(portInfo, chipFamily) {
  if (chipFamily === "Pixlpro")        return { gen: "new",    label: "Pixlpro (ESP32-S3)" };
  if (chipFamily === "Legacy Pixlpro") return { gen: "legacy", label: "Legacy Pixlpro (ESP32)" };
  return { gen: portInfo?.gen ?? "unknown", label: "Unknown" };
}

/** A plain ESP32 has no native USB, so a native-USB port reporting an ESP32 chip is impossible. */
export function isPortChipMismatch(portInfo, chipFamily) {
  return portInfo?.bridge === "s3-native" && chipFamily === "Legacy Pixlpro";
}

/**
 * Hardware-specific troubleshooting tip for a selected port, derived from portBridge().
 * New panels (ESP32-S3 native USB, VID 0x303A) are driverless — telling those users to
 * install a driver sends them down a dead end, so the tip explicitly rules it out.
 * CP210x ports (old panels, or the new module's bridge path) genuinely may need the driver.
 * Unknown/missing port info -> no tip (the generic kind-based help stands alone).
 */
export function hardwareTipFor(portInfo) {
  if (portInfo?.bridge === "s3-native") {
    return {
      gen: "new",
      needsDriver: false,
      tip: "Your panel was detected as the new model with native USB — no driver is needed, so installing or reinstalling one won't help. Instead try a different USB data cable or port, or hold the BOOT button while plugging it in."
    };
  }
  if (portInfo?.bridge === "cp210x") {
    return {
      gen: portInfo.gen ?? "ambiguous",
      needsDriver: true,
      tip: "Your panel connects through a CP210x USB bridge — if connecting keeps failing, reinstalling the CP210x driver can help."
    };
  }
  return { gen: portInfo?.gen ?? "unknown", needsDriver: null, tip: null };
}

/**
 * Whether this browser can run the flasher (Web Serial), plus a user-facing message.
 *
 * The reliable test is feature detection (`'serial' in navigator`), NOT browser-name sniffing:
 * Web Serial works on Chromium-based DESKTOP browsers (Chrome, Edge, Opera, usually Brave), and
 * Edge/Brave/Opera all report "Chrome" in their UA anyway. It is unavailable in Firefox/Safari
 * (vendor decision, never coming) and on every browser on iOS/iPadOS/Android (desktop-only API).
 *
 * Messages recommend Google Chrome first (the reference implementation) but note Edge also works,
 * and call out the cases that can never work so users don't waste time. `env` lets tests inject state.
 */
export function webSerialStatus({ hasSerial, platform } = {}) {
  const supported = hasSerial ?? (typeof navigator !== "undefined" && "serial" in navigator);
  if (supported) return { supported: true, message: "" };
  const p = platform ?? detectPlatform();

  // Shared recommendation: Chrome first, Edge as a working alternative.
  const useChrome = "Please open this page in Google Chrome on a desktop or laptop (Microsoft Edge also works).";

  let message;
  if (p.isMobile) {
    // Check mobile first: on a phone/tablet, switching browser won't help, so "use a computer" is the real fix.
    message = "This flasher needs the Web Serial API, which isn't available on phones or tablets. Open this page on a desktop or laptop computer using Google Chrome (Microsoft Edge also works).";
  } else if (p.isFirefox) {
    message = `Firefox doesn't support the Web Serial API this flasher needs. ${useChrome}`;
  } else if (p.isSafari) {
    message = `Safari — and every browser on iPhone and iPad — doesn't support the Web Serial API this flasher needs. ${useChrome}`;
  } else {
    message = `This browser doesn't support the Web Serial API this flasher needs. ${useChrome} It won't work in Firefox or Safari, or on iPhone, iPad, or Android.`;
  }
  return { supported: false, message };
}
