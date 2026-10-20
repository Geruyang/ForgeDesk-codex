# ForgeDesk Implementation State

- H0: 2026-10-14 13:03 Asia/Shanghai (first implementation environment inspection; continuous 48-hour clock).
- H2: 2026-10-14 15:03; H4: 17:03; H24: 2026-10-15 13:03; H48: 2026-10-16 13:03.
- All generated outputs: `E:/AiProject/agent-design/ForgeDesk-codex` per user correction.
- Reference documents remain read-only in parent directory.
- Product route: Electron + React + TypeScript + Codex app-server stdio. No OpenCode fork.
- User selected official account login inside ForgeDesk; no credentials copied from existing clients.
- User enabled hardware testing on 2026-10-15 and confirmed an EmbedFire STM32F429IGT6 Challenger V1 with fireDAP SWD. Second-account verification remains paused.
- T1: 0.1.0 remains the historical primary-user installed real-model baseline. T2: installed 0.4.0's real `gpt-6.1-sol` six-tool/four-operation fixed-target chain is accepted jointly with passing read-only continuation `readonly-continuation-1792077968892`. Original execution `hardware-agent-1792076310974-ba6e7c` remains failed at its restart comparison; it was not relabelled passed. Historical 0.3.4 and 0.3.2 manual passes (`realModel=false`, `secondUser=false`) remain version-bound evidence, not model acceptance. Earlier failed/unknown attempts remain unchanged. T3: 0.2.1 fixed-template real-model B snapshot workflow passed on actual second SID1006; the remaining second-user matrix is incomplete and paused. See T2_INSTALLED_RESULT.md and SECOND_USER_RESULT.md.
- Independent source modules share a workspace with exclusive ownership, integration-owned shared files; no agent may revert another's work.

## Ownership

| Agent | Model / effort | Owned scope |
| --- | --- | --- |
| Main | Current session | Shared contract, Electron main/preload, dependencies, packaging, integration |
| Engine | gpt-6.1-sol / xhigh | engine-adapter, generated schemas, ENGINE.md |
| Runner | gpt-6.1-sol / xhigh | runner state/evidence excluding device, software fixtures, RUNNER.md |
| Device | gpt-6-sol / high | device foundation, profiles, native process supervisor |
| Desktop | gpt-6.1-sol / high | renderer and brand assets |
| MCP | gpt-6-sol / high | constrained engineering MCP bridge |
| QA | gpt-6.1-sol / xhigh | independent integration tests, desktop evidence |

## Next

### Current Instruction: 0.4.0 Joint Real-Model T2 Acceptance Passed

Installed runtime `b9a61615c564ea560604503ff7190ecc5e8620f0` uses scope
`real-model-fixed-target-installed-T2`, `realModel=true`, `secondUser=false`.
Run `hardware-agent-1792076310974-ba6e7c` recorded six actual model tool calls
with authoritative call/request/operation associations, four successful workers,
native-approved consumed grant, 584,848 defined bytes read back with zero mismatch,
two nonce128 CDC responses (frames `85 -> 88`, uptime `12979 -> 13340 ms`), and
eight hash-checked export files. The operator acted on the visible original native
dialog under explicit user delegation; the model did not supply authorization.

The original overall report remains `failed`: its restart assertion compared
in-memory undefined properties with JSON-persisted absent properties. This is not
a new failed flash, and successful hardware steps do not make the report passed.
The first read-only continuation also failed on a bounded native CIM query timeout;
its evidence and operator normal-close record are retained. The second continuation,
`readonly-continuation-1792077968892`, completed at `2026-10-15T15:28:47.928Z`
with all eleven controls passed, empty failures/page errors and harness exit 0.
Two normal installed GUI close/reopen rounds retained the same completed run,
calls, hardware records and export without replay; submitted model turns and
hardware actions were both zero. This is joint acceptance of the retained execution
and new read-only evidence, not a new physical run or a repaired original report.
The post-TTL `approved -> expired` derived state preserves the historical grant's
approval/consume and cannot authorize another write.

