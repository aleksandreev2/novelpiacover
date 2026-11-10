# Rust desktop migration

The Windows release uses Rust for networking, parsing, image processing, archive storage, scheduling, tray and Windows notifications. Tauri hosts the bundled interface in WebView2. No Electron or Node runtime is shipped.

1. Keep the legacy profile location and JSON fields. Reconstruct the activity feed from dated cover and status history, including retired titles. Keep PNG paths and archive folder names intact.
2. Port URL checks, the status parser and bounded downloads, then compare the parser with the recorded Novelpia fixtures. Use the existing pixel hash and file naming convention.
3. Commit each title check with its activity events. Suppress cover notifications during the first successful capture, and route later toasts to the title using a registered local protocol.
4. Add collection grid/list, sorting by meaningful changes, status filters, theme selection, and rename events.
5. Build a Windows x64 upgrade installer, verify the bundled executable with an isolated legacy profile, and publish source plus installer.
