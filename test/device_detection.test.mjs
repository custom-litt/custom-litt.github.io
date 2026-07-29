// Node-runnable TDD tests for assets/device_detection.js (pure logic).
// Run: node test/device_detection.test.mjs
import { VID, portBridge, classifyConnectError, detectPlatform, driverLinkFor,
         normalizeChipFamily, describeHardware, isPortChipMismatch, webSerialStatus,
         hardwareTipFor, parseSha256, bytesToHex, planBaudRates,
         FIRMWARE_MATRIX, modelOptionsFor } from "../assets/device_detection.js";
import { makeFakePort, serialError } from "./fake-serial.js";

const UA = {
  macSafari:    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  macChrome:    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  winChrome:    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  androidChrome:"Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
};

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log("  ✓", n); };
const bad = (n, e) => { fail++; console.log("  ✗", n, "—", e?.message ?? e); };
function test(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m = "assertion failed") { if (!c) throw new Error(m); }
const eq = (a, b, m) => assert(Object.is(a, b), m ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// --- VID + portBridge ---
test("VID constants", () => { eq(VID.SILABS, 0x10c4); eq(VID.ESPRESSIF, 0x303a); });
test("portBridge: 0x303a -> s3-native, driverless, new", () => {
  const b = portBridge(makeFakePort({ vid: 0x303a }));
  eq(b.bridge, "s3-native"); eq(b.driverNeeded, false); eq(b.gen, "new");
});
test("portBridge: 0x10c4 -> cp210x, driver needed, ambiguous gen", () => {
  const b = portBridge(makeFakePort({ vid: 0x10c4 }));
  eq(b.bridge, "cp210x"); eq(b.driverNeeded, true); eq(b.gen, "ambiguous");
});
test("portBridge: unknown VID -> unknown", () => {
  eq(portBridge(makeFakePort({ vid: 0x1a86 })).bridge, "unknown");
});

// --- classifyConnectError ---
test("classify NotFoundError -> no-port", () => eq(classifyConnectError(serialError("NotFoundError")), "no-port"));
test("classify SecurityError -> blocked", () => eq(classifyConnectError(serialError("SecurityError")), "blocked"));
test("classify NotAllowedError -> blocked", () => eq(classifyConnectError(serialError("NotAllowedError")), "blocked"));
test("classify NetworkError -> busy", () => eq(classifyConnectError(serialError("NetworkError")), "busy"));
test("classify InvalidStateError -> busy", () => eq(classifyConnectError(serialError("InvalidStateError")), "busy"));
test("classify 'already open' message -> busy", () => eq(classifyConnectError(serialError("Whatever", "The port is already open.")), "busy"));
test("classify unknown -> unknown", () => eq(classifyConnectError(serialError("WeirdError")), "unknown"));
test("classify null -> unknown", () => eq(classifyConnectError(null), "unknown"));

// download-mode: the board didn't answer the bootloader sync handshake (esptool-js phrasings).
// Fix is BOOT/RESET, so these must win over the generic name-based "busy".
test("classify 'Failed to connect with the device' -> download-mode", () =>
  eq(classifyConnectError(serialError("Error", "Failed to connect with the device")), "download-mode"));
test("classify 'Invalid head of packet' -> download-mode", () =>
  eq(classifyConnectError(serialError("Error", "Invalid head of packet (0x00): Possible serial noise or corruption.")), "download-mode"));
test("classify 'No serial data received.' -> download-mode", () =>
  eq(classifyConnectError(serialError("Error", "No serial data received.")), "download-mode"));
test("classify 'Read timeout exceeded' -> download-mode", () =>
  eq(classifyConnectError(serialError("Error", "Read timeout exceeded")), "download-mode"));
test("classify 'needs to be in download mode' -> download-mode", () =>
  eq(classifyConnectError(serialError("Error", "This chip needs to be in download mode.")), "download-mode"));

// flaky: the device physically dropped off the USB bus mid-handshake (charge-only cable / weak power),
// which Web Serial reports as a "device lost/disconnected" error — distinct from a port held by another app.
test("classify 'The device has been lost.' -> flaky", () =>
  eq(classifyConnectError(serialError("NetworkError", "The device has been lost.")), "flaky"));
test("classify 'The device has been disconnected.' -> flaky", () =>
  eq(classifyConnectError(serialError("NetworkError", "The device has been disconnected.")), "flaky"));

// Regression: bare-name NetworkError/InvalidStateError and "already open" must STAY busy,
// not get pulled into flaky/download-mode by the new message checks.
test("classify bare NetworkError still -> busy", () => eq(classifyConnectError(serialError("NetworkError")), "busy"));
test("classify bare InvalidStateError still -> busy", () => eq(classifyConnectError(serialError("InvalidStateError")), "busy"));
test("classify 'already open' still -> busy", () => eq(classifyConnectError(serialError("Error", "The port is already open.")), "busy"));

// --- detectPlatform + driverLinkFor ---
test("detect macOS Safari -> isSafari, not Chromium", () => {
  const p = detectPlatform({ ua: UA.macSafari });
  eq(p.os, "macos"); eq(p.isSafari, true); eq(p.isChromium, false);
});
test("detect macOS Chrome -> Chromium, not Safari", () => {
  const p = detectPlatform({ ua: UA.macChrome });
  eq(p.os, "macos"); eq(p.isChromium, true); eq(p.isSafari, false);
});
test("detect Windows Chrome -> windows + Chromium", () => {
  const p = detectPlatform({ ua: UA.winChrome });
  eq(p.os, "windows"); eq(p.isChromium, true);
});
test("detect Linux Firefox -> linux + Firefox", () => {
  const p = detectPlatform({ ua: UA.linuxFirefox });
  eq(p.os, "linux"); eq(p.isFirefox, true); eq(p.isChromium, false);
});
test("detect iPhone Safari -> isMobile + isSafari", () => {
  const p = detectPlatform({ ua: UA.iphoneSafari });
  eq(p.isMobile, true); eq(p.isSafari, true); eq(p.isChromium, false);
});
test("detect Android Chrome -> isMobile + Chromium", () => {
  const p = detectPlatform({ ua: UA.androidChrome });
  eq(p.isMobile, true); eq(p.isChromium, true);
});
test("detect desktop Chrome -> not mobile", () => eq(detectPlatform({ ua: UA.winChrome }).isMobile, false));
test("detect desktop Safari -> not mobile", () => eq(detectPlatform({ ua: UA.macSafari }).isMobile, false));
test("detect uaData.mobile flag respected", () =>
  eq(detectPlatform({ ua: UA.winChrome, uaData: { mobile: true } }).isMobile, true));
test("driverLinkFor windows -> SiLabs URL", () => assert(/silabs/i.test(driverLinkFor("windows"))));
test("driverLinkFor linux -> null (in-kernel)", () => eq(driverLinkFor("linux"), null));

// --- normalizeChipFamily (preserves main.js behavior) ---
test("normalizeChipFamily ESP32-S3 -> Pixlpro", () => eq(normalizeChipFamily("ESP32-S3"), "Pixlpro"));
test("normalizeChipFamily ESP32 -> Legacy Pixlpro", () => eq(normalizeChipFamily("ESP32"), "Legacy Pixlpro"));
test("normalizeChipFamily null -> null", () => eq(normalizeChipFamily(null), null));
test("normalizeChipFamily RP2040 -> null", () => eq(normalizeChipFamily("RP2040"), null));

// --- describeHardware ---
test("describeHardware Pixlpro -> new", () => {
  const d = describeHardware({ gen: "ambiguous" }, "Pixlpro");
  eq(d.gen, "new"); eq(d.label, "Pixlpro (ESP32-S3)");
});
test("describeHardware Legacy -> legacy", () => {
  const d = describeHardware({ gen: "ambiguous" }, "Legacy Pixlpro");
  eq(d.gen, "legacy"); eq(d.label, "Legacy Pixlpro (ESP32)");
});
test("describeHardware unknown -> falls back to port gen", () => {
  const d = describeHardware({ gen: "unknown" }, null);
  eq(d.gen, "unknown"); eq(d.label, "Unknown");
});

// --- isPortChipMismatch (ESP32 has no native USB) ---
test("mismatch: s3-native port + Legacy ESP32 chip -> true", () =>
  eq(isPortChipMismatch({ bridge: "s3-native" }, "Legacy Pixlpro"), true));
test("mismatch: cp210x port + Pixlpro S3 chip -> false", () =>
  eq(isPortChipMismatch({ bridge: "cp210x" }, "Pixlpro"), false));
test("mismatch: s3-native port + Pixlpro chip -> false", () =>
  eq(isPortChipMismatch({ bridge: "s3-native" }, "Pixlpro"), false));

// --- hardwareTipFor (old vs new hardware get different connect-help tips) ---
test("hardwareTipFor s3-native -> new hardware, no driver, says driver won't help", () => {
  const t = hardwareTipFor(portBridge(makeFakePort({ vid: 0x303a })));
  eq(t.gen, "new"); eq(t.needsDriver, false);
  assert(/no driver/i.test(t.tip), t.tip);
  assert(/won't help|not help/i.test(t.tip), t.tip);
});
test("hardwareTipFor cp210x -> driver-based, mentions CP210x driver", () => {
  const t = hardwareTipFor(portBridge(makeFakePort({ vid: 0x10c4 })));
  eq(t.needsDriver, true);
  assert(/CP210x/i.test(t.tip), t.tip);
});
test("hardwareTipFor unknown VID -> no tip", () => {
  const t = hardwareTipFor(portBridge(makeFakePort({ vid: 0x1a86 })));
  eq(t.tip, null);
});
test("hardwareTipFor null portInfo -> no tip, unknown gen", () => {
  const t = hardwareTipFor(null);
  eq(t.tip, null); eq(t.gen, "unknown");
});

// --- webSerialStatus ---
test("webSerialStatus supported when hasSerial true", () => {
  const s = webSerialStatus({ hasSerial: true, platform: {} });
  eq(s.supported, true); eq(s.message, "");
});
test("webSerialStatus Firefox -> names Firefox, recommends Chrome", () => {
  const s = webSerialStatus({ hasSerial: false, platform: { isFirefox: true } });
  eq(s.supported, false);
  assert(/Firefox/.test(s.message), s.message);
  assert(/Chrome/.test(s.message), s.message);
});
test("webSerialStatus Safari -> names Safari, recommends Chrome", () => {
  const s = webSerialStatus({ hasSerial: false, platform: { isSafari: true } });
  eq(s.supported, false);
  assert(/Safari/.test(s.message), s.message);
  assert(/Chrome/.test(s.message), s.message);
});
test("webSerialStatus mobile -> says phones/tablets won't work, use a computer", () => {
  const s = webSerialStatus({ hasSerial: false, platform: { isMobile: true } });
  eq(s.supported, false);
  assert(/phone|tablet/i.test(s.message), s.message);
  assert(/desktop|laptop|computer/i.test(s.message), s.message);
});
test("webSerialStatus mobile beats Safari (iPhone) -> device-focused message", () => {
  const s = webSerialStatus({ hasSerial: false, platform: { isMobile: true, isSafari: true } });
  assert(/phone|tablet/i.test(s.message), s.message);
});
test("webSerialStatus other unsupported -> recommends Chrome (Edge noted)", () => {
  const s = webSerialStatus({ hasSerial: false, platform: {} });
  eq(s.supported, false);
  assert(/Chrome/.test(s.message), s.message);
  assert(/Edge/.test(s.message), s.message);
});

// --- parseSha256 + bytesToHex (firmware integrity verification) ---
const REAL = "8d082b7d8552dd9b1f9947a0462e702c361862dcaecc4dffb7d0d911863183e8";
test("parseSha256: bare 64-hex hash", () => eq(parseSha256(REAL), REAL));
test("parseSha256: trims surrounding whitespace/newlines", () => eq(parseSha256(`  ${REAL}\n`), REAL));
test("parseSha256: lowercases uppercase hex", () =>
  eq(parseSha256("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789"),
     "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"));
test("parseSha256: 'sha256sum'-style 'hash  filename' line", () =>
  eq(parseSha256(`${REAL}  firmware_full.bin`), REAL));
test("parseSha256: too short -> null", () => eq(parseSha256("deadbeef"), null));
test("parseSha256: non-hex 64 chars -> null", () => eq(parseSha256(`zz${REAL.slice(2)}`), null));
test("parseSha256: 65 hex chars (no boundary) -> null", () => eq(parseSha256(`${REAL}a`), null));
test("parseSha256: empty -> null", () => eq(parseSha256(""), null));
test("parseSha256: non-string -> null", () => eq(parseSha256(null), null));

test("bytesToHex: Uint8Array -> lowercase, zero-padded hex", () =>
  eq(bytesToHex(new Uint8Array([0x00, 0xff, 0x10, 0xab])), "00ff10ab"));
test("bytesToHex: accepts ArrayBuffer (crypto.subtle.digest output shape)", () =>
  eq(bytesToHex(new Uint8Array([0x01, 0x02, 0xff]).buffer), "0102ff"));
test("bytesToHex: empty -> empty string", () => eq(bytesToHex(new Uint8Array([])), ""));

// --- FIRMWARE_MATRIX + modelOptionsFor (which products each module can be flashed as) ---
// The hardware ID is embedded into the firmware image at build time (EMBED_TXTFILES
// hardware_id.txt), so it identifies the FIRMWARE, not the board — a device in download mode
// cannot be asked what product it is. Only the chip is detectable, so the operator picks the
// model, and these UUIDs are the only thing standing between a clock and panel firmware.
// Source of truth: pixlpro/firmware/out/README.md.
const HWID = {
  "13-2022-v3":          "ac79bb5e-dc0c-4799-bcc4-2587fd898faf",
  "15-2022-v3":          "d89d2bbd-d65c-4ec0-abd7-9967e0a461dd",
  "bandgap-gamma-13":    "0c80a421-3cfb-4a5e-b93e-3f0024689582",
  "bandgap-gamma-15":    "2e40e56e-d0ed-4568-9879-c6938f52e773",
  "bandgap-cable-hider": "3481efbd-8ada-42e4-ab3f-05968546e82d",
  "bandgap-gamma-clock": "8949218b-432c-4ffe-8f7d-73e80421fd1f",
};

test("matrix: legacy module offers exactly 13 and 15 inch", () =>
  eq(modelOptionsFor("Legacy Pixlpro").map((o) => o.value).join(","), "13,15"));
test("matrix: new module offers 13, 15 and clock in that order", () =>
  eq(modelOptionsFor("Pixlpro").map((o) => o.value).join(","), "13,15,clock"));

// Cable hider stays wired up but unlisted: its firmware isn't published to api/ yet, so
// offering it would only ever resolve "Unavailable". Deleting the entry would mean rebuilding
// it later from scratch; hiding it means dropping `hidden` re-enables it in one line.
test("matrix: cable-hider is still plumbed in, just hidden", () => {
  const entry = FIRMWARE_MATRIX["Pixlpro"]["cable-hider"];
  assert(entry, "cable-hider entry must remain in the matrix");
  eq(entry.hidden, true);
});
test("matrix: cable-hider is absent from the dropdown while hidden", () =>
  assert(!modelOptionsFor("Pixlpro").some((o) => o.value === "cable-hider"),
    "hidden model must not be offered"));
test("modelOptionsFor: hidden entries are filtered out generally", () => {
  const visible = modelOptionsFor("Pixlpro").map((o) => o.value);
  for (const [key, entry] of Object.entries(FIRMWARE_MATRIX["Pixlpro"])) {
    eq(visible.includes(key), !entry.hidden, `${key} visibility should follow its hidden flag`);
  }
});

test("matrix: legacy 13/15 map to the 2022-v3 hardware ids", () => {
  eq(FIRMWARE_MATRIX["Legacy Pixlpro"]["13"].uuid, HWID["13-2022-v3"]);
  eq(FIRMWARE_MATRIX["Legacy Pixlpro"]["15"].uuid, HWID["15-2022-v3"]);
});
test("matrix: new 13/15 map to the bandgap-gamma hardware ids", () => {
  eq(FIRMWARE_MATRIX["Pixlpro"]["13"].uuid, HWID["bandgap-gamma-13"]);
  eq(FIRMWARE_MATRIX["Pixlpro"]["15"].uuid, HWID["bandgap-gamma-15"]);
});
test("matrix: cable-hider is the 54x8 two-board product, not the testing single", () => {
  eq(FIRMWARE_MATRIX["Pixlpro"]["cable-hider"].uuid, HWID["bandgap-cable-hider"]);
  assert(FIRMWARE_MATRIX["Pixlpro"]["cable-hider"].uuid !== "910105d3-3c73-4072-ad82-59c10be6993c",
    "must not ship the bring-up/testing single-board firmware");
});
test("matrix: clock maps to bandgap-gamma-clock", () =>
  eq(FIRMWARE_MATRIX["Pixlpro"]["clock"].uuid, HWID["bandgap-gamma-clock"]));

const allEntries = Object.entries(FIRMWARE_MATRIX)
  .flatMap(([family, models]) => Object.entries(models).map(([k, v]) => [`${family}/${k}`, v]));

test("matrix: every entry has a well-formed uuid", () => {
  for (const [where, entry] of allEntries) {
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.uuid),
      `${where} has a malformed uuid: ${entry.uuid}`);
  }
});
test("matrix: no uuid is reused across products", () => {
  const seen = new Map();
  for (const [where, entry] of allEntries) {
    assert(!seen.has(entry.uuid), `${entry.uuid} used by both ${seen.get(entry.uuid)} and ${where}`);
    seen.set(entry.uuid, where);
  }
});
test("matrix: every entry has a flash address and a dropdown label", () => {
  for (const [where, entry] of allEntries) {
    assert(Number.isFinite(entry.address), `${where} has no numeric address`);
    assert(typeof entry.label === "string" && entry.label.length > 0, `${where} has no label`);
  }
});
test("matrix: legacy and new never share a hardware id", () => {
  const legacy = new Set(Object.values(FIRMWARE_MATRIX["Legacy Pixlpro"]).map((e) => e.uuid));
  for (const entry of Object.values(FIRMWARE_MATRIX["Pixlpro"])) {
    assert(!legacy.has(entry.uuid), `${entry.uuid} appears in both module generations`);
  }
});

