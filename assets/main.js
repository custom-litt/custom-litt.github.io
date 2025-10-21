const FIRMWARE_MATRIX = {
  esp32: {
    "13": {
      url: "./api/v1/bin/firmware/0c831d15-4877-4fb6-9ca7-b737ca4fdb48/v0.0.1/firmware.bin",
      address: 0x0,
      label: "ESP32 · 13 inch"
    },
    "15": {
      url: "./api/v1/bin/firmware/2e40e56e-d0ed-4568-9879-c6938f52e773/v0.0.1/firmware.bin",
      address: 0x0,
      label: "ESP32 · 15 inch"
    }
  },
  esp32s3: {
    "13": {
      url: "./api/v1/bin/firmware/2e40e56e-d0ed-4568-9879-c6938f52e773/v0.0.1/firmware.bin",
      address: 0x0,
      label: "ESP32-S3 · 13 inch"
    },
    "15": {
      url: "./api/v1/bin/firmware/0c831d15-4877-4fb6-9ca7-b737ca4fdb48/v0.0.1/firmware.bin",
      address: 0x0,
      label: "ESP32-S3 · 15 inch"
    }
  }
};

const SUPPORTS_WEB_SERIAL = "serial" in navigator;
const ESPLIB_URL = "https://cdn.jsdelivr.net/npm/esptool-js@0.9.1/dist/web/index.js";
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
  firmwareUrl: document.getElementById("firmwareUrl"),
  log: document.getElementById("log"),
  logTemplate: document.getElementById("logLineTemplate")
};

/** @typedef {{
  module: any,
  port: any,
  transport: any,
  loader: any,
  chipFamily: string | null,
  busy: boolean
}} MutableState */

/** @type {MutableState} */
const state = {
  module: null,
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
  elements.flashButton.disabled = busy || !state.loader || !elements.panelSize.value;
  elements.disconnectButton.disabled = busy || !state.port;
  elements.panelSize.disabled = busy || !state.chipFamily;
}

function updateFirmwareDisplay() {
  const size = elements.panelSize.value;
  const family = state.chipFamily;
  if (!size || !family) {
    elements.firmwareUrl.textContent = "—";
    elements.flashButton.disabled = true;
    return;
  }
  const entry = FIRMWARE_MATRIX?.[family]?.[size];
  if (!entry) {
    elements.firmwareUrl.textContent = "No firmware available for this combination";
    elements.flashButton.disabled = true;
    return;
  }
  elements.firmwareUrl.textContent = entry.url;
  elements.flashButton.disabled = state.busy;
}

async function importEsptool() {
  if (state.module) {
    return state.module;
  }
  log(`Loading esptool-js module…`);
  const module = await import(ESPLIB_URL);
  state.module = module;
  log(`esptool-js v${module.VERSION ?? "(unknown)"} loaded`);
  return module;
}

function normalizeChipFamily(rawName) {
  if (!rawName) return null;
  const lowered = String(rawName).toLowerCase();
  if (lowered.includes("s3")) return "esp32s3";
  if (lowered.includes("esp32")) return "esp32";
  return null;
}

async function openTransport(module, port) {
  const { Transport } = module;
  if (!Transport) {
    throw new Error("esptool-js Transport helper is unavailable in this build");
  }
  const transport = new Transport(port);
  if (transport.open) {
    await transport.open({ baudrate: INITIAL_BAUD_RATE });
  } else if (transport.connect) {
    await transport.connect({ baudrate: INITIAL_BAUD_RATE });
  }
  return transport;
}

