# Novelpia Cover Archive Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. The user approved independent implementation and verification.

**Goal:** Build a Russian Windows Electron application that archives changing Novelpia covers as PNG.

**Architecture:** Sandboxed local renderer, narrow preload IPC, main-process HTTP and archive service. A serial scheduler runs independently of the window. JSON configuration and per-folder manifests persist archive metadata.

**Tech Stack:** Electron 45.2.1, sharp 0.35.5, vanilla JavaScript/CSS, Node test runner, @electron/packager 20.3.0.

**Spec:** ../../План приложения.md (approved in chat).

## Global Constraints

- Windows, Russian UI, several novels, tray on window close.
- Default interval 30 minutes; user-selected root and stable title + ID folder.
- Both thumbnail and linked original; deduplicate decoded pixels plus dimensions.
- One request at a time, timeout 30 seconds, HTML 5 MiB, images 30 MiB, decoded pixels 40 million.
- No credentials, server, hidden remote BrowserWindow, or access-control bypass.

## Review Focus

- Replacement at the same URL must create a new version.
- Partial image failure must not discard another successfully saved image.
- Missing files and interrupted manifest writes must recover without duplicate archives.
- Root changes, disk errors and restarts must preserve existing history.
- Untrusted links, redirects and IPC must not allow arbitrary requests or filesystem access.

## Task 1: Network and page extraction

Files: src/novelpia.cjs, src/http.cjs, tests/novelpia.test.cjs, tests/http.test.cjs.
Produces: parseNovelUrl(input), extractNovel(html, url), fetchResource(url, options).

- [x] Write tests: real Novelpia selectors; prioritize linked original; entity decoding; metadata fallback; invalid URLs; redirects; response and timeout limits; HTTP errors.
- [x] Run node --test tests/*.test.cjs; observe missing-feature failures.
- [x] Implement parser and bounded HTTP wrapper with injectable fetch for local tests.
- [x] Run tests; expected all pass.

## Task 2: Durable archive and scheduling

Files: src/store.cjs, src/archive.cjs, src/monitor.cjs, tests/archive.test.cjs, tests/monitor.test.cjs.
Consumes Task 1 APIs. Produces Store, Archive.save(novel, source, decoded), Monitor.add/check/update/remove/snapshot.

- [x] Write tests for same URL changed pixels, pixel deduplication, deleted-file restoration, manifest recovery, root changes, stable folder, partial failure, persisted errors/backoff, no overlapping checks, pause and resume.
- [x] Run suite and observe expected missing-feature failures.
- [x] Implement atomic settings, content-addressed PNG saves, history, serial scheduling and source-specific errors.
- [x] Run suite; expected all pass.

## Task 3: Desktop and interface

Files: src/main.cjs, src/preload.cjs, ui/index.html, ui/app.js, ui/styles.css, tests/electron-smoke.cjs.
Consumes Monitor API. Produces app window, tray, native dialogs and PNG conversion using nativeImage.

- [x] Write smoke checks for safe renderer, real image conversion, UI loading, IPC, tray hide/restore and orderly exit.
- [x] Run before app exists, observe failure.
- [x] Build Russian master/detail interface, accessible dialogs, history gallery and settings. Palette: slate #24364b, blue #2862d6, background #f3f6fa, paper #ffffff, green #247754, muted #66778d. Typography: local Segoe UI, compact controls, large cover preview.
- [x] Run core suite and Electron smoke; inspect screenshot and live Novelpia check.

## Task 4: Distribution and review

Files: package.json, scripts/package.cjs, README.md, release archive.

- [x] Package Windows x64 portable directory and ZIP.
- [x] Run packaged executable smoke plus live download twice, verify PNG signature, dimensions, restart and no duplicate saves.
- [x] Fresh independent review of entire implementation; address important findings with regression tests.
- [x] Deliver ZIP, source and Russian quick start with precise verification results.

## Execution notes

Projectless workspace: no branch or commits requested; keep reproducible source in outputs and intermediate dependencies/builds in work. Native skill shell bookkeeping scripts assume a Git repository and POSIX shell, so use this checklist and test logs instead.

Pre-flight interfaces: Tasks 2 and 3 use the exact exported signatures above. No conflicts found.

Final review: two important findings reproduced RED then fixed GREEN; 28/28 tests. Packaged live run, restart, file restoration and dedup passed. Native PNG/WebP conversion verified. No deferred review findings.
