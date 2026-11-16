// Local dev server: serves site/ and runs api/*.js like Vercel does.
// Usage: DATABASE_URL=postgres://... node scripts/dev.mjs [port]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const share = url.pathname.match(/^\/s\/([\w-]+)$/);
    if (share) req.url = `/api/share?c=${share[1]}`;
    const api = share ? ["", "share"] : url.pathname.match(/^\/api\/([a-z]+)$/);
    if (api) {
      const mod = await import(join(ROOT, "api", `${api[1]}.js`));
      req.query = Object.fromEntries(url.searchParams);
      let body = "";
      for await (const chunk of req) body += chunk;
      req.body = body ? body : undefined;
      return await mod.default(req, res);
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, "site", path);
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ERR_MODULE_NOT_FOUND") console.error(e);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => console.log(`NFL Daily dev server on http://localhost:${PORT}`));
