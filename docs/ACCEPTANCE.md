# Acceptance Ledger

This ledger is a release gate, not a statement that implementation alone is accepted.

| Gate | Current state | Evidence |
| --- | --- | --- |
| T1 installed real model software task | Passed on this Windows user/host, scoped software workflow | Final installed live repair/controls/refusal/restart/export in QA.md |
| T2 real-model fixed-target installed hardware workflow | Passed jointly: 0.4.0 actual six-model-tool/four-operation chain plus separate eleven-control read-only restart/close continuation; `realModel=true`, `secondUser=false`. Original execution remains failed at its harness restart comparison | [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md); original `hardware-agent-1792076310974-ba6e7c` plus passing `readonly-continuation-1792077968892` |
| T2 historical manual fixed-target workflow | 0.3.4 run `t2-1792069554285-c061bf` passed ten controls; `realModel=false`, `secondUser=false`. Earlier 0.3.4/0.3.2 passes and failed attempts remain version-bound | [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md); historical manual manifests unchanged |
| T3 snapshot build | 0.2.1 installed fixed Node arithmetic template passed on actual second Windows SID1006; earlier primary 0.2.0 evidence retained | Real-model B run `snapshot-1791984171287`; SECOND_USER_RESULT.md |
| T3 second Windows user | Scoped B workflow, one-direction ACL canary, five Controls and child-PATH missing-tools passed; full matrix incomplete and further second-account operations paused by user | SECOND_USER_RESULT.md; SOFTWARE_ACCEPTANCE_CONTINUATION.md |
| Real isolated app-server handshake | Passed | ENGINE.md and engine smoke report |
| Real model/list | Passed | ENGINE.md; does not establish inference |
| Official product authentication | Passed | User completed official flow; public installed account state `loggedIn=true`; no credential files read |
| Fixed software verifier before/after bug fix | Module and installed UI real command execution passed | RUNNER.md and QA.md; manual fixture repair, not a model task |
| Windows NSIS install | Passed; unsigned installer, install exit 0 | Installed smoke: `output/playwright/installed-final/evidence.json` |

## Must Scenarios

| ID | Scope | Status |
| --- | --- | --- |
| M1 | Auth, isolation, credential-free diagnostics/export | Final installed official login, real inference, cross-project isolation and allowlisted exports passed |
| M2 | Approvals, rejection, reload | Final installed UI allow-once, shell cancel and MCP decline passed across reload; fixture malformed-request coverage |
| M3 | Exit, protocol errors, stop, process tree | Native Job Object and fault fixtures passed; final installed real turn stop removed waiting child PID, without replay |
| M4 | Build/test failure | Final installed original test failed with retained logs; model repair passed unchanged fixed verifier; no general build profile accepted |
| M5 | A-level fingerprint and stale evidence | Runner and installed UI evidence expiry passed |
| M6 | Wrong device/old UART/disconnect | Offline wrong-identity/stale-frame gates and installed nonce/build-ID CDC happy path passed; physical wrong-board and disconnect matrix remains untested |
| M7 | Request-key deduplication | Separate 0.3.2 and 0.3.4 installed normal restarts returned the same terminal flash record/key without a new worker or write; interrupted/unknown physical recovery is not covered by those passes |
| M8 | Device contention | 0.3.2 and 0.3.4 second-task requests were rejected during real inspect in the same application; not cross-process or OS isolation |
| M9 | Flash shutdown/unknown | 0.3.2 and 0.3.4 graceful close requests were guarded after the erase/program marker; historical 0.3.1 unknown failure is retained. Crash, forced termination and power loss remain untested |
| M10 | Session separation and steer | Main/adapter fixtures and final installed real-model steer/project/session isolation passed |

Independent QA owns `docs/QA.md`. Original tests and command outputs must distinguish simulation, real local execution, real model inference, and real hardware.

## Installed 0.4.0 Joint Real-Model Acceptance, 2026-10-15

Runtime source `b9a61615c564ea560604503ff7190ecc5e8620f0`, scope
`real-model-fixed-target-installed-T2`. Original run
`hardware-agent-1792076310974-ba6e7c` reached six successful real model calls and
four successful/exited workers, consumed a separate native-approved grant, read
back 584,848 defined bytes with zero mismatch, verified two independent nonce128
CDC responses and checked eight exported files. Native confirmation was performed
by the coordinator on the original visible UI under explicit user delegation,
not supplied by the model or a synthesized dialog response.