The complete pre-package regression passed 402/402 and typecheck; final targeted
continuation/harness regression passed 53/53, separately and with overlap, not as
an addition to that count. The continuation SHA-256 is
`995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`;
the unchanged failed original is pinned in [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md).
No second-SID work resumed. No OS device/account isolation, unrestricted autonomy
or complete wrong-device/disconnect/crash/power-loss matrix is claimed. Historical
manual release manifests and failed records must not be overwritten.

### Historical Instruction: 0.3.4 Accepted Within Fixed T2 Scope (2026-10-15)

The user confirmed background Keil as the formal route. The production default
already uses `-j0`, so no runtime change or replacement installer was needed.
Fresh installed run `t2-1792069554285-c061bf` completed at
`2026-10-15T13:14:30.935Z` with all ten controls passed, zero failures/page errors,
and harness exit 0. It used a new build ID and native grant. Flash readback covered
584,848 defined bytes with zero mismatch; fresh CDC frames advanced `264 -> 266`
over 373 ms with 168/48 MHz clocks and zero recorded camera/display errors.
Both application closes were normal. Evidence and bounded Keil process/window
observations are in `output/t2/t2-1792069554285-c061bf/`.

Twenty-two observed UV4-alive samples bound the exact run-specific command with
`-j0` and reported no main window handle. The observer ended at its 150-second
deadline before process exit; four separate window observations are sparse.
Neither establishes continuous focus behavior or complete process-tree identity.
Second-account testing remains paused and the earlier scope limits are unchanged.

#### First 0.3.4 Accepted Run

Installed 0.3.4 run `t2-1792067819027-e68a72` completed at `2026-10-15T12:40:46.914Z` with all ten controls passed, no failures/page errors and harness exit 0. Runtime source is `a8973639413132e15a0acb8f171236a842c1bfd6`. Evidence: `output/t2/t2-1792067819027-e68a72/evidence.json`, SHA-256 `a4ee98757da188d413184974a56dab07ea84cd49e75c827d69835612be58d39d`. The coordinator's final complete regression passed 286/286 and typecheck; package/install exited 0.

The new flash receipt checked 584,848 defined bytes with zero readback mismatches. Two independent nonce128 FDR1 responses matched the compiled build ID and UID, with frames `76 -> 78`, clocks `168000000 / 48000000 Hz` and zero camera errors/timeouts or display errors. Export retained eight hash-checked files/four operations. Both lifecycle close records report normal native GUI disappearance and launcher exit 0/null signal; this is not a full-machine process inventory. The coordinator operated the original visible native UI under explicit user delegation (`automatedResponse=true`, `synthesizedDialogResponse=false`); `realModel=false` and `secondUser=false` remain unchanged.

The report contains 79 optional progress observations, not a success criterion or proof from a completed progress bar. Separate QA reviews progress/scroll visibility. M6 physical wrong-board/disconnect, cross-process isolation and M9 crash/forced termination/power loss remain untested; M8 is same-application task contention and M9 only graceful close after the erase/program marker. Second-SID work remains paused.

#### Historical 0.3.2 Accepted Run

Installed 0.3.2 run `t2-1792065173815-dafb60` completed at `2026-10-15T11:58:14.227Z` and passed build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash normal-close guard and copied-artifact tamper refusal. Runtime source is `5d596985ac8f22a1f7e98a9188dd4c1fc39ae200`. Evidence is `output/t2/t2-1792065173815-dafb60/evidence.json`; the frozen plan and full resource hashes are linked in [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md).

The flash receipt records 584,848 defined bytes and zero readback mismatches. Two nonce128 CDC responses matched the compiled build ID and UID, with frame counters `53 -> 56`, SYSCLK/PLL48 `168000000 / 48000000 Hz`, and zero camera errors/timeouts or display errors. Under explicit user delegation, the coordinator operated the visible original native confirmation UI; no dialog result was synthesized. This is the fixed local Challenger V1 workflow, `realModel=false` and `secondUser=false`, not autonomous model hardware operation or OS isolation.

