// Run with: npm test
// The API wrapper: bad input gets a clear 4xx, a database outage a 503, and
// anonymous play keeps working without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handler } from "../lib/http.js";
import answerApi from "../api/answer.js";
import puzzleApi from "../api/puzzle.js";
import { loadPuzzle, index } from "../lib/puzzles.js";

function call(fn, { method = "POST", body, url = "/", headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, body, url, headers: { "content-type": "application/json", ...headers } };
    const res = {
      statusCode: 200,
      headersSent: false,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(data) { resolve({ status: this.statusCode, body: data ? JSON.parse(data) : null }); },
    };
    fn(req, res);
  });
}

test("malformed JSON is a 400, not a crash", async () => {
  const r = await call(handler(["POST"], async () => assert.fail("should not run")), { body: "{bad" });
  assert.equal(r.status, 400);
});

test("non-object bodies become an empty object", async () => {
  for (const body of ["null", "[]", "42"]) {
    let seen;
    await call(handler(["POST"], async (req, res) => { seen = req.body; res.end("{}"); }), { body });
    assert.deepEqual(seen, {}, body);
  }
});

test("form posts and wrong methods are refused", async () => {
  const ok = handler(["POST"], async (req, res) => res.end("{}"));
  assert.equal((await call(ok, { body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await call(ok, { method: "DELETE" })).status, 405);
});

test("a database outage is a 503 with a friendly message", async () => {
  const down = handler(["GET"], async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  });
  const r = await call(down, { method: "GET" });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /try again/i);
  const bug = handler(["GET"], async () => {
    throw new TypeError("oops");
  });
  assert.equal((await call(bug, { method: "GET" })).status, 500);
});

test("anonymous play works with no database at all", async () => {
  // No DATABASE_URL in tests: the puzzle loads and answers are graded.
  const date = index.launch;
  const r = await call(puzzleApi, { method: "GET", url: `/api/puzzle?date=${date}` });
  assert.equal(r.status, 200);
  assert.ok(r.body.puzzle.rounds.length >= 10);
  assert.ok(!JSON.stringify(r.body).includes('"reveal"'), "no answers before playing");
  const round = loadPuzzle(date).rounds[0];
  const id = Object.keys(round.reveal.valid)[0];
  const a = await call(answerApi, { body: JSON.stringify({ date, round: 0, guess: id }) });
  assert.equal(a.status, 200);
  assert.equal(a.body.result.hit, true);
  const bad = await call(answerApi, { body: JSON.stringify({ date, round: 99, guess: id }) });
  assert.equal(bad.status, 400);
});