The original report remains failed at the restart comparison; nine of eleven
controls passed, with restart/normal-close controls not accepted by that report.
One failed read-only continuation is retained. Separate continuation
`readonly-continuation-1792077968892` completed at `2026-10-15T15:28:47.928Z`
with all eleven controls passed, two normal installed GUI close/reopen rounds,
empty failures/page errors and exit 0. It submitted zero model turns/hardware
actions and confirmed no replay of the original run/calls/operations. Together
these distinct linked reports accept the stated scope without rewriting either
failed report. Its SHA-256 is
`995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`.

The pre-package full suite passed 402/402 and typecheck; final targeted harness
checks passed 53/53 separately, with overlap. This does not rerun all historical
manual negative controls on 0.4.0 or establish OS/same-SID isolation or a full
physical fault matrix. Second-SID verification remains paused.

## Historical Installed 0.3.4 T2 Result, 2026-10-15

Run `t2-1792067819027-e68a72` passed all ten controls with no failures/page errors, completed at `2026-10-15T12:40:46.914Z` and harness exit 0. Runtime commit: `a8973639413132e15a0acb8f171236a842c1bfd6`; evidence `output/t2/t2-1792067819027-e68a72/evidence.json`, SHA-256 `a4ee98757da188d413184974a56dab07ea84cd49e75c827d69835612be58d39d`. Package/install exited 0; coordinator final regression passed 286/286 and typecheck. Installer SHA-256 is `055b6c4abe4949c9b4999253a57edc8156ef3203ebabe5579ae050c0b2f3c01f`; installed app.asar SHA-256 is `eb5539c2d48484c7f0f0b39aa548fcc75730476144214d3005f3c0db111ddba7`.

Flash verified 584,848 defined bytes with zero readback mismatches. Independent nonce128/build-ID/UID/CRC-checked FDR1 responses advanced frames `76 -> 78`, with `168000000 / 48000000 Hz` clocks and zero camera errors/timeouts or display errors. Export checked eight files/four operations. Both normal-close records show installed GUI absence and launcher exit 0/null signal, not full-machine cleanup. Original native UI was operated by the coordinator under explicit user delegation (`automatedResponse=true`, `synthesizedDialogResponse=false`). Scope remains fixed local user-driven, `realModel=false`, `secondUser=false`; M6/M8/M9 limitations above remain unchanged.

The 79 recorded progress samples are optional telemetry, not a success criterion. Progress/scroll visibility is separately reviewed by QA and does not upgrade the hardware fault matrix.

## Historical Installed 0.3.2 T2 Result, 2026-10-15

Run `t2-1792065173815-dafb60` passed build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash normal-close guard and copied-artifact tamper refusal. It used the fixed Challenger V1/profile and visible native UI operated by the coordinator under explicit user delegation; `automatedResponse=true`, `synthesizedDialogResponse=false`. This is local user-driven acceptance with `realModel=false`, `secondUser=false`, not an autonomous product-model or second-account hardware result.

The flash receipt records 584,848 defined bytes with zero readback mismatch. Live CRC/nonce128/compiled-build-ID/UID-checked CDC responses show camera frames `53 -> 56`, SYSCLK `168000000 Hz`, PLL48 `48000000 Hz`, and zero camera errors/timeouts or display errors. Exported evidence contains eight hash-checked files/four operations. The full release hashes, plan and lifecycle boundaries are in [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md).

Historical 0.3.0 authorization timed out before any flash. Historical 0.3.1 run `t2-1792063884804-e2f11c` reached `erase_or_program_started` and ended `unknown` with `IPSR=3`; that result is not promoted by the distinct later success. Second-SID work remains paused; M6-M9 retain the limits in the table above.

Production Keil invocation uses [`-j0`](KEIL_BACKGROUND.md) with the pinned toolchain. The [same-Arm-Compiler IDE-free experiment](KEIL_HEADLESS_EQUIVALENCE.md) separately demonstrated byte-identical HEX for frozen inputs and a zero build-ID fixture. It did not flash that fixture, replace the production UV4 route or qualify an alternative GCC embedded build.

