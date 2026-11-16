// Writes site/og.png, the generic share preview for the home page.
import { writeFileSync } from "node:fs";
import { renderOgPng } from "../lib/og.js";

writeFileSync(new URL("../site/og.png", import.meta.url), renderOgPng(null));
console.log("wrote site/og.png");
