// GET /s/:code (rewritten to /api/share?c=:code) -> a tiny page whose link
// preview shows the shared score, then sends people on to the game.
import { parseShareCode, shareLabel } from "../lib/og.js";

import { CODE_EMOJI } from "../site/drive.js";

export default function handler(req, res) {
  const code = new URL(req.url, "http://x").searchParams.get("c");
  const share = parseShareCode(code);
  if (!share) {
    res.statusCode = 302;
    res.setHeader("Location", "/");
    return res.end();
  }
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const origin = `${proto}://${host}`;
  const grid = share.codes.split("").map((t) => CODE_EMOJI[t]).join("");
  const label = shareLabel(share);
  const title = `Fourth & Daily #${share.number}: ${label[0] + label.slice(1).toLowerCase()}! ${share.yards} yds in ${share.plays} plays`;
  const desc = `${grid} ${share.yards} yards in ${share.plays} plays. Name football answers, drive down the field: can you beat it?`;
  const image = `${origin}/api/og?c=${code}`;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace("&", "&amp;")}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Fourth &amp; Daily">
<meta property="og:title" content="${title.replace("&", "&amp;")}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${origin}/s/${code}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title.replace("&", "&amp;")}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0; url=/">
</head>
<body style="background:#0f141c;color:#f4f4ec;font-family:system-ui;text-align:center;padding:40px">
<p>${title.replace("&", "&amp;")} ${grid}</p>
<p><a href="/" style="color:#ffd23f">Play today's Fourth &amp; Daily →</a></p>
</body>
</html>`);
}
