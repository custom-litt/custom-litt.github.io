import {
  KNOWN_DEVICE_FILTERS, portBridge, classifyConnectError,
  detectPlatform, driverLinkFor, normalizeChipFamily, describeHardware, isPortChipMismatch,
  hardwareTipFor, parseSha256, bytesToHex, planBaudRates,
  FIRMWARE_MATRIX, modelOptionsFor
} from "./device_detection.js";

const SUPPORTS_WEB_SERIAL = "serial" in navigator;
const PLATFORM = detectPlatform();

// esptool-js is vendored locally (assets/vendor/esptool-bundle.js — verified byte-identical to the
// official npm esptool-js@0.5.4 build) rather than pulled from a CDN. This removes the only remote
// code-execution trust boundary on a page that writes firmware to hardware, and lets index.html
// enforce a script-src 'self' CSP. Still loaded lazily so a load failure surfaces as a clear message
// at connect time instead of silently breaking the whole page at import time.
let esptoolModule = null;
async function loadEsptool() {
  if (esptoolModule) return esptoolModule;
  try {
    esptoolModule = await import("./vendor/esptool-bundle.js");
  } catch (error) {
    throw new Error("Couldn't load the flasher engine (esptool-js). Try reloading the page.");
  }
  return esptoolModule;
}

const elements = {
  supportWarning: document.getElementById("supportWarning"),
  connectionStatus: document.getElementById("connectionStatus"),
  chipType: document.getElementById("chipType"),
  connectButton: document.getElementById("connectButton"),
  flashButton: document.getElementById("flashButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  model: document.getElementById("model"),
  firmwareVersion: document.getElementById("firmwareVersion"),
  uploadProgress: document.getElementById("uploadProgress"),
  uploadProgressText: document.getElementById("uploadProgressText"),
  uploadProgressBar: document.getElementById("uploadProgressBar"),
  log: document.getElementById("log"),
  logTemplate: document.getElementById("logLineTemplate"),
  connectionHelp: document.getElementById("connectionHelp")
};

const latestFirmwareCache = new Map();
let latestFirmwareRequestId = 0;

/** @typedef {{
  port: any,
  transport: any,
  loader: any,
  chipFamily: string | null,
  busy: boolean
}} MutableState */

/** @type {MutableState} */
const state = {
  port: null,
  transport: null,
  loader: null,
  chipFamily: null,
  busy: false
};

// The browser-support gate (Web Serial / Firefox / Safari) is rendered by the resilient inline
// module in index.html, which depends only on local device_detection.js — so the warning shows even if
// the esptool CDN import fails. main.js still guards at connect time via SUPPORTS_WEB_SERIAL.

function log(message) {
  const template = elements.logTemplate.content.cloneNode(true);
  const container = template.querySelector(".log__entry");
  if (!container) return;
  const time = container.querySelector("time");
  const messageNode = container.querySelector(".log__message");
  const now = new Date();
  if (time) {
    time.textContent = now.toLocaleTimeString();
  }
  if (messageNode) {
    messageNode.textContent = message;
  }
  elements.log.appendChild(template);
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  elements.connectButton.disabled = busy || !!state.port;
  elements.disconnectButton.disabled = busy || !state.port;
  elements.model.disabled = busy || !state.chipFamily;
  updateFirmwareDisplay();
}

function setUploadProgress(percent, visible) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));

  if (elements.uploadProgress) {
    elements.uploadProgress.hidden = !visible;
  }
  if (elements.uploadProgressText) {
    elements.uploadProgressText.textContent = `${clamped}%`;
  }
  if (elements.uploadProgressBar) {
    elements.uploadProgressBar.style.width = `${clamped}%`;
  }
  const track = elements.uploadProgress?.querySelector?.(".progress__track");
  if (track) {
    track.setAttribute("aria-valuenow", String(clamped));
  }
}

