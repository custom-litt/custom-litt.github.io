// Zero-dependency static dev server for local testing.
// Serves the repo root over http://localhost — which browsers treat as a secure
// context, so the Web Serial flasher works exactly as it does on the deployed site.
// Usage: node scripts/dev-server.mjs  (or: npm run dev)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize, sep } from "node:path";

// Trailing separator stripped so the `startsWith(ROOT + sep)` traversal guard below matches.
const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]+$/, "");
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".md": "text/markdown; charset=utf-8",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".size": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    // Resolve inside ROOT and reject any path traversal escape.
    const filePath = normalize(join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end(`404 Not Found: ${pathname}`);
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(`500 ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dev server running → http://localhost:${PORT}`);
  console.log(`Serving ${ROOT}`);
  console.log("Press Ctrl+C to stop.");
});