test("modelOptionsFor: unknown family -> no options", () => eq(modelOptionsFor("Nope").length, 0));
test("modelOptionsFor: null family -> no options", () => eq(modelOptionsFor(null).length, 0));
test("modelOptionsFor: labels are human-readable, not raw keys", () => {
  const clock = modelOptionsFor("Pixlpro").find((o) => o.value === "clock");
  eq(clock.label, "Clock");
});
test("modelOptionsFor: every option resolves back to a matrix entry", () => {
  for (const family of Object.keys(FIRMWARE_MATRIX)) {
    for (const opt of modelOptionsFor(family)) {
      assert(FIRMWARE_MATRIX[family][opt.value], `${family}/${opt.value} has no firmware entry`);
    }
  }
});

// --- planBaudRates (serial link speed for a flash session) ---
// Regression cover for the double baud switch that broke every legacy (CP210x) flash:
// ESPLoader.main() switches to `baudrate` itself when it differs from `romBaudrate`, so a
// caller that ALSO calls changeBaud() sends the switch twice. The second one tells the stub
// its current baud is 115200 while the link already runs at 921600, the stub rescales its
// UART divider by 115200/921600, and every later command times out with "No serial data
// received." `switchedByMain` is the flag that keeps callers out of that business.
const plan13 = planBaudRates(portBridge(makeFakePort({ vid: 0x10c4 })));
const planS3 = planBaudRates(portBridge(makeFakePort({ vid: 0x303a })));

