import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.5.4/bundle.js";

const FIRMWARE_MATRIX = {
  "Legacy Pixlpro": {
    "13": {
      uuid: "ac79bb5e-dc0c-4799-bcc4-2587fd898faf",
      address: 0x0,
      label: "ESP32 · 13 inch"
    },
    "15": {
      uuid: "d89d2bbd-d65c-4ec0-abd7-9967e0a461dd",
      address: 0x0,
      label: "ESP32 · 15 inch"
    }
  },
  "Pixlpro": {
    "13": {
      uuid: "0c80a421-3cfb-4a5e-b93e-3f0024689582",
      address: 0x0,
      label: "ESP32-S3 · 13 inch"
    },
    "15": {
      uuid: "2e40e56e-d0ed-4568-9879-c6938f52e773",
      address: 0x0,
      label: "ESP32-S3 · 15 inch"
    }
  }
};

const SUPPORTS_WEB_SERIAL = "serial" in navigator;
const BAUD_RATE = 921600;
const INITIAL_BAUD_RATE = 115200;

const elements = {
  supportWarning: document.getElementById("supportWarning"),
  connectionStatus: document.getElementById("connectionStatus"),
  chipType: document.getElementById("chipType"),
  connectButton: document.getElementById("connectButton"),
  flashButton: document.getElementById("flashButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  panelSize: document.getElementById("panelSize"),
  firmwareVersion: document.getElementById("firmwareVersion"),
  uploadProgress: document.getElementById("uploadProgress"),
  uploadProgressText: document.getElementById("uploadProgressText"),
  uploadProgressBar: document.getElementById("uploadProgressBar"),
  log: document.getElementById("log"),
  logTemplate: document.getElementById("logLineTemplate")
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

if (!SUPPORTS_WEB_SERIAL) {
  elements.supportWarning.hidden = false;
  elements.connectButton.disabled = true;
}

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
  elements.panelSize.disabled = busy || !state.chipFamily;
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

function updateFirmwareDisplay() {
  const size = elements.panelSize.value;
  const family = state.chipFamily;
  const entry = size && family ? FIRMWARE_MATRIX?.[family]?.[size] : null;

  if (!size || !family || !entry || !state.loader) {
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
  const versionUrl = `./api/v1/index/hwid/${uuid}/releases/latest/version.txt`;
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
  log(`resolved ${firmwareUrl} as URL for uuid ${uuid}`);
  return { version, firmwareUrl };
}

function normalizeChipFamily(rawName) {
  if (!rawName) return null;
  const lowered = String(rawName).toLowerCase();
  if (lowered.includes("s3")) return "Pixlpro";
  if (lowered.includes("esp32")) return "Legacy Pixlpro";
  return null;
}

async function connectToDevice() {
  if (!SUPPORTS_WEB_SERIAL) return;
  setBusy(true);
  try {
    const port = await navigator.serial.requestPort();
    log("Serial port selected. Opening connection...");

    const transport = new Transport(port, true);
    const initialBaud = Number(INITIAL_BAUD_RATE);
    
    const terminalInterface = {
      clean() {},
      writeLine(data) { log(data); },
      write(data) { log(data); },
    }

    console.log(transport);

    const ldOptions = {
      transport: transport,
      baudrate: initialBaud,
      terminal: terminalInterface,
      // debugLogging: false,
    }

    const loader = new ESPLoader(ldOptions);

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

    state.port = port;
    state.transport = transport;
    state.loader = loader;
    state.chipFamily = normalized;
    elements.connectionStatus.textContent = "Connected";
    elements.chipType.textContent = normalized;
    elements.chipType.classList.remove("status__value--muted");
    log(`Connected to ${normalized}`);

    if (typeof loader.loadStub === "function") {
      try {
        log("Loading stub flasher…");
        await loader.loadStub();
      } catch (error) {
        log(`Stub flasher not loaded (continuing): ${error.message ?? error}`);
        console.warn(error);
      }
    }
    if (loader.setBaudrate) {
      log(`Switching baud rate to ${BAUD_RATE}…`);
      await loader.setBaudrate(BAUD_RATE);
    }
    elements.panelSize.disabled = false;
    updateFirmwareDisplay();
  } catch (error) {
    log(`❌ ${error.message ?? error}`);
    console.error(error);
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

elements.panelSize.addEventListener("change", () => {
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

async function flashBinary(loader, fileEntry, options) {
  if (typeof loader.writeFlash === "function") {
    log("Flashing via loader.writeFlash()…");
    const flashOptions = {
      fileArray: [fileEntry],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: typeof options?.onProgress === "function" ? options.onProgress : undefined,
      calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)).toString()
    };
    await loader.writeFlash(flashOptions);
    await loader.after();
    return;
  }
  throw new Error("This version of esptool-js does not expose a supported flashing API.");
}

async function flashSelectedFirmware() {
  if (!state.loader || !state.chipFamily || !elements.panelSize.value) {
    return;
  }
  log(`fetching firmware for ${state.chipFamily}, ${elements.panelSize.value}`);
  const firmwareEntry = FIRMWARE_MATRIX[state.chipFamily]?.[elements.panelSize.value];
  if (!firmwareEntry) {
    log("No firmware available for this selection.");
    return;
  }
  setBusy(true);
  setUploadProgress(0, true);
  try {
    const { version, firmwareUrl } = await resolveLatestFirmwareInfo(firmwareEntry.uuid);
    log(`Latest firmware version: v${version}`);

    const firmwareData = await fetchFirmware({ ...firmwareEntry, url: firmwareUrl });
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
    elements.panelSize.value = "";
    elements.panelSize.disabled = true;
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
