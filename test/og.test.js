import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareCode, renderOgPng } from "../lib/og.js";

test("share codes are validated", () => {
  assert.deepEqual(parseShareCode("16-410-ggmlb"), { number: 16, score: 410, grid: "ggmlb" });
  for (const bad of ["", "16-410", "16-501-ggggg", "16-410-ggggx", "16-410-gggggg", "<script>", null]) {
    assert.equal(parseShareCode(bad), null, String(bad));
  }
});

test("preview images are 1200x630 PNGs", () => {
  for (const share of [null, parseShareCode("16-410-ggmlb")]) {
    const png = renderOgPng(share);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.ok(png.length < 100_000);
  }
});