## Historical Installed 0.3.3 Failure

Installed 0.3.3 run `t2-1792066168842-c9f6aa` passed build but failed on a `state.json` rename `EPERM` before inspect worker startup. No inspect worker was started and no flash was performed. After independently confirming no worker remained, the coordinator precisely ended the residual application; that cleanup is not a normal-close pass or M9 acceptance. Failed evidence is retained at `output/t2/t2-1792066168842-c9f6aa/evidence.json`.

The distinct 0.3.4 installed run above subsequently passed with its own resource pins and evidence. That success does not rewrite this 0.3.3 failure or turn its residual-app termination into a normal-close pass.

## Historical Hardware Baseline, 2026-10-15

At this earlier checkpoint, user-confirmed Challenger V1/fireDAP was tested by the coordinator, not by the installed ForgeDesk application. Reproducible Keil HEX, stable full internal-Flash backups, zero mismatch across 583,464 defined bytes, 35 valid USB frames and 22 bounded RAM health checks passed. No reflash was necessary for that original image. The pure target validator and seven offline actual-source product gate tests passed; full Node regression 196/196, pure CDC tests 13/13, final typecheck exit 0. Those baseline results alone did not upgrade M6-M9 or prove product approval/flash/recovery/nonce128 verification. The distinct installed 0.3.2 results above are later evidence; physical disconnect remains untested. Detailed historical receipts: HARDWARE_BASELINE.md.

## Historical 0.1.0 Resource Binding

Production commit `44fea73edcce31c7a9dd90aff73cdd9ceda47be5`; installer SHA-256 `307f12060334bccdc8a963ae5885f608f78bde4e4a98645e70348c4d67da6c83`; installed app.asar SHA-256 `9da610ccbe8feed6c4681182758c0d8c8edf48e4e93593dce4d45d729d1d13db`.

Final live evidence directories under `output/playwright/live-model/`: repair `live-1791960322411`, controls `live-1791960503941`, MCP refusal/restart/export `live-1791960627447`. All three passed with no page errors. Final coordinator suite: 61/61 passed; TypeScript check passed. The earlier installed foundation smoke additionally covers evidence expiry, and is explicitly not assigned the final binary hashes.

T1 means the demonstrated software workflow plus documented fault regressions, not every possible project, safety permutation or Windows environment. These hashes and results describe 0.1.0 only and must not be attributed to 0.2.0. Installer is unsigned; A-level evidence is not frozen or tamper-proof.

## Historical 0.2.0 Acceptance Boundaries

Production runtime commit: `4854ea5b3915f017cc1a3f407364bebdf070759c`. Coordinator verification after runtime freeze: TypeScript check passed; 101/101 tests passed with zero failures/skips/cancellations (47.369534 seconds). Development GUI run `output/playwright/snapshot/development/snapshot-1791970177778/evidence.json` passed the scoped B fixture/export/restart/staleness workflow, with no page errors and normal shutdown. This development run used a manual fixture repair, not model inference.

The 0.2.0 NSIS installer completed with exit 0 into the project-local `install` directory. Installer SHA-256: `0d3cee3ee7597e45894465ce9fb7da7fcf052e9c0eab3cc628ac4fb1e28cb20e`; installed app.asar SHA-256: `f6f1ae893fbdcd94ad1b80e37cf1339a37d8eda3d1db5c5609051fc6f26ab9fd`. All four Codex binaries, process host and four external templates were checked.

Final installed real-model B acceptance passed: `output/playwright/snapshot/installed/snapshot-1791970592002/evidence.json`. The public logged-in state remained true after the ACL change. Model `gpt-6.1-sol` invoked the original failing build, changed only `numbers.mjs`, and obtained a passing B result with a new request key; two actual scoped MCP approvals used the renderer's allow-once button. Other input hashes remained unchanged. Snapshot manifests, native fs/SQLite and Node probes, three fixed verifier checks, artifact and exported log hashes, whole-app restart, durable retry without re-execution, source/artifact staleness, and a final fresh passing build were verified. Both 1380x900 and 800x600 views were checked. No page errors or failures; normal shutdown without forced cleanup.