// Rebuilds the model dropdown for the connected module generation. Options come from
// FIRMWARE_MATRIX via modelOptionsFor(), so a model can never be offered without firmware
// behind it — the legacy module gets the two panel sizes, the new one also gets the cable
// hider and the clock.
function populateModelOptions() {
  const select = elements.model;
  if (!select) return;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.selected = true;
  placeholder.hidden = true;
  placeholder.textContent = "Select a model";
  select.appendChild(placeholder);

  for (const option of modelOptionsFor(state.chipFamily)) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }
  select.disabled = !state.chipFamily;
}

function updateFirmwareDisplay() {
  const model = elements.model.value;
  const family = state.chipFamily;
  const entry = model && family ? FIRMWARE_MATRIX?.[family]?.[model] : null;

  if (!model || !family || !entry || !state.loader) {
    if (elements.firmwareVersion) {
      elements.firmwareVersion.textContent = "—";
    }
    elements.flashButton.disabled = true;
    return;
  }

  const cached = latestFirmwareCache.get(entry.uuid);
  if (cached?.version) {
    if (elements.firmwareVersion) {
      elements.firmwareVersion.textContent = `v${cached.version}`;
    }
    elements.flashButton.disabled = state.busy;
    return;
  }

  if (elements.firmwareVersion) {
    elements.firmwareVersion.textContent = "Loading…";
  }
  elements.flashButton.disabled = true;

  const requestId = ++latestFirmwareRequestId;
  resolveLatestFirmwareInfo(entry.uuid)
    .then((info) => {
      latestFirmwareCache.set(entry.uuid, info);
      if (requestId !== latestFirmwareRequestId) return;
      updateFirmwareDisplay();
    })
    .catch((error) => {
      if (requestId !== latestFirmwareRequestId) return;
      if (elements.firmwareVersion) {
        elements.firmwareVersion.textContent = "Unavailable";
      }
      elements.flashButton.disabled = true;
      log(`❌ Unable to resolve latest firmware version: ${error.message ?? error}`);
      console.error(error);
    });
}

