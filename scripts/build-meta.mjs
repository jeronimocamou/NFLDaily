// Vercel build step: link previews need absolute URLs, so point og:image at
// the production domain when Vercel tells us what it is.
import { readFileSync, writeFileSync } from "node:fs";

const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const file = new URL("../site/index.html", import.meta.url);
if (host) {
  const origin = `https://${host}`;
  const html = readFileSync(file, "utf8")
    .replace('content="/og.png"', `content="${origin}/og.png"`)
    .replace('<meta property="og:type"', `<meta property="og:url" content="${origin}/">\n  <meta property="og:type"`);
  writeFileSync(file, html);
  console.log(`og tags point at ${origin}`);
} else {
  console.log("VERCEL_PROJECT_PRODUCTION_URL not set; leaving relative og:image");
}
