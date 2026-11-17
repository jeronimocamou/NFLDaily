import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareCode, renderOgPng } from "../lib/og.js";

test("share codes are validated", () => {
  assert.deepEqual(parseShareCode("17-7-75-9-gmwggmgt"), { number: 17, points: 7, yards: 75, plays: 9, codes: "gmwggmgt" });
  assert.equal(parseShareCode("17-0-12-6-wmwwmw").yards, 12);
  for (const bad of ["", "16-410-ggmlb", "17-5-75-9-gm", "17-7-99-9-gm", "17-7-75-200-gm", "17-7-75-9-zz", "<script>", null]) {
    assert.equal(parseShareCode(bad), null, String(bad));
  }
});

test("preview images are 1200x630 PNGs", () => {
  for (const share of [null, parseShareCode("17-7-75-9-gmwggmgt"), parseShareCode("17-0-12-6-wmwwmw"), parseShareCode("17-7-75-4-gwbt")]) {
    const png = renderOgPng(share);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.ok(png.length < 100_000);
  }
});
