// Node-runnable TDD tests for assets/device_detection.js (pure logic).
// Run: node test/device_detection.test.mjs
import { VID, portBridge, classifyConnectError, detectPlatform, driverLinkFor,
         normalizeChipFamily, describeHardware, isPortChipMismatch, webSerialStatus,
         hardwareTipFor, parseSha256, bytesToHex } from "../assets/device_detection.js";
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
