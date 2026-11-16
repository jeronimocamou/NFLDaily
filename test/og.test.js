import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareCode, renderOgPng } from "../lib/og.js";

test("share codes are validated", () => {
  assert.deepEqual(parseShareCode("17-7-75-48-gmwgtp"), { number: 17, points: 7, yards: 75, clock: 48, codes: "gmwgtp" });
  assert.equal(parseShareCode("17-0--5-0-bww").yards, -5);
  for (const bad of ["", "16-410-ggmlb", "17-5-75-48-gm", "17-7-99-48-gm", "17-7-75-200-gm", "17-7-75-48-zz", "<script>", null]) {
    assert.equal(parseShareCode(bad), null, String(bad));
  }
});

test("preview images are 1200x630 PNGs", () => {
  for (const share of [null, parseShareCode("17-7-75-48-gmwgtp"), parseShareCode("17-0-12-0-gwwbwww")]) {
    const png = renderOgPng(share);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.ok(png.length < 100_000);
  }
});