M6 physical wrong-device/disconnect cases remain untested. M7 installed normal restart and same-key terminal dedup passed without a second flash. M8 passed only contention between tasks in one application, not cross-process OS isolation. M9 passed a graceful close request after the erase/program marker, not crash, forced termination or power loss. The 0.3.1 `unknown` operation remains unknown despite the distinct successful later 0.3.2 and 0.3.4 writes. Second-SID work remains paused.

#### Historical 0.3.3 Pre-Inspect Failure

Installed 0.3.3 run `t2-1792066168842-c9f6aa` passed build, then failed on `state.json` rename `EPERM` before inspect dispatch. No inspect worker started and no flash was performed. After confirming no worker remained, the coordinator precisely terminated the residual application; this was not a normal-close pass. Its failed evidence remains at `output/t2/t2-1792066168842-c9f6aa/evidence.json` and does not replace the accepted 0.3.2 run.

#### Build And Evidence Boundaries

Version 0.3.4's durable state-writer and pre-start cleanup changes were accepted only through the distinct installed run above, not inherited from 0.3.2 or compilation alone. This does not prove every possible file-lock failure is eliminated. Progress is optional telemetry and a full bar is not a success result. Fixed production builds request UV4 `-j0`; see [KEIL_BACKGROUND.md](KEIL_BACKGROUND.md). The separate [IDE-free same-Arm-Compiler experiment](KEIL_HEADLESS_EQUIVALENCE.md) produced an equal HEX with a fixed all-zero build ID. That fixture is not a flashed image and does not change the production build route.

Historical installed attempts remain retained: 0.3.0 run `t2-1792060865425-81feaa` timed out at native authorization without flashing; 0.3.1 run `t2-1792063884804-e2f11c` reached the dangerous phase and ended `unknown` with `IPSR=3`. See [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md) and [T2_ACCEPTANCE_PLAN.md](T2_ACCEPTANCE_PLAN.md). No new physical test is authorized by these documentation updates.

The following baseline subsection is historical and describes the earlier 0.2.1 checkpoint, not the implemented 0.3.0 local hardware routes.

### Historical Instruction: Hardware Baseline Authorized (2026-10-15)

The latest user instruction supersedes the hardware pause only. The user confirmed Challenger V1 plus fireDAP SWD and authorized testing with GestureScreen. Root exclusively owns all physical-device access; firmware audit, candidate validation, CDC parser tests and product gate checks ran in parallel. All outputs remain under ForgeDesk-codex. No second-account operation was requested or performed. No administrator elevation was needed.

Real baseline: Keil build 0 errors/0 warnings; generated HEX equals delivered HEX. Exact probe, STM32 ID 0x419, 1024 KiB Flash and UID were observed. Two independent full Flash backup sessions were stable and unchanged, with all 583,464 HEX-defined bytes matching the running image. USB CDC delivered 35 CRC/UID/epoch-validated frames in 10 seconds. Six running RAM samples passed 22 bounded health checks, including disabled capture after sampling. No flash, erase, reset, halt, external storage write or camera image persistence occurred. Regression: 196/196 Node tests, 13 pure CDC tests and final typecheck passed. See HARDWARE_BASELINE.md and output/hardware/2026-10-15/baseline.json.

At that historical baseline checkpoint, installed 0.2.1 remained unchanged and rejected device routes, and the fixed-target validator was pure and not wired into production. T2 still needed the trusted embedded build/profile, desktop device grant, real adapter/operation lifecycle, build-ID/128-bit freshness protocol and installed acceptance that were subsequently implemented and exercised in the distinct 0.3.2 run above. Generic approved shell access is not an OS-level device-isolation guarantee. The external baseline checks and proposed erase-sector plan themselves were not an executed product flash.

### Historical Instruction: Development-Side Only (2026-10-15)

