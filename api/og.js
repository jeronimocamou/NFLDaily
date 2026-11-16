// GET /api/og?c=16-410-ggmlb -> 1200x630 PNG preview for a shared score.
// Without a valid code, returns the generic NFL Daily card.
import { parseShareCode, renderOgPng } from "../lib/og.js";

export default function handler(req, res) {
  const code = new URL(req.url, "http://x").searchParams.get("c");
  const png = renderOgPng(parseShareCode(code));
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/png");
  // The image for a given code never changes.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(png);
}