async function resolveLatestFirmwareInfo(uuid) {
  const indexBase = `./api/v1/index/hwid/${uuid}/releases/latest`;
  const versionUrl = `${indexBase}/version.txt`;
  const response = await fetch(versionUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to resolve latest version (${response.status} ${response.statusText})`);
  }
  const versionRaw = await response.text();
  const version = String(versionRaw).trim();
  if (!version) {
    throw new Error("Latest version file was empty.");
  }
  const firmwareUrl = `./api/v1/bin/firmware/${uuid}/v${version}/firmware_full.bin`;
  // sha256sum_full.txt is the checksum of firmware_full.bin specifically (the bytes we flash);
  // the sibling sha256sum.txt covers firmware.bin, which is a different artifact.
  const sha256Url = `${indexBase}/sha256sum_full.txt`;
  return { version, firmwareUrl, sha256Url };
}

async function requestDevicePort() {
  return navigator.serial.requestPort({ filters: KNOWN_DEVICE_FILTERS });
}

function hideConnectionHelp() {
  if (elements.connectionHelp) elements.connectionHelp.hidden = true;
}

// Builds the help panel with safe DOM nodes (no innerHTML) to avoid any XSS surface.
// `portInfo` (from portBridge) is the selected port's hardware classification, when a port
// was picked before the failure — it lets the tips distinguish new driverless panels
// (S3 native USB) from old CP210x panels, where driver advice actually applies.
function showConnectionHelp(kind, portInfo = null) {
  const el = elements.connectionHelp;
  if (!el) return;
  el.replaceChildren();

  const strong = document.createElement("strong");
  strong.textContent = "Don't see your device? ";
  el.appendChild(strong);

  const link = driverLinkFor(PLATFORM.os);
  const winUpdate = PLATFORM.os === "windows"
    ? " On Windows the driver is usually installed automatically over Windows Update if you're online."
    : "";

  if (kind === "no-port") {
    // No port was picked, so the hardware generation is unknown here. Lead with the most
    // common, non-technical causes; the CP210x driver stays a secondary hint, scoped to
    // "older" panels so new-model (driverless) owners aren't sent chasing a driver.
    const list = document.createElement("ul");

    const cableItem = document.createElement("li");
    cableItem.textContent = "Make sure your panel is connected with a cable capable of data transfer, not a charge-only/power cable.";
    list.appendChild(cableItem);

    if (link) {
      const driverItem = document.createElement("li");
      driverItem.append("If you have an older panel and it's not showing up, you may need to ");
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "install the CP210x USB driver";
      driverItem.append(a, `.${winUpdate}`);
      list.appendChild(driverItem);
    }

    el.appendChild(list);

    if (!PLATFORM.isChromium) {
      el.append("To flash, your browser must support the Web Serial API. Supported browsers are Google Chrome and other Chromium-based browsers such as Microsoft Edge.");
    }
    el.hidden = false;
    return;
  }

  const messages = {
    "blocked": "Web Serial is blocked by your browser or IT policy. Check the site's permissions or try a personal (non-managed) machine.",
    "busy": "The serial port is in use by another program or browser tab. Close it (or unplug and re-plug the device), then try again.",
    "flaky": "The device keeps disconnecting — usually a charge-only cable or insufficient power. Try a known-good data cable or a powered USB hub.",
    "download-mode": "Couldn't sync with the board. Hold the BOOT button, tap RESET (or re-plug), then click Connect again.",
    "unknown": "Connection failed. See the log above for details."
  };
  el.append(messages[kind] ?? messages.unknown);

  // A port WAS selected, so we know the hardware: add the generation-specific tip
  // (new = driverless, a driver won't fix it; cp210x = the driver genuinely may).
  const hwTip = hardwareTipFor(portInfo);
  if (hwTip.tip) {
    el.append(` ${hwTip.tip}`);
  }
  el.hidden = false;
}

async function connectToDevice() {
  if (!SUPPORTS_WEB_SERIAL) return;
  setBusy(true);
  hideConnectionHelp();
  // Declared outside the try so the error handler can tailor help to the
  // selected hardware (old vs new panel) even when connecting fails later.
  let port = null;
  try {
    port = await requestDevicePort();
    log("Serial port selected. Opening connection...");

    const { ESPLoader, Transport } = await loadEsptool();
    // Transport's second parameter is `tracing`: it console-logs AND accumulates every
    // serial read/write into an unbounded traceLog string — never enable it for real flashes.
    const transport = new Transport(port);

    const terminalInterface = {
      clean() {},
      writeLine(data) { log(data); },
      write(data) { log(data); },
    }

    // `romBaudrate` is what the ROM-loader sync runs at; `baudrate` is the target the link
    // moves to once the stub is up. loader.main() performs that switch itself — see
    // planBaudRates() for why nothing here may switch the baud a second time.
    const baudPlan = planBaudRates(portBridge(port));
    const ldOptions = {
      transport: transport,
      baudrate: baudPlan.baudrate,
      romBaudrate: baudPlan.romBaudrate,
      terminal: terminalInterface,
    }

    const loader = new ESPLoader(ldOptions);

    // Register with the shared state BEFORE the handshake: loader.main() opens the OS
    // serial port, so if it (or the chip check below) throws, the catch block's
    // disconnectDevice(true) must be able to find and close the port — otherwise the tab
    // keeps it held and every retry fails with a misleading "port is in use" error.
    state.port = port;
    state.transport = transport;
    state.loader = loader;

    log("Connecting to panel...");
    let chipName = null;
    if (typeof loader.main === "function") {
      try {
        chipName = await loader.main();
      } catch (error) {
        log(`Unable to initialize loader: ${error.message ?? error}`);
        console.error(error);
        throw error;
      }
    } else if (typeof loader.connect === "function") {
      await loader.connect();
    } else if (typeof loader.initialize === "function") {
      await loader.initialize();
    }

    chipName =
      chipName ??
      loader?.chip?.CHIP_NAME ??
      loader?.chip?.name ??
      loader?.CHIP_NAME ??
      loader?.chipName ??
      null;
    const normalized = normalizeChipFamily(chipName);
    if (!normalized) {
      throw new Error(`Unsupported chip detected: ${chipName ?? "unknown"}`);
    }

    state.chipFamily = normalized;
    const portInfo = portBridge(port);
    if (isPortChipMismatch(portInfo, normalized)) {
      log("⚠️ Port/chip mismatch detected — try re-seating the device and reconnecting.");
    }
    const hw = describeHardware(portInfo, normalized);
    elements.connectionStatus.textContent = "Connected";
    elements.chipType.textContent = hw.label;
    elements.chipType.classList.remove("status__value--muted");
    log(`Connected to ${hw.label}`);

    // No stub upload or changeBaud() call belongs here: loader.main() above already did both,
    // in that order. Repeating the baud switch is not harmless — changeBaud() reports
    // `romBaudrate` as the stub's current rate, which stops being true the moment the first
    // switch lands, so a second call leaves the chip transmitting ~8x too fast and the flash
    // dies on its first command. planBaudRates() carries the full explanation.
    log(baudPlan.switchedByMain
      ? `Link running at ${baudPlan.baudrate} baud.`
      : `Link running at ${baudPlan.baudrate} baud (native USB — fixed speed).`);
    // Which models are offered depends on the chip we just identified, so the dropdown is
    // built here rather than in the markup.
    populateModelOptions();
    updateFirmwareDisplay();
  } catch (error) {
    log(`❌ ${error.message ?? error}`);
    console.error(error);
    showConnectionHelp(classifyConnectError(error), port ? portBridge(port) : null);
    await disconnectDevice(true);
  } finally {
    setBusy(false);
  }
}

elements.connectButton.addEventListener("click", () => {
  if (!state.busy) {
    connectToDevice();
  }
});

elements.disconnectButton.addEventListener("click", () => {
  disconnectDevice();
});

elements.model.addEventListener("change", () => {
  updateFirmwareDisplay();
});

async function fetchFirmware(entry) {
  log(`Fetching firmware from ${entry.url}…`);
  const response = await fetch(entry.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to download firmware (${response.status} ${response.statusText})`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

// Verify the downloaded firmware against its published SHA-256 BEFORE writing a single byte
// to the chip. This is fail-closed: a missing, unreachable, or malformed checksum — or any
// mismatch — aborts the flash. We never fall back to flashing unverified bytes, since that
// would defeat the entire point of the check. crypto.subtle is always present here because
// Web Serial only runs in a secure (HTTPS) context.
async function assertFirmwareIntegrity(firmwareBytes, sha256Url) {
  let expected;
  try {
    const response = await fetch(sha256Url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    expected = parseSha256(await response.text());
  } catch (error) {
    throw new Error(`Couldn't fetch the firmware checksum (${error.message ?? error}) — refusing to flash unverified firmware.`);
  }
  if (!expected) {
    throw new Error("Published firmware checksum was missing or malformed — refusing to flash unverified firmware.");
  }
  const actual = bytesToHex(await crypto.subtle.digest("SHA-256", firmwareBytes));
  if (actual !== expected) {
    throw new Error(`Firmware checksum mismatch — refusing to flash. Expected ${expected}, got ${actual}.`);
  }
  log(`✅ Firmware checksum verified (SHA-256 ${actual}).`);
}

async function flashBinary(loader, fileEntry, options) {
  if (typeof loader.writeFlash === "function") {
    log("Flashing via loader.writeFlash()…");
    // CryptoJS comes from a plain script tag (assets/vendor); if it somehow didn't load,
    // esptool-js skips its post-write MD5 check when calculateMD5Hash is undefined —
    // warn and flash anyway rather than dying mid-flow with "CryptoJS is not defined".
    const hasCryptoJS = typeof CryptoJS !== "undefined";
    if (!hasCryptoJS) {
      log("⚠️ MD5 helper (crypto-js) didn't load — flashing without post-write verification.");
    }
    const flashOptions = {
      fileArray: [fileEntry],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: typeof options?.onProgress === "function" ? options.onProgress : undefined,
      calculateMD5Hash: hasCryptoJS
        ? (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)).toString()
        : undefined
    };
    await loader.writeFlash(flashOptions);
    await loader.after();
    return;
  }
  throw new Error("This version of esptool-js does not expose a supported flashing API.");
}

async function flashSelectedFirmware() {
  if (!state.loader || !state.chipFamily || !elements.model.value) {
    return;
  }
  const firmwareEntry = FIRMWARE_MATRIX[state.chipFamily]?.[elements.model.value];
  if (!firmwareEntry) {
    log("No firmware available for this selection.");
    return;
  }
  setBusy(true);
  setUploadProgress(0, true);
  try {
    const { version, firmwareUrl, sha256Url } = await resolveLatestFirmwareInfo(firmwareEntry.uuid);
    log(`Latest firmware version: v${version}`);

    const firmwareData = await fetchFirmware({ ...firmwareEntry, url: firmwareUrl });
    await assertFirmwareIntegrity(firmwareData, sha256Url);
    let lastProgress = -1;
    const progressHandler = (fileIndex, written, total) => {
      const percent = Math.round((written / total) * 100);
      if (percent !== lastProgress) {
        lastProgress = percent;
        setUploadProgress(percent, true);
      }
    };
    await flashBinary(
      state.loader,
      {
        data: Array.from(firmwareData, (byte) => String.fromCharCode(byte)).join(""),
        address: Number.isFinite(firmwareEntry.address) ? firmwareEntry.address : 0,
      },
      {
        onProgress: progressHandler
    });

    setUploadProgress(100, true);
    log("✅ Flash complete. The device should reboot shortly.");
  } catch (error) {
    console.error(error);
    log(`❌ Flash failed: ${error.message ?? error}`);
  } finally {
    // Always release the serial (COM) port when flashing ends — success or failure —
    // so the OS port is never left held by the tab after the tool is done with it.
    await disconnectDevice(true);
    setBusy(false);
    setUploadProgress(0, false);
  }
}

elements.flashButton.addEventListener("click", () => {
  if (!state.busy) {
    flashSelectedFirmware();
  }
});

async function disconnectDevice(force = false) {
  if (state.busy && !force) return;
  if (!state.port && !state.transport) {
    return;
  }
  setBusy(true);
  try {
    log("Disconnecting…");
    try {
      if (state.loader?.disconnect) {
        await state.loader.disconnect();
      }
    } catch (error) {
      log(`Ignoring disconnect error: ${error.message ?? error}`);
    }
    try {
      if (state.transport?.close) {
        await state.transport.close();
      } else if (state.transport?.disconnect) {
        await state.transport.disconnect();
      }
    } catch (error) {
      log(`Ignoring transport close error: ${error.message ?? error}`);
    }
    try {
      if (state.port?.close) {
        await state.port.close();
      }
    } catch (error) {
      log(`Ignoring port close error: ${error.message ?? error}`);
    }
  } finally {
    state.port = null;
    state.transport = null;
    state.loader = null;
    state.chipFamily = null;
    elements.connectionStatus.textContent = "Disconnected";
    elements.chipType.textContent = "—";
    elements.chipType.classList.add("status__value--muted");
    // chipFamily is now null, so this empties the dropdown and disables it — no stale model
    // list from the previous device survives a disconnect.
    populateModelOptions();
    latestFirmwareRequestId++;
    if (elements.firmwareVersion) {
      elements.firmwareVersion.textContent = "—";
    }
    updateFirmwareDisplay();
    setBusy(false);
  }
}

window.addEventListener("beforeunload", () => {
  if (state.port) {
    state.port.forget?.();
  }
});
updateFirmwareDisplay();