test("planBaudRates: cp210x syncs at 115200", () => eq(plan13.romBaudrate, 115200));
test("planBaudRates: cp210x flashes at 921600", () => eq(plan13.baudrate, 921600));
test("planBaudRates: cp210x switch is owned by loader.main()", () => eq(plan13.switchedByMain, true));

test("planBaudRates: s3-native syncs at 115200", () => eq(planS3.romBaudrate, 115200));
test("planBaudRates: s3-native stays at 115200 (USB speed is fixed)", () => eq(planS3.baudrate, 115200));
test("planBaudRates: s3-native never switches baud", () => eq(planS3.switchedByMain, false));

test("planBaudRates: switchedByMain is exactly baudrate !== romBaudrate", () => {
  for (const p of [plan13, planS3]) eq(p.switchedByMain, p.baudrate !== p.romBaudrate);
});
test("planBaudRates: unknown bridge is treated as a UART bridge", () =>
  eq(planBaudRates(portBridge(makeFakePort({ vid: 0x1a86 }))).baudrate, 921600));
test("planBaudRates: missing port info doesn't throw", () =>
  eq(planBaudRates(null).romBaudrate, 115200));
test("planBaudRates: rates are overridable", () => {
  const p = planBaudRates(portBridge(makeFakePort({ vid: 0x10c4 })), { fast: 460800, rom: 74880 });
  eq(p.baudrate, 460800); eq(p.romBaudrate, 74880); eq(p.switchedByMain, true);
});
test("planBaudRates: equal fast/rom means main() must not switch", () =>
  eq(planBaudRates(portBridge(makeFakePort({ vid: 0x10c4 })), { fast: 115200 }).switchedByMain, false));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