The installed result is limited to this primary Windows user and fixed trusted template. It is not acceptance of the second user, hardware, arbitrary projects, or a repeat of every historical 0.1.0 T1 scenario.

The fixed Node software snapshot profile is opt-in and limited to the documented arithmetic fixture and trusted local projects. B-level evidence records copied inputs, separated output and observed write-denial probes; it does not establish hostile-code resistance, a tamper-proof verifier or a cryptographically frozen execution input.

The user authorized per-account runtime NTFS isolation. The primary data tree was checked after the application closed: 688/688 items verified, preserving owner SID, SYSTEM, Administrators and existing narrow Electron cache capability rules. Original DACL backups and unsuccessful attempts are retained under `output/second-user-acl/`. This is a metadata check, not proof that a second account was denied access. Shared program files and ancestor permissions remain unchanged.

Second-user acceptance requires a genuinely different human Windows SID, its own official product login and fresh installed workflow evidence. No credentials are copied, and a same-SID script run must report BLOCKED. Hardware remains deferred by the user.

On 2026-10-14 the user explicitly authorized creating a standard local test account. `ForgeDeskTest`, SID `S-1-5-21-1196670755-766692816-2897134863-1006`, was created using a human-entered SecureString password; Users membership, non-Administrators membership and enabled state were checked. The password was not written to artifacts. Creation receipt: `output/second-user-bootstrap/create-20261014T104149769Z-5cd45fd2350a44dca9503b1faf214d60.json`. At creation, desktop login and product authorization were still pending; this receipt alone does not grant acceptance.

## 0.2.1 Repair And Second-User Acceptance History

SID 1006 subsequently completed its own ordinary desktop login, 0.2.0 installation and independent official authorization. The actual smoke observed publicLoggedIn=true. The first attempt failed at optional primary-owned repository Git metadata; after the harness fix, `snapshot-1791981176577` reached the model but both builds failed the SQLite output positive control before arithmetic verification. Neither attempt passed. Original reports remain preserved.

Version 0.2.1 fixes the Windows SQLite probe path representation only, with unchanged physical targets, sandbox permissions and acceptance requirements. Direct/native-sandbox long-path controls and final 125/125 regression tests passed, as did TypeScript. Installed primary-user fixture `snapshot-1791982555423` passed snapshot, export, restart/dedup and freshness checks with normal shutdown and no page errors. It used manual fixture repair and unauthenticated isolated data, so it is not a real-model or second-user result. Release hashes and the retained initial 123/124 fixture-race failure are recorded in `QA.md`.

The 0.2.1 second-user upgrade retains the same SID installation and data paths; its explicit Preflight -Upgrade requires prior matching Install/Launch records and a closed app. All ten installed resources are hash-checked. Upgrade policy tests are synthetic, not actual second-user upgrade acceptance. A fresh actual SID 1006 model run and remaining manual matrix are still required. Hardware remains deferred.

Subsequent actual result: the user completed the SID 1006 upgrade and `snapshot-1791984171287` passed on installed 0.2.1 with realModel=true. This supplies the previously missing actual second-user fixed-template B workflow evidence: original arithmetic-verifier failure, model-only repair, two GUI approvals, all three arithmetic checks, isolation/probe/output/export checks, whole-app restart/dedup, stale-evidence checks and final fresh pass, with zero page errors and normal close. See `SECOND_USER_RESULT.md` for the evidence hash and remaining matrix. The full second-user matrix is still not accepted; no hardware work was performed.

## Current Second-User Scope (2026-10-15)

The actual standard SID1006 single-file ACL read denial passed. Real-model Controls run `snapshot-1791998032747` passed Stop, MCP refusal, approval reload, diagnostic export and application restart. Child-PATH missing-tools run `snapshot-1791999969373159938` passed actual Git/Node error handling without changing parent PATH or running a model turn. Their hashes and limitations are recorded in `SECOND_USER_RESULT.md`. None of these results erase previous failed attempts.

The user has paused additional second-account verification. Development-side offline GUI/protocol, close-timeout and pure uninstall-gate coverage does not upgrade that scope. Actual uninstall, Windows restart, reverse ACL probing, default-AppData isolation and clean-machine acceptance remain unperformed. Later primary-user hardware authorization enabled the separate installed 0.3.2 T2 result above, without resuming any second-SID work.
