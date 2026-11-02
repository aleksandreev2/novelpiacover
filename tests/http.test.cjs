const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fetchResource } = require("../src/http.cjs");
const url = "https://novelpia.com/novel/1";
test("decodes UTF-8 page bytes correctly", async () => {
  const r = await fetchResource(url, {
    fetchImpl: async () =>
      new Response("소꿉친구", { headers: { "Content-Type": "text/html" } }),
  });
  assert.equal(r.toString("utf8"), "소꿉친구");
});
test("rejects redirect outside allowed hosts before requesting it", async () => {
  let calls = 0;
  await assert.rejects(
    fetchResource(url, {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.com/imagebox/cover/a" },
        });
      },
    }),
    /домен|ссылк/i,
  );
  assert.equal(calls, 1);
});
test("caps actual streamed bytes even without Content-Length", async () => {
  await assert.rejects(
    fetchResource(url, {
      maxBytes: 3,
      fetchImpl: async () => new Response("12345"),
    }),
    /размер/i,
  );
});
test("exposes 429 retry-after and fails access denied pages", async () => {
  await assert.rejects(
    fetchResource(url, {
      fetchImpl: async () =>
        new Response("", { status: 429, headers: { "Retry-After": "120" } }),
    }),
    (e) => e.retryAfterMs === 120000,
  );
  await assert.rejects(
    fetchResource(url, {
      fetchImpl: async () => new Response("", { status: 403 }),
    }),
    /403/,
  );
});
test("timeout aborts a pending network request", async () => {
  await assert.rejects(
    fetchResource(url, {
      timeoutMs: 20,
      fetchImpl: (_u, { signal }) =>
        new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    }),
    /время/i,
  );
});