At this earlier point the user was sleeping and paused second-account verification and hardware. The current hardware authorization above supersedes only that hardware restriction. Do not launch the installed product in SID1006, uninstall, reboot Windows or change account/ACL state as part of the hardware baseline.

Accepted real SID1006 evidence now includes B run `snapshot-1791984171287`, one-direction ACL canary, five Controls in `snapshot-1791998032747`, and child-PATH missing-tools in `snapshot-1791999969373159938`. See `SECOND_USER_RESULT.md` for exact hashes and boundaries. The historical paragraphs below describe earlier points in the rollout and do not override this current status.

Current parallel ownership: Runner owns the four offline Controls fixture files for shell approval/cancel GUI coverage; Desktop owns the missing-tools close-observation harness and focused tests; QA owns pure remaining-stage memory tests, with no actual uninstall; Main owns integration, current ledgers and final verification. Installed 0.2.1 runtime and installer remain frozen unless a separately demonstrated production blocker requires explicit reassessment. Progress and final evidence are recorded in `SOFTWARE_ACCEPTANCE_CONTINUATION.md`.

This bounded development-side batch is complete: fresh coordinator regression 182/182, typecheck exit 0, remaining pure gates 118 (including uninstall 62), independent uninstall pure gates 62, and eight offline production-GUI controls passed. Bounded close observations and uninstall precondition/result validation were hardened. No new actual second-SID verification, uninstall or OS restart occurred. The full second-user matrix remains incomplete and paused by the user; do not ask for immediate reruns. The raw English declined tool-status label is a recorded P3 cosmetic issue, not a production change in this batch.

### Historical Second-User Preparation

The current follow-up prepares additional checks without changing the frozen 0.2.1 runtime or repeating the passed snapshot workflow. QA owns real-model stop, pending-approval reload/refusal, process-owner observations and public diagnostic export; Engine owns a separate child-process-PATH missing-tool harness; Second-user integration owns read-denial gates and the final, separately invoked uninstall check. Main coordinates source validation and the human SID1006 desktop run. Hardware remains deferred. See `SECOND_USER_REMAINING.md` for the execution sequence; preparation and primary-user negative-gate tests are not second-user acceptance.

A new secret-free primary marker was created at `.runtime/app/forgedesk-acl-canary-primary-2ffe87fd0ba9432ea6fc31c1dfd7449d.txt`. Its public manifest is `output/second-user-acl/canaries/primary-2ffe87fd0ba9432ea6fc31c1dfd7449d.json`. Main verified owner SID1002, the three inherited owner/SYSTEM/Administrators ACEs, no reparse point and one hard link. No ACL was changed. Actual SID1006 read-denial remains pending; neither absence nor an unrelated error counts as denial. Default AppData isolation and resistance to modifications of shared program files are not established by this check.

Follow-up: actual standard desktop SID1006 returned `CANARY_READ_DENIED` in `remaining/acl-canary-20261014T142448446Z-6ef3de7c54a949a8b6f795c3ab4c9c9f.json`. Main matched its manifest hash and independently confirmed the primary public marker still exists with its original content hash. This single-file, second-to-primary read-denial check is now passed; reverse direction and other isolation claims remain untested. Next human step is Controls only; see `SECOND_USER_RESULT.md` and `SECOND_USER_REMAINING.md`.

User requested parallel T3 snapshot and second-user work while leaving hardware disabled. Scope and ownership are in `T3_PLAN.md`. The existing 0.1.0 T1 evidence below remains historical, not acceptance of every scenario on the new 0.2.0 binary. The fixed Node arithmetic B snapshot passed its installed real-model workflow. After clarifying that a Microsoft login email is not necessarily a separate Windows SID, the user explicitly authorized a new standard local test account. `ForgeDeskTest` was created and independently checked as enabled, a Users member and not an Administrators member, SID `S-1-5-21-1196670755-766692816-2897134863-1006`. The human entered its password in the elevated local helper; no password was recorded. Creation evidence: `output/second-user-bootstrap/create-20261014T104149769Z-5cd45fd2350a44dca9503b1faf214d60.json`.

