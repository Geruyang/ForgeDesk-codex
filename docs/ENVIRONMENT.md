# Implementation Environment

Recorded 2026-10-14 Asia/Shanghai. This machine, not the earlier plan author's machine.

| Dependency | Observed |
| --- | --- |
| Windows | Windows 11 Home, x64, build 26200 |
| Node | 24.21.0 |
| npm | 11.19.0 |
| Codex | 0.162.0-alpha.17.2, official desktop-distributed executable |
| Electron | 44.7.2, exact dependency |
| Product model list | Real isolated handshake returned 8 models; inference not yet verified |
| Product authentication | Official account login selected by user; separate engine home, pending completion |
| Windows sandbox | Explicit unelevated mode returned readiness ready and sandbox echo succeeded; see ENGINE.md for boundaries |
| Hardware | User deferred selection; no COM port/recognized probe or supported flashing/compiler tools on PATH |
| Process ownership | Bundled C# Windows Job Object supervisor; real parent/child/grandchild tests |

Engine hashes and provenance are in `vendor/codex/manifest.json`; process supervisor hash is in `vendor/process-host/manifest.json`.
No credentials are recorded here. No administrator configuration, device write, external publishing, or account-token reuse was performed.

All acceptance run data for this task is set with `FORGEDESK_DATA_DIR` under the project `.runtime` folder. Ordinary installations without this override use a product-specific user data directory. Neither location falls back to the existing Codex client home.
