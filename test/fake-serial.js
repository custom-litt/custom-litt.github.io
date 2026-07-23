// test/fake-serial.js
// Zero-dependency fakes for testing the flasher's Web Serial + esptool-js paths
// WITHOUT hardware or any driver state. Import into test/harness.html or a unit test.
//
// Why: removing the OS driver tests the OS, not this app. The app only reacts to
// signals (NotFoundError, a port VID, a `disconnect` event, a flash error), so we
// fabricate those signals here instead of uninstalling anything.

/** Build a DOMException-like error with a chosen .name (matches classifyConnectError). */
export function serialError(name, message = name) {
  return Object.assign(new Error(message), { name });
}

/** A fake SerialPort. getInfo() returns the chosen USB ids. */
export function makeFakePort({ vid = 0x10c4, pid = 0xea60, openBehavior = "ok" } = {}) {
  let open = false;
  return {
    getInfo: () => ({ usbVendorId: vid, usbProductId: pid }),
    async open() {
      if (openBehavior === "busy") throw serialError("NetworkError", "Failed to open serial port.");
      if (openBehavior === "already-open") throw serialError("InvalidStateError", "The port is already open.");
      open = true;
    },
    async close() { open = false; },
    async setSignals() {},
    async forget() {},
    get _open() { return open; },
    readable: null,
    writable: null,
  };
}

/** A fake navigator.serial. Inject it where your adapter reads the serial API. */
export function makeFakeSerial({ ports = [], requestBehavior = "ok", requestPort: rp } = {}) {
  const listeners = { connect: new Set(), disconnect: new Set() };
  return {
    _ports: [...ports],
    async requestPort(/* { filters } */) {
      if (typeof rp === "function") return rp();
      if (requestBehavior === "no-port") throw serialError("NotFoundError", "No port selected by the user.");
      if (requestBehavior === "blocked") throw serialError("SecurityError", "Web Serial blocked by policy.");
      if (this._ports.length) return this._ports[0];
      throw serialError("NotFoundError", "No port selected by the user.");
    },
    async getPorts() { return [...this._ports]; },
    addEventListener(type, fn) { listeners[type]?.add(fn); },
    removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    // --- test helpers (not part of the real API) ---
    _emit(type, port) { listeners[type]?.forEach((fn) => fn({ type, target: port ?? null, port })); },
    _addPort(port) { this._ports.push(port); this._emit("connect", port); },
    _removePort(port) {
      this._ports = this._ports.filter((p) => p !== port);
      this._emit("disconnect", port);
    },
  };
}

/** A fake esptool-js loader: resolves a chip name; optional flash failure behaviors. */
export function makeFakeLoader({ chipName = "ESP32", flash = "ok", flashSizeBytes = 4 * 1024 * 1024 } = {}) {
  return {
    chip: { CHIP_NAME: chipName },
    async main() { return chipName; },
    async loadStub() {},
    async setBaudrate() {},
    async getFlashSize() { return flashSizeBytes; },
    async writeFlash(opts) {
      const total = 1000;
      for (let w = 0; w <= total; w += 200) {
        opts?.reportProgress?.(0, w, total);
        if (flash === "drop" && w >= 400) throw serialError("NetworkError", "Device disconnected.");
        await new Promise((r) => setTimeout(r, 1));
      }
      if (flash === "md5") throw new Error("MD5 of file does not match data in flash!");
    },
    async after() {},
    async disconnect() {},
  };
}

/** A fake Transport wrapping a fake port (matches esptool-js `new Transport(port, tracing)`). */
export function makeFakeTransport(port = makeFakePort()) {
  return { device: port, async connect() {}, async disconnect() {}, async close() {} };
}