ForgeDeskTest subsequently completed Preflight, Install and Launch in its own non-elevated desktop session 2. The user confirmed independent official login. Final second-user ACL evidence `output/second-user-acl/second-S-1-5-21-1196670755-766692816-2897134863-1006-20261014T120100Z-result.json` verified 203/203 paths. Earlier same-SID BLOCKED reports and incomplete ACL attempts remain preserved.

The first actual second-user snapshot run, `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791980373836/evidence.json`, observed installed 0.2.0, engine ready, publicLoggedIn true and hardware disabled, then failed on optional shared-repository `git rev-parse HEAD` metadata collection because the repository belongs to the primary user. No model repair or workflow step completed; app cleanup was normal, not forced. The second-user harness must avoid querying the primary-owned repository for optional metadata, without changing global Git trust. A fresh actual SID 1006 run is required after this harness fix. Full second-user acceptance remains pending.

User-authorized primary data-directory ACL tightening completed: 688/688 paths verified; result `output/second-user-acl/primary-S-1-5-21-1196670755-766692816-2897134863-1002-20261014T084144Z-result.json`. Original SDDL and earlier partial failures are preserved. Only DACLs changed; no elevation or credential contents read. Narrow original Electron cache capability exceptions remain. This does not establish actual second-account access denial or secure shared program files.

## 0.2.0 Snapshot Milestone

### 0.2.1 Repair Ready For Second-User Rerun

The actual second-user rerun `snapshot-1791981176577` passed login and fixed-profile enablement, but both builds stopped at the native SQLite output positive control. The model repaired only `numbers.mjs`; no arithmetic verification passed. Its 216-character output directory plus unique marker produced a 273-character SQLite filename. Independent direct/native sandbox comparisons reproduced the long-path failure and verified Windows namespaced-path output success plus protected-input denial. See `SQLITE_LONG_PATH_FIX.md`. Version 0.2.1 changes only the SQLite path representation in the fixed probe; permissions and pass requirements remain unchanged. Historical 0.2.0 installer, source archive and manifest are preserved.

Runtime source `c22b5a5b5660393775b5015714c5b48bd584d810` is packaged as `release/ForgeDesk-0.2.1-x64-setup.exe`, SHA-256 `9375c0d22d57b9cfabf5be0df8e85a3fec66a17039f511ae97bcc0a6cf4ebbb9`. Primary installation exited zero; installed asar SHA-256 `ed70cea2a18dc4da6665635e8558a4490aee42e30a1dee22ca4b0b056a2eca24`. Final full suite passed 125/125 and TypeScript passed. Installed fixture workflow `snapshot-1791982555423` passed with zero page errors and normal close; it used unauthenticated isolated primary-user data and manual fixture repair, not model inference. The initial full-suite 123/124 result and fixture timer-race repair are recorded in `QA.md`.

The user completed the actual SID 1006 upgrade and real-model rerun. Evidence `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791984171287/evidence.json` passed on 0.2.1 with gpt-6.1-sol, public login true, two GUI approvals, original arithmetic verifier failure, model-only repair, all three checks, B manifests/probes/export, whole-app restart/dedup, source/artifact staleness and final fresh pass. Zero page errors, normal close, no forced cleanup. No repeat upgrade or login is needed for this completed workflow. Dedicated process-owner checks, refusal/stop controls, actual cross-account denial, missing-tool and uninstall scenarios remain outside this pass; see SECOND_USER_RESULT.md.

