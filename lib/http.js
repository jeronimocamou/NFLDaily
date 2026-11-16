// Small helpers shared by the API functions.

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Wrap a handler: method check, JSON-only POSTs, and errors -> 500 JSON. */
export function handler(methods, fn) {
  return async (req, res) => {
    try {
      if (!methods.includes(req.method)) return send(res, 405, { error: "Method not allowed" });
      if (req.method === "POST") {
        // Requiring JSON blocks simple cross-site form posts.
        if (!(req.headers["content-type"] || "").includes("application/json")) {
          return send(res, 415, { error: "Expected JSON" });
        }
        if (typeof req.body === "string") req.body = JSON.parse(req.body || "{}");
        req.body = req.body || {};
      }
      req.query = req.query || Object.fromEntries(new URL(req.url, "http://x").searchParams);
      await fn(req, res);
    } catch (e) {
      console.error(e);
      send(res, 500, { error: "Something went wrong" });
    }
  };
}
