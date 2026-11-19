// Produktionsserver: serverar den byggda sajten (dist/) och /api/chat.
// Inga beroenden – bara Node. Startas av Dockerfile med `node server/serve.mjs`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { handleChat } from "./chat-proxy.mjs";

const PORT = Number(process.env.PORT || 3000);
const DIST = resolve(process.env.DIST_DIR || "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
};

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(DIST, path));
  if (!(file + sep).startsWith(DIST + sep)) {
    res.writeHead(400);
    return res.end();
  }
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info) file = join(DIST, "index.html"); // SPA: okända sökvägar → index.html
  const body = await readFile(file);
  const hashed = file.startsWith(join(DIST, "assets") + sep);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (pathname === "/api/chat") return await handleChat(req, res);
    if (pathname === "/healthz") return res.end("ok");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    return await serveStatic(req, res);
  } catch (error) {
    console.error("server:", error?.name, error?.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => console.log(`Lyssnar på http://localhost:${PORT}`));
