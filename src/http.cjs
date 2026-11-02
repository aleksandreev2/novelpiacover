"use strict";
const { parseNovelUrl, imageUrl } = require("./novelpia.cjs");
async function fetchResource(
  input,
  {
    kind = "page",
    fetchImpl = globalThis.fetch,
    maxBytes = kind === "page" ? 5 * 1024 * 1024 : 30 * 1024 * 1024,
    timeoutMs = 30000,
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(new Error("Истекло время ожидания ответа (30 секунд).")),
    timeoutMs,
  );
  let url = input;
  try {
    for (let redirect = 0; redirect <= 5; redirect++) {
      if (kind === "image") imageUrl(url);
      else parseNovelUrl(url);
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Accept:
            kind === "page"
              ? "text/html"
              : "image/png,image/jpeg,image/webp,image/*;q=0.8",
          "Cache-Control": "no-cache",
          Referer: "https://novelpia.com/",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const next = response.headers.get("location");
        if (!next) throw new Error("Сервер вернул перенаправление без ссылки.");
        url = new URL(next, url).href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const err = new Error(
          `Сервер ответил HTTP ${response.status}.${[401, 403].includes(response.status) ? " Страница недоступна без авторизации или заблокирована." : ""}`,
        );
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get("retry-after");
          err.retryAfterMs = Math.min(
            24 * 3600000,
            Math.max(
              60000,
              /^\d+$/.test(retry || "")
                ? Number(retry) * 1000
                : Date.parse(retry) - Date.now() || 60000,
            ),
          );
        }
        throw err;
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new Error("Превышен допустимый размер ответа.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Сервер вернул пустой ответ.");
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes)
            throw new Error("Превышен допустимый размер ответа.");
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    }
    throw new Error("Слишком много перенаправлений.");
  } catch (e) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { fetchResource };