async function connectToDevice() {
  if (!SUPPORTS_WEB_SERIAL) return;
  setBusy(true);
  try {
    const module = await importEsptool();
    const port = await navigator.serial.requestPort();
    log("Serial port selected. Opening connection…");
    const transport = await openTransport(module, port);
    const { ESPLoader } = module;
    if (!ESPLoader) {
      throw new Error("esptool-js ESPLoader class is not available");
    }
    const loader = new ESPLoader(transport, {
      log,
      debug: false,
      useStub: true
    });
    log("Connecting to ESP32…");
    if (loader.connect) {
      await loader.connect();
    } else if (loader.main) {
      await loader.main();
    } else if (loader.initialize) {
      await loader.initialize();
    }
    let chipName = null;
    if (loader.chip) {
      if (typeof loader.chip.getChipDescription === "function") {
        try {
          chipName = await loader.chip.getChipDescription();
        } catch (error) {
          log(`Unable to read chip description: ${error.message ?? error}`);
        }
      }
      chipName = chipName ?? loader.chip.CHIP_NAME ?? loader.chip.name ?? null;
    }
    chipName = chipName ?? loader.CHIP_NAME ?? loader.chipName ?? null;
    const normalized = normalizeChipFamily(chipName);
    if (!normalized) {
      throw new Error(`Unsupported chip detected: ${chipName ?? "unknown"}`);
    }
    state.port = port;
    state.transport = transport;
    state.loader = loader;
    state.chipFamily = normalized;
    elements.connectionStatus.textContent = "Connected";
    elements.chipType.textContent = chipName ?? normalized.toUpperCase();
    elements.chipType.classList.remove("status__value--muted");
    log(`Connected to ${chipName}`);

    if (loader.loadStub) {
      log("Loading stub flasher…");
      await loader.loadStub();
    }
    if (loader.setBaudrate) {
      log(`Switching baud rate to ${BAUD_RATE}…`);
      await loader.setBaudrate(BAUD_RATE);
    }
    elements.panelSize.disabled = false;
    updateFirmwareDisplay();
  } catch (error) {
    log(`❌ ${error.message ?? error}`);
    await disconnectDevice();
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
  const response = await fetch(entry.url);
  if (!response.ok) {
    throw new Error(`Failed to download firmware (${response.status} ${response.statusText})`);
  }
  const buffer = await response.arrayBuffer();
  log(`Firmware size: ${(buffer.byteLength / 1024).toFixed(1)} KiB`);
  return new Uint8Array(buffer);
}

async function flashBinary(loader, fileEntry, options) {
  if (typeof loader.flash === "function") {
    log("Flashing via loader.flash()…");
    const files = [fileEntry];
    const flashOptions = {
      fileArray: files,
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: options.onProgress
    };
    return loader.flash(files, flashOptions);
  }
  if (typeof loader.writeFlash === "function") {
    log("Flashing via loader.writeFlash()…");
    return loader.writeFlash([fileEntry], {
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: options.onProgress
    });
  }
  if (typeof loader.flashData === "function") {
    log("Flashing via loader.flashData()…");
    return loader.flashData(fileEntry.data, fileEntry.address, false, options.onProgress);
  }
  throw new Error("This version of esptool-js does not expose a supported flashing API.");
}

async function flashSelectedFirmware() {
  if (!state.loader || !state.chipFamily || !elements.panelSize.value) {
    return;
  }
  const firmwareEntry = FIRMWARE_MATRIX[state.chipFamily]?.[elements.panelSize.value];
  if (!firmwareEntry) {
    log("No firmware available for this selection.");
    return;
  }
  setBusy(true);
  try {
    const firmwareData = await fetchFirmware(firmwareEntry);
    let lastProgress = -1;
    const progressHandler = (value) => {
      const percent = Math.round(Number(value ?? 0) * 100);
      if (percent !== lastProgress) {
        lastProgress = percent;
        log(`Flash progress: ${percent}%`);
      }
    };
    await flashBinary(state.loader, {
      data: firmwareData,
      address: firmwareEntry.address,
      fileName: firmwareEntry.url.split("/").pop() ?? "firmware.bin"
    }, {
      onProgress: progressHandler
    });
    if (state.loader?.hardReset) {
      log("Resetting device…");
      await state.loader.hardReset();
    } else if (state.loader?.reset) {
      log("Resetting device…");
      await state.loader.reset();
    }
    log("✅ Flash complete. The device should reboot shortly.");
  } catch (error) {
    log(`❌ Flash failed: ${error.message ?? error}`);
  } finally {
    setBusy(false);
  }
}

elements.flashButton.addEventListener("click", () => {
  if (!state.busy) {
    flashSelectedFirmware();
  }
});

async function disconnectDevice() {
  if (state.busy) return;
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