- Post-release second-user tooling regression: 111/111 tests passed, zero failed/skipped/cancelled, TypeScript passed; 68/68 pure-memory ACL path/ACE checks passed. The actual primary SID is blocked by the dedicated second-user snapshot entry before application startup. These checks are not actual second-SID acceptance. Runtime source and installer remain unchanged.
- Runtime source: `4854ea5b3915f017cc1a3f407364bebdf070759c`; final coordinator tests 101/101 passed, zero failed/skipped/cancelled, TypeScript passed.
- Installer: `release/ForgeDesk-0.2.0-x64-setup.exe`, SHA-256 `0d3cee3ee7597e45894465ce9fb7da7fcf052e9c0eab3cc628ac4fb1e28cb20e`; installation exit 0.
- Installed app.asar SHA-256: `f6f1ae893fbdcd94ad1b80e37cf1339a37d8eda3d1db5c5609051fc6f26ab9fd`.
- Installed real-model evidence: `output/playwright/snapshot/installed/snapshot-1791970592002/evidence.json`; model `gpt-6.1-sol`, original build failed, model-only repair passed, two actual allow-once approvals, B export/restart/dedup/staleness checks passed. Zero page errors and normal shutdown.
- Development fixture evidence: `output/playwright/snapshot/development/snapshot-1791970177778/evidence.json`; manual fixture correction is explicitly not model inference.
- Earlier failed development run `snapshot-1791967747559` is retained. Root cause was premature terminal sampling followed by a synchronous close dialog blocking finalization; terminal publication, asynchronous warning and harness waiting were fixed. Probe false-positive cases also have independent regressions.
- Second-user kit contains the installer, two scripts, Chinese-first guide and SHA-256 list only; no runtime/authentication data. Same-SID Preflight is BLOCKED and Install is gated. Actual second-SID acceptance remains pending.

## Historical 0.1.0 Development Milestone

- Independent real desktop workflow: import project, create task, original defect fails fixed verifier, repaired fixture passes, reload/restart preserve evidence, changed input expires evidence.
- Actual Windows Job Object helper kills children and grandchildren on parent death and cancellation.
- Both MXC startup and unelevated workspace/protected-directory probes completed; current implementation intentionally remains explicit unelevated mode.
- Independent full suite: 53/53 passed. A simultaneous duplicate run while packaging exposed overly short 1-second fake-engine startup deadlines; corrected harness passed 14/14 engine tests while preserving the explicit 700ms timeout check. No production timeout or assertion weakened.
- Final coordinator full-suite rerun after all runtime and harness fixes: 53/53 passed, 0 failed/skipped/cancelled, 16.17 seconds.
- Final NSIS installer successfully installed to `install/ForgeDesk.exe` with exit 0. All four installed engine hashes match the vendor manifest. Installer is unsigned. Installed workflow regression passed, including packaged MCP registration, failure logs, restart recovery and evidence expiry; see `output/playwright/installed-final/evidence.json`.
- No inference or live hardware result is claimed by these checks.

## Historical 0.1.0 Installed Milestone

- Production source commit: `44fea73edcce31c7a9dd90aff73cdd9ceda47be5`; later source archive changes are documentation and test harness only.
- Installer SHA-256: `307f12060334bccdc8a963ae5885f608f78bde4e4a98645e70348c4d67da6c83`.
- Installed app.asar SHA-256: `9da610ccbe8feed6c4681182758c0d8c8edf48e4e93593dce4d45d729d1d13db`.
- Final full suite: 61/61 passed, zero failed/skipped/cancelled, 18.7368 seconds; final TypeScript check passed.
- Installed real-model repair: `output/playwright/live-model/live-1791960322411/repair-evidence.json`.
- Installed steer, isolation, shell approval reload/cancel and stop with actual child PID disappearance: `output/playwright/live-model/live-1791960503941/controls-evidence.json`.
- Installed MCP UI refusal, no runner invocation, whole-app restart, successful-task restoration and redacted exports: `output/playwright/live-model/live-1791960627447/mcp-denial-evidence.json`.
- Earlier failures are retained: unsupported MCP consent initially cancelled tests; interrupted engine turns initially left a waiting shell. Both were fixed and verified against the final installed resources above, not only development output.
- Unsigned local installer; Windows 11 Home x64 10.0.26200, this user only. No hardware, second-user or frozen-snapshot acceptance claimed.
