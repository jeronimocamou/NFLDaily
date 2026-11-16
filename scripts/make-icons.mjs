// Writes the app icons used by the web app manifest and favicon.
import { writeFileSync } from "node:fs";
import { renderIconPng } from "../lib/og.js";

for (const [name, scale] of [["icon-192.png", 3], ["icon-512.png", 8]]) {
  writeFileSync(new URL(`../site/${name}`, import.meta.url), renderIconPng(scale));
  console.log(`wrote site/${name}`);
}
