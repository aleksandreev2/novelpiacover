# Version 1.1.0: title status notifications

Implement the requested status tracking in the existing serial Novelpia check. No additional page requests, browser tabs or background services. Keep the one-click Windows installer and existing archives/settings.

## Confirmed source behaviour (2026-11-02)

- Completed: `완결`, main author block `p.in-badge`, usually `span.b_comp`. Example: https://novelpia.com/novel/211530.
- Stopped: `연재중단`, main author block `p.in-badge`. Example: https://novelpia.com/novel/330733.
- Ongoing: complete main author/badge block without either terminal badge. Example: https://novelpia.com/novel/434103. This is inferred from the main page structure; there is no separate ongoing badge on the checked page.
- A word such as `휴재` in a title, synopsis, comment or announcement does not establish a separate lifecycle status. Do not infer permanent abandonment or a time threshold from lack of updates. PLUS, exclusive/free and age labels are separate dimensions.
- Missing/unrecognised structure means unknown, preserving the previous known status. Do not generate resumed/completed notifications from an error/login page or unrelated recommendation badge.

## Behaviour

Global configurable Windows status notifications: enabled, destination statuses (completed, stopped, ongoing/resumed), sound. Defaults: enabled with all three destinations and sound. Cover notifications retain their existing independent switch. Each novel can inherit the global status policy or override enabled/destinations.

The first known status, including on upgrade from 1.0, establishes a baseline with no change toast. Later known-to-known changes persist once, record a bounded history (200 entries per title), then notify if allowed. Unchanged checks, unknown reads and restarts do not repeat events. Cover-download failures must not suppress an otherwise verified status change. Muting events still advances the baseline and retains history.

Native Electron Windows Notification, installed AppUserModelID matched to the installer. Click opens the corresponding novel in the application. Settings include a native test notification and a link to Windows notification settings. Explain that Windows Focus/Do Not Disturb can suppress banners.

UI retains existing palette/layout. Show lifecycle status separately from check/download health. Add per-title notification controls and compact change history without displacing cover history. Global controls live in settings. Default UI data must be real or empty.

## Implementation plan

1. `src/status.cjs`, tests: main-block status parsing, false-positive/missing-block cases, validated policies and notification text.
2. `src/store.cjs`, `src/monitor.cjs`, tests: backward-compatible defaults, baseline, transitions, persistence, unknown reads, per-title policy, partial cover errors, dedup across restarts and no notification on failed commit.
3. `src/main.cjs`, preload, UI: native notifications, failure feedback, click-to-title, test/settings actions, global/per-title controls and history. Verify in Electron with isolated profile and actual Windows notification.
4. Bump app/build metadata to 1.1.0, remove hardcoded build version, add versioned setup filename, changelog, repository README and repeatable GitHub build workflow.
5. Full tests, packaged smoke and installer upgrade/data preservation check. Independent code review, regressions for important findings. Push verified source and tags to the supplied empty repository; publish v1.1.0 with Setup.exe and checksums. Keep binaries out of Git.

User already requested independent implementation and publication. Routine technical choices above are implementation decisions.
