# Independent QA

## Current 0.4.0 Hardware-Agent Joint Acceptance

Installed 0.4.0 runtime `b9a61615c564ea560604503ff7190ecc5e8620f0` executed the
real `gpt-6.1-sol` fixed-target chain in
`output/hardware-agent/hardware-agent-1792076310974-ba6e7c/evidence.json`.
Nine controls passed: public login, restricted policy, actual model calls, build,
inspect, native authorization, flash, verify and export. Six actual tools associate
with four successful, exited workers. Independent retained-artifact QA confirmed
584,848 defined bytes with zero readback mismatch, nonce128/build-ID/UID/CRC-checked
CDC frames `85 -> 88` over 361 ms, eight export files and fourteen installed
resource pins. The coordinator operated the actual native dialog under explicit
user delegation; no native decision was synthesized.

The original overall report is still `failed`: restart deep comparison rejected
undefined fields omitted by JSON persistence. A first read-only continuation failed
on its bounded native CIM query; its failed evidence and normal operator-close
record are retained. Separate continuation `readonly-continuation-1792077968892`
passed all eleven controls at `2026-10-15T15:28:47.928Z`, harness exit 0, empty
failures/page errors. Its two actual installed GUI rounds closed normally and
preserved the completed run/calls, authoritative hardware records and export,
with zero submitted model turns or hardware actions. The original execution and
this linked read-only evidence jointly accept the stated fixed-target model scope;
neither the original report nor the failed first continuation was relabelled.

Passing continuation evidence:
`output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077968892/evidence.json`,
SHA-256 `995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`.
It binds the unchanged failed original SHA-256
`aa521ab556b4ab7f7129da61b797bd21a7e5afff9423da56782d1bba65c8ddd3`.
Post-TTL derived native status is actually `expired`, not rewritten to `approved`;
historical approved/consumed grant facts remain unchanged. Exact native main PIDs
were absent after close and launcher exits were 0/null signal; this is not a
machine-wide engine/host process-tree inventory. No repeat model call or hardware
write is authorized by this documentation.

Complete pre-package source/native regression: 402/402 passed, zero
failed/skipped/cancelled; typecheck passed. Logs:
`output/hardware/t2-integration/test-0.4.0-final.log` and
`typecheck-0.4.0-final.log`. Final targeted continuation/harness checks passed
53/53 (18.104 seconds), zero failed/skipped/cancelled:
`output/hardware/t2-integration/test-0.4.0-continuation-final.log`. Typecheck also
passed after the last test-only native-query changes. Counts overlap and are not
summed. Exact release/evidence pins are in [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md).
Scope is the primary Windows user and fixed board, not second-SID acceptance,
hostile same-SID isolation, unrestricted hardware autonomy or physical fault
injection. Historical software-only statements below describe their dated
versions, not the current hardware checkpoint.

## Historical Software QA Baseline

Updated: 2026-10-14, Asia/Shanghai. Scope at this historical checkpoint was the software build. The reference plan in the parent directory is read-only. No account credentials were copied, no official login was attempted by QA, and no hardware operation was performed by that software QA run.

## Evidence And Commands

- `tests/desktop-integration.test.ts` bundles the actual production main/preload source. Electron and the engine transport are boundary fixtures; `DesktopStore`, validation, handlers, event projection, journal writes, redaction and preload capabilities execute from production code. These are integration fault-injection tests, not live-model evidence.
- `tests/electron-smoke.ts` launches the actual Electron binary and production build. It uses the real isolated Codex executable, named-pipe bridge, engineering runner and native process supervisor. Test dialog selection is the only Electron API replacement. It never performs account login.
- `tests/live-model-smoke.ts` uses the user's already authenticated, independent `.runtime/app` product home. Only the public `loggedIn` boolean and model IDs are recorded. It does not read authentication files. Each run creates a separate Git-committed defective workspace below `.runtime/live-model/<runId>/workspace`; the trusted verifier is outside the model workspace. Evidence and screenshots are unique per run under `output/playwright/live-model/<runId>`.
- Development smoke evidence: `output/playwright/development/evidence.json`. Latest complete run passed on 2026-10-14 at 13:22 Asia/Shanghai with no renderer page errors. Captures include empty workspace, settings, delivery and stale evidence at 1380x900 and 800x600. Three representative captures were independently viewed and had readable text, loaded bitmap branding, and no incoherent overlap. Automated document horizontal-overflow checks passed.
- Initial installed software smoke evidence: `output/playwright/installed-final/evidence.json` (historical directory name). `install/ForgeDesk.exe` version 0.1.0 passed on 2026-10-14 at 13:46 Asia/Shanghai, Windows 11 Home x64, OS release 10.0.26200. The recorded engine executable is the installed `install/resources/codex/codex.exe`; its independent home is `.runtime/qa-installed-final/engine`. This preceded the real-model integration fixes and is not the final live acceptance run.
- `output/playwright/development/failure.png` is a retained earlier test-harness readiness failure, not evidence of the later passing run. The harness was corrected to poll application snapshots outside the browser and rerun successfully.
- Run source integration: `npx tsx --test tests/desktop-integration.test.ts`.
- Source integration additionally covers final MCP tool-result projection and successful interruption's cleanup gate: no overlapping send, no turn replay, reconnect only after native-tree shutdown, terminal preservation, and unfinished tool/history-gap projection. One case combines the actual main MCP handler with the production runner/native supervisor: failed check, source repair, successful recheck in the same turn, and repeated-key dedup produced exactly two persisted operations.
- Independent complete repository run: `npm test`, 53 passed and 0 failed, including engine, MCP, runner, device fixture, native process-host and desktop integration tests. The exact journal/export regression then passed against the final sanitizer change. A final coordinator rerun after all runtime and test-harness fixes also passed 53/53 (0 failures, skips or cancellations; 16.17 seconds). No failing regression was removed or weakened.
- Run development smoke after building: `npx tsx tests/electron-smoke.ts`.
- Run the same smoke against an installed executable by setting `FORGEDESK_INSTALLED_EXE` and a fresh `FORGEDESK_QA_LABEL`. All state, sources, screenshots and evidence remain below this project root.
- Coordinator's final complete suite passed 61/61 (0 failures, skips or cancellations; 18.7368 seconds), including closing-during-interrupt recovery. Final main-source subset passed 17/17. These are source/native fixture results, not authenticated-model evidence. Latest live harness typecheck passed.
- Run live repair with `npx tsx tests/live-model-smoke.ts`; installed mode is the default. `FORGEDESK_LIVE_PHASE=controls` and `FORGEDESK_LIVE_PHASE=mcp-denial` run the independent control/refusal phases. Development requires explicit `FORGEDESK_LIVE_DEVELOPMENT=1` and records that reduced scope. `FORGEDESK_LIVE_RESTORE_REPAIR` may reference a successful installed QA repair evidence file to recheck restart persistence, export, and restore the final visible selection.

## Final Installed Live Acceptance

All three final phases passed against `install/ForgeDesk.exe` 0.1.0 on the same Windows 11 Home x64 user, 2026-10-14 14:45-14:51 Asia/Shanghai. The user had completed official login; QA only confirmed public `loggedIn=true` and used the returned `gpt-6.1-sol` model. No QA code supplied the source fix. No authentication file was read, copied or emitted.

The runtime was committed at `44fea73edcce31c7a9dd90aff73cdd9ceda47be5`. Each installed evidence file independently hashes the actual installed ASAR and release installer. The source tree's dirty flag is separately recorded because later QA-only edits do not identify the installed runtime. Final installer SHA256 is `307f12060334bccdc8a963ae5885f608f78bde4e4a98645e70348c4d67da6c83`; installed ASAR SHA256 is `9da610ccbe8feed6c4681182758c0d8c8edf48e4e93593dce4d45d729d1d13db`. The package is unsigned. The older `5a967070...` candidate was superseded by the process-cleanup fix and is not this accepted build.

- `live-1791960322411/repair-evidence.json`: actual model repair completed. The original arithmetic fixture failed; the model called the original check, changed only `numbers.mjs` to return zero for empty arrays, then called the fixed verifier again with a new requestKey. Authoritative persisted operations are baseline failed, model-original failed, model-repaired succeeded. Task/acceptance are passed, the trusted outside-workspace verifier is unchanged, and the Git diff is nonempty. Both exact-scope MCP approvals used actual "允许本次" renderer buttons, including numeric request ID zero. Reload retained passed evidence. `repair-logs.json` and approval/terminal/delivery screenshots are retained.
- `live-1791960503941/controls-evidence.json`: actual steer, process-tree stop and project/session isolation passed. While the QA shell waited, selecting another project/session did not move the steer or create messages/operations in that idle task. After interrupt, the real turn was interrupted and no QA-marker process remained. The exact outside-workspace sentinel command approval survived reload; the actual "取消" button produced journal `cancel` and real interrupted terminal, with sentinel unchanged. The observed shell tool completed as declined, but the client decision is correctly recorded as cancel, not fabricated decline.
- `live-1791960627447/mcp-denial-evidence.json`: actual MCP "拒绝" after reload resolved `decline` for the same generation/numeric ID. The task retained zero runner operations and unchanged source; the model completed without retry. In this subsequent whole-application launch the prior real repaired task remained completed/passed, and both earlier single-use UI accepts were also confirmed against their actual public journal resolutions.
- That last run exported the repaired task through the installed product's real public `exportTask`. Its explicit-field `manifest.json` records schema 1, A-level evidence, passed task and three logs whose file hashes match the manifest. Public `exportDiagnostics` produced schema 1 with only its defined public diagnostic fields. Export locations and manifest hash are in `installedExports`; source/config/authentication files are not part of the delivery manifest. Production secret-redaction fault-injection remains complementary evidence, not a claim that a credential fixture was the user's real credential.
- The successful repaired project/session and "工程交付" tab were selected, renderer-reloaded, and their three persisted selection fields verified. `restored-successful-delivery.png` was independently viewed: real 1/1 passed acceptance, three retained operation/evidence records, loaded branding and no incoherent overlap. All final live phases had zero renderer page errors. QA closed each application normally, including the last run at 14:51; no failed history or unrelated project was removed.

At this historical 0.1.0 checkpoint, T1 software acceptance was complete for this Windows user, within the combined source/native and installed-live evidence described here. T2 hardware was then explicitly deferred, unaccepted and unavailable. This was software-scope delivery, not complete software-plus-hardware acceptance; later version-specific T2 evidence is recorded above.

## Authenticated Live Development

The user completed official login outside QA. Authenticated probes publicly returned `loggedIn=true` and selected `gpt-6.1-sol`. Startup awaits the public connect operation before checking account/models because engine-ready can precede account/model refresh. No email, token or authentication-file content is included in these artifacts.

- `live-1791958548113/repair-evidence.json`: real development model repair passed. The model changed only the defective arithmetic source, called `engineering.test` before and after its edit, and obtained authoritative passing evidence from the unchanged external verifier. Three runner operations were persisted: QA's original-defect baseline, the model's original-defect check, and the model's repaired-source check. Two strictly scoped MCP confirmations were accepted once through the public bridge. The Git diff is nonempty and reload retained passed evidence. This run was built from a dirty source tree; evidence records both HEAD and the actual `dist/main` hash rather than claiming HEAD identifies a clean runtime.
- `live-1791959866622/controls-evidence.json`: development steer, actual shell-process stop, project/session isolation, shell approval cancellation and pending-approval reload passed. The unique QA waiting PowerShell process existed before interrupt and was absent afterward. An idle alternate project's session retained zero messages and operations. The real outside-workspace sentinel request was checked against its exact structured command, reloaded, and cancelled using the actual renderer button. This protocol offered `accept`/`cancel`, not `decline`; the real terminal was interrupted and sentinel contents stayed unchanged. This is shell cancellation, not an invented shell-decline receipt.
- `live-1791960054450/mcp-denial-evidence.json`: separate real MCP refusal passed. The same engineering.test approval generation/id survived renderer reload, the actual "拒绝" button produced journal `engine/approvalResolved` decision `decline`, and the runner retained zero operations with source unchanged. Its pending screenshot was independently viewed and showed the real confirmation card, zero execution records and masked account label.
- Original installed live-repair failure remains archived under `failed-elicitation-installed-20261014`; it is not overwritten or counted as successful repair. The model attempted engineering.test but the old adapter automatically cancelled an unsupported MCP elicitation. The original source remained unchanged. A development shape-only probe in `live-1791958059457` captured the safely bounded actual alpha request without granting it.
- Old stop behavior is retained in `live-1791958827707` and `live-1791959234522`. The latter was an observational process-identity probe, not stop acceptance: actual `pwsh.exe` remained after server terminal interrupted, then ended naturally. QA did not kill it. The production cleanup fix was subsequently verified by the passing control run above.

These development observations did not replace final installed validation; the subsequent final installed runs above repeated real repair and all controls. Hardware remains explicitly deferred.

## Verified Behavior

The real development Electron run imported a project and created a task through the UI, confirmed unauthenticated send remained disabled, and executed a fixed trusted arithmetic verifier through the production runner. The original empty-input defect failed. QA copied a corrected test fixture into the disposable source directory; all three arithmetic checks then passed. This correction was manual test setup, not a model-generated software task.

Reload retained the task, verification evidence and unsent draft. A whole application restart preserved both operations without replaying them. A new untracked input changed the source fingerprint and staled the previous passing evidence. The production diagnostic export was readable JSON. The application was closed after the run; QA authentication and session state are separate from the user's future product session.

The complete software smoke was repeated successfully against the NSIS-installed executable. The installed version additionally returned the real failed verifier log through its privileged IPC. A separate child of the installed executable, with `ELECTRON_RUN_AS_NODE=1`, ran the compiled `app.asar/dist/mcp/index.cjs` entry. MCP initialize succeeded, tools/list returned exactly the seven configured tools, and engineering.test with no active task returned an explicit tool error. The test read only the product's generated bridge connection settings into memory; pipe/token/config contents were never included in evidence or printed. Installed screenshots at both viewport sizes passed overflow and image-loading checks; representative empty/delivery captures were independently viewed. No renderer page error occurred.

Production-source fault injection additionally checks privileged IPC sender/frame identity, own-method dispatch, argument envelope rejection, renderer isolation options, denied navigation/window creation and permissions, official `inProgress` normalization, prompt-before-response ordering, terminal turn races, failed steer without resend, ambiguous send delivery, cross-task MCP scope, disabled hardware/build operations, journal failure handling, structured-secret redaction, operation-log ownership/path boundaries, orderly engine/bridge/runner shutdown, crash recovery, unsupported-schema preservation, and the exact preload capability surface.

## Historical 0.1.0 Must Matrix

| Plan Item | Current QA Evidence | Acceptance Boundary |
| --- | --- | --- |
| M1 Authentication, isolation, export | Independent installed home/unauthenticated guard; final installed public login and real model completion; real explicit-field A-level task/diagnostic export; journal/export redaction regression | Passed for this user; no credential read/copy by QA |
| M2 Approval, refusal, reload | Final installed exact-scope UI single-use accepts, MCP UI decline/reload/no-run, shell UI cancel/reload/unchanged sentinel; source generation/unknown-request handling | Passed; shell cancel and MCP decline are distinguished |
| M3 Exit, protocol, stop, cleanup | Source terminal/uncertainty/gated cleanup/closing-race checks; installed restart without replay; native supervisor tests; final installed real waiting PowerShell child absent after interrupt | Minimal software gate passed; exhaustive crash/stress matrix not claimed |
| M4 Build/test failure | Final installed original/model checks failed with persisted logs; real model repaired source and obtained fixed external-verifier pass and Git diff | Passed; manual earlier smoke correction is not model acceptance |
| M5 A-level inputs and expiry | Installed new untracked input staled evidence after restart; source/runner coverage covers protected verifier configuration changes | A-level hashes are not tamper protection or frozen input |
| M6 Cable, identity, old UART output | Not executed | Hardware explicitly deferred by user; T2 remains unaccepted and unavailable |
| M7 Repeated requestKey | Independent runner tests cover duplicate and reopened-store request keys; real restart retained operations without replay | No device side effect was exercised |
| M8 Device contention | Not executed | Hardware deferred; T2 unaccepted |
| M9 Flash close/crash/disconnect | Not executed | Hardware deferred; T2 unaccepted |
| M10 Project/session scope and steer | Source active-turn binding/no-resend/MCP scope; final installed real steer while another project/session selected, idle task stayed untouched | Passed software isolation; no device projection claimed |

T1 is signed off for this historical installed software scope and Windows user. At that 0.1.0 checkpoint T2 was not a validated hardware workflow; no fixture or source test counts as hardware acceptance. The distinct later installed T2 results do not rewrite this historical scope.

## Findings Reported For Fix

| Finding | Owner And Validation |
| --- | --- |
| Official `inProgress` leaked into product state, bypassing running guards and rejecting steer | Main fixed; source regression passed |
| Prompt appended after response events; send response could overwrite a completed turn | Main fixed; source chronology and completed/failed/interrupted race regressions passed |
| Shutdown omitted runner close | Main fixed; source cleanup regression passed |
| Diagnostic strings leaked JSON-quoted access/refresh tokens and URL passwords | Main adopted runner redaction; source export regression passed |
| Nested JSON credentials could remain in serialized event journal strings | Main now recursively sanitizes raw structured data and leaf strings before serialization; exact export and events.jsonl regression passed |
| Main log allowance disagreed with nested runner data directory | Main normalized runner data directory; source owned/foreign/outside log checks passed |
| Send response loss after server turn started allowed overlapping work | Main added persistent engine uncertainty; source regression passed |
| Interrupt response loss did not mark the still-running turn uncertain | Main fixed; source uncertainty and overlap-prevention regression passed |
| MCP test key was constant for the whole turn, preventing recheck after a repair | Main added a required invocation requestKey; actual main-handler/runner/native-supervisor regression passed for failure, repair, recheck and duplicate-key return |
| Automated acceptance editor omitted trusted verifier paths and accepted runner-incompatible timeout range | Desktop fixed the fields/defaults/range; typecheck passed |
| New failed/cancelled build could retain aggregate passed status | Runner fixed status priority; independent full-suite failed/cancelled-build regression passed |
| Actual alpha MCP tool confirmation used elicitation and was automatically cancelled, blocking real engineering.test | Engine added strict engineering-only empty-schema single-request confirmation mapping without session persistence; module tests plus development and final installed real repair/refusal passed |
| Completed MCP tool retained its started text, hiding final errors/results in the UI | Main fixed final-result projection; actual-source regression passed |
| Server interruption acknowledged terminal but left the real waiting shell process alive | Main now gates new work, closes the native engine Job before reconnecting, and marks unfinished tool/history gaps; source plus real development/final installed child-process cleanup passed |

## Remaining Review Limits

Source integration uses fixture transport events and cannot establish model approval semantics, sandbox effectiveness on every Windows build, or hardware identity. Authenticated installed evidence establishes only the particular model/software/control requests observed on this Windows user. External Node/compiler and shell availability on this test host is not proof of a clean second user's toolchain; that broader installation matrix remains T3. No stress certification, second-Windows-user regression, full crash matrix or large-history guarantee is claimed.

## T3 Snapshot Acceptance

This section is a separate acceptance track for the new B-level fixed Node software template. It does not replace the completed 0.1.0 T1 history above. Final 0.2.0 installed-model B acceptance passed for the primary Windows user. Genuine second Windows-user installation/login/model/restart remains pending, so the combined T3 request is not fully accepted. Hardware remains deferred and unaccepted.

The intended B claim is task/operation-specific input copies with checked manifests and separately bound output artifacts. It is not protection against an arbitrary malicious same-SID process, and not a general untrusted-code execution service. The first profile is the fixed arithmetic Node template, with trusted local project code as an explicit assumption.

### Independent Coverage

- `tests/helpers/desktop-harness.ts` extracts the existing actual-main-source integration fixture without loading tests as helper side effects. Real snapshot probing defaults to an explicit boundary error in the fixture; injected receipts do not count as native isolation evidence.
- `tests/snapshot-main.test.ts` passed six actual-main-source cases: privileged probing rather than renderer-supplied receipts; fail-closed probe error; rejecting a model-workspace fake Node executable before any probe; deferred same-key probe/build dedup and busy gates; strict MCP task/profile revision/request-key scope with fresh-probe and durable-key behavior; and probe-failure gate release. These use fixture engine/probe boundaries, not live model or sandbox evidence.
- `tests/snapshot-runner-integration.test.ts` passed two independent real native public-API cases on 2026-10-14 (24.94 seconds, zero failures/skips/cancellations). Each uses the actual isolated Codex adapter configuration read, pinned native process supervisor, and real engine-sandbox write-denial receipt. An external source edit during actual verification leaves checked input/output bytes and historical `verificationResult=passed` intact, but makes current B evidence/acceptance stale. A source edit observed while copying a 32 MiB input fails before snapshot commands execute, leaves output empty, and does not create passing evidence. Evidence is under `output/qa/snapshot-runner/run-*.json`; private fixture runtimes were closed and removed. No authentication/model turn, Electron, second SID, or hardware was involved.
- `tests/snapshot-electron-smoke.ts` records development and installed scopes separately, creates unique fixture/output directories, and validates actual GUI profile enablement, fixed acceptance protection, complete copied input/hash manifests, native/Node permission probes, output hashes, export, restart dedup, and source/artifact invalidation. Its development manual source correction is explicitly a fixture correction, never a model-generated repair. Installed real-model mode is separate and requires the installed executable and the user's existing product home; no authentication file is read.
- Latest independent targeted rerun passed 8/8 (13.78 seconds, zero failures/skips/cancellations): all six main-source and both real native runner cases, against the final terminal/probe source changes.
- The coordinator's final complete source suite passed 101/101 (47.369 seconds, zero failures/skips/cancellations), with typecheck passed, against production runtime commit `4854ea5b3915f017cc1a3f407364bebdf070759c`. This includes the later terminal/probe/close fixes and independent native tests. It is source/native fixture validation, not final installed or second-user acceptance.

### Completed Development GUI Rerun

`output/playwright/snapshot/development/snapshot-1791970177778/evidence.json` passed with the coordinator's rebuilt 0.2.0 development runtime, 2026-10-14 17:29-17:30 Asia/Shanghai. This was an independent unauthenticated QA home (`publicLoggedIn=false`), not the user's account or second-SID acceptance. Source HEAD was `2762beb3dd025310f40f03153b8db1239d15f379`, source dirty was recorded true, and actual `dist/main/index.cjs` SHA256 was `92ce57f437dde731a5de34f69af6eeb7521d5b644bd413ed0926a34905181b35`; HEAD alone is not asserted to identify that dirty development runtime.

Actual GUI enablement, original failed build/check, explicit manual fixture correction, and a new B passing operation completed. QA independently checked complete ignored/untracked/binary/lock/empty-directory input manifests, `.git` exclusion and null Git fields, native write-denial receipt hashes, filesystem/SQLite sandbox probes, both Node permission stages, separate declared artifact paths/hashes/byte sizes, and the full empty/nonempty/signed verifier receipt tied to the artifact hash. The real product exported a B manifest with two independently hash-checked logs and no raw input/secret fixture. A whole application restart retained pass and operation IDs; retrying the recorded request key created neither probe nor operation. New source input and later output-artifact mutation each made current acceptance stale while preserving the checked historical input/result distinction.

The passed captures at 1380x900 and 800x600 were independently viewed, with loaded bitmap branding, readable wrapping and no incoherent overlap; automated horizontal overflow checks passed. Renderer page errors were zero. Both application lifetimes closed normally; final evidence records `normalClose=true` and `forcedFixtureCleanup=false`. A subsequent process inventory found no associated QA script, private fixture engine, or development Electron remaining. This passing rerun closes the earlier harness/modal failure for development only; the subsequent installed model-generated B run is recorded below.

### Final Installed Real-Model B

`output/playwright/snapshot/installed/snapshot-1791970592002/evidence.json` passed against actual `install/ForgeDesk.exe` 0.2.0 on 2026-10-14 17:36-17:38 Asia/Shanghai. Runtime commit is `4854ea5b3915f017cc1a3f407364bebdf070759c`. Independently observed installer SHA256 is `0d3cee3ee7597e45894465ce9fb7da7fcf052e9c0eab3cc628ac4fb1e28cb20e`; installed ASAR SHA256 is `f6f1ae893fbdcd94ad1b80e37cf1339a37d8eda3d1db5c5609051fc6f26ab9fd`. These match the coordinator's final package values. The package is unsigned.

After the primary product home's ACL tightening, the public account state remained `loggedIn=true` and the engine was ready. The actual model was `gpt-6.1-sol`. No authentication file/token/email was read, copied or recorded. The existing T1 projects and failure history were retained.

- The actual GUI enabled the fixed profile only after real engine/config policy and native write-denial admission. The model called `engineering.build` with profile revision 1 and an original unique request key. Its defective arithmetic input failed. The model alone then repaired `numbers.mjs` and invoked a new-key build, which produced B-level pass. Its real turn completed. QA verified the other five input files' hashes were unchanged, no input files were added/removed, the original operation's input still contained the defect, and actual diff was nonempty. No QA source correction occurred in this run.
- Both exact-scope engineering.build confirmations used the real renderer "允许本次" buttons. Actual numeric JSON-RPC IDs were zero and one. Server/form/schema/marker/thread/turn/task/profile revision and exact tool parameter fields were checked before granting each single request. The two model operations remained failed then succeeded; their complete original logs and snapshots were retained.
- Independent full input-manifest/hash checks, null B Git metadata, engine write-denial log hash, native filesystem/SQLite denial/output checks, both Node permission stages, declared artifact paths/hashes/byte sizes, and the empty/nonempty/signed receipt tied to the artifact hash passed. These are the constrained template's actual runtime checks, not a malicious-module anti-cheat claim.
- The installed product exported a B manifest with two independently hash-checked logs, manifest SHA256 `f184e9f1f0932f09fcbb3b5d93af23adc6fb4a06c978a4f90c3d2e4c8b552fc9`, and no raw input/secret fixture. A whole application restart preserved the model's passed task and both original operation IDs. Durable-key retry created neither new probe nor execution.
- A new external source input staled current B acceptance while retaining historical snapshot pass and unchanged checked input bytes. A subsequent fresh GUI build restored pass; an external output-artifact change staled acceptance again. The final fresh GUI build restored passed current acceptance without undoing model source or removing historical evidence. Four operations, including the original failed model build, remain visible. The last two builds are QA-driven lifecycle checks, not additional model repair claims.
- Final passed screenshots at 1380x900 and 800x600 were independently viewed and had loaded branding, readable text/wrapping and no incoherent overlap; automated horizontal overflow checks passed. Renderer page errors were zero. The final selected session showed model completion and B acceptance 1/1 passed on "工程交付". Both application lifetimes closed normally; `normalClose=true`, `forcedFixtureCleanup=false`. A subsequent exact-path process inventory found no installed ForgeDesk or QA smoke Node process remaining.

This signs off the primary user's installed fixed-template B workflow within the stated trusted-local-code limits. It does not establish a genuine second Windows-user result, hardware support, arbitrary compiler/project compatibility, or hostile-code isolation.

### Retained First GUI Failure

`output/playwright/snapshot/development/snapshot-1791967747559` retains the first development attempt, including profile screenshots at 1380x900 and 800x600, `failure.png`, `evidence.json`, and `cleanup.json`. Actual GUI enablement used real configuration and native write-denial probes. The defective original arithmetic verifier did execute and write its failed log.

The test sampled the operation's terminal status before the task and originating GUI promise had finished finalization, then incorrectly asserted the task was already failed. Its exit request encountered the application's synchronous protected-operation close-warning modal, which blocked main-process callbacks and inspection. This was a premature terminal-sampling/test-cleanup failure followed by a synchronous close-modal problem, not evidence of a 300-second pipeline timeout. The old dist also predated the final Git-free B fingerprint implementation, so this run is not final B acceptance.

The coordinator authorized cleanup of the owned QA development fixture only. The exact Electron executable, PID 27328, and creation time were independently checked before termination; its native engine children subsequently disappeared. No name-based broad process kill, user application termination, model repair, or hardware action occurred. This forced fixture cleanup is explicitly failed-run cleanup, not normal-exit acceptance. The test now waits for operation terminal, non-running task, and released GUI build control, persists failure evidence before cleanup, and bounds graceful cleanup. Main owns the asynchronous deduplicated warning fix. A rebuilt development rerun is required.

### Minimum Acceptance Matrix

| Check | Required Observation | Current Status |
| --- | --- | --- |
| Input completeness | Ignored/untracked/binary files, locks and empty directories copied; only `.git` excluded; exact full manifest; B Git fields null | Development and final installed B passed |
| Copy consistency | Source changes observed during copy fail before execution; checked copies match the before/after manifest | Independent native concurrent-copy case passed |
| Historical/current distinction | External original-source edit during execution does not change copied inputs; current evidence becomes stale while historical result is retained | Independent native verification-time edit case passed |
| Model write isolation | Actual native engine probe allows project write and denies the unique protected sentinel write, unchanged bytes, checked receipt/policy/generation | Development and final installed native admission passed |
| Script write isolation | Actual native filesystem and SQLite input/private/template write denial; output-only write; Node permissions deny child/worker/addon/inspector; ordinary missing/early verifier receipt fails | Final installed probes plus runner/engine negative cases passed, within trusted-code limits |
| Output binding | Separate task/operation output, exact declared artifacts and hashes; escaped paths/junctions refused; altered artifact makes current evidence stale | Final installed hash/stale checks and module junction checks passed |
| Protected rules | GUI and IPC cannot replace fixed template/item or upload an isolation receipt; project-local fake Node refused before probing | Main-source integration and development GUI fixed item refusal passed |
| Restart and request key | Reopen retains operations/evidence; same durable key does not reprobe/copy/execute; unknown crashed operation is not replayed | Final installed restart/dedup and source/native crash coverage passed |
| Export and display | Explicit B manifest/proof/artifact hashes and redacted logs; no raw snapshot/secret fixture; readable 1380x900 and 800x600 captures | Development and final installed B passed |
| Actual model B repair | Original fixed-template failure, model-only source repair, strict single-use GUI MCP build approval, new-key authoritative B pass and real diff | Final installed primary-user case passed |
| Genuine second Windows user | Different SID and matching Explorer session; independent install, official login, model, persistence and restart under that SID | Not tested; same-SID negative gate/kit preparation does not satisfy this row |

### Concrete Security Limits

Node's permission model is defense in depth, not a malicious-code security boundary. Its documentation specifically warns about bypass classes including symlinks, already-open descriptors and native interfaces such as SQLite. The B pipeline consequently requires the actual outer Windows sandbox filesystem/SQLite denial checks rather than treating Node permission flags alone as proof. Only the constrained, trusted-local arithmetic template is in scope. [Node permissions documentation](https://nodejs.org/download/release/v24.21.0/docs/api/permissions.html), [Node CLI permission flags](https://nodejs.org/download/release/v24.20.0/docs/api/cli.html).

The verifier receipt is generated by a fixed template, but imported project JavaScript shares its process and can inspect arguments and forge stdout under an arbitrary malicious-module threat model. A nonce and checked output hashes are not a cryptographic anti-cheat signature. Missing/truncated receipts and ordinary early exits must fail; this does not imply resistance to a deliberately forged valid receipt. Stronger hostile-code acceptance would require a separate trusted verifier process or pure-data contract and is not claimed here.

No ACL adjustment or fresh `FORGEDESK_DATA_DIR` converts the current Windows SID into a second user. The independently prepared second-user kit checks the Windows identity and same-session Explorer owner and correctly blocks the primary SID. Actual second-user official login and model evidence remain absent. The primary product home's coordinator-verified ACL tightening is a separate host-security action, not second-user acceptance.

### Second-User Entry Prepared

The coordinator reports creating the authorized standard local `ForgeDeskTest` account, SID `S-1-5-21-1196670755-766692816-2897134863-1006`; QA did not create the account, handle its password, change DACLs, or perform its first desktop/official product login. The user subsequently completed first desktop login and kit installation, then independently authorized ForgeDesk. Full second-user acceptance remains **pending**.

After that user normally signs in to their own Windows desktop, completes kit Preflight/Install/Launch and their own official ForgeDesk authorization, they must close ForgeDesk normally. From the repository root, in a clean non-elevated PowerShell, the dedicated installed B entry is:

```powershell
npx.cmd --no-install tsx tests/second-user-snapshot-smoke.ts
```

It accepts no path, identity or mode arguments. External Node must be version 24.12 through 24.x, not 25+, and Git plus the existing project tsx/Playwright dependencies must be accessible. It does not download missing dependencies and is not evidence of a tool-free clean-machine workflow. Clear ambient `FORGEDESK_SNAPSHOT_*`, `FORGEDESK_DATA_DIR`, `CODEX_HOME`, and `ELECTRON_RUN_AS_NODE` before running. Missing official login is a failure, not permission for QA to log in or copy primary credentials.

`tests/helpers/snapshot-smoke-scope.ts` obtains the real WindowsIdentity/GetCurrent SID, current Windows session, Explorer owner, elevation state and platform account SIDs via the system Windows PowerShell. Primary SID/RID 1002, platform accounts, elevation, and absent/mismatching interactive Explorer fail closed. Every supported override is validated before workflow directories/data/application are accessed; the wrapper completes this preflight before importing Playwright. Node compatibility is checked before path/stat or public kit evidence reads. Existing path ancestors must not be reparse points. The entry verifies the same SID's public kit preflight/install/launch records, frozen hashes of ten installed resources, an external resolved Node executable, Git availability, and absence of a running copy of that SID-derived installation. It does not execute account-management or ACL operations.

Paths are derived, never uploaded or supplied by the caller:

- Installed app: `output/second-user/<actual SID>/install/ForgeDesk.exe`.
- Product data: `.runtime/second-user/<actual SID>/data`; no fallback, read or write to primary `.runtime/app`.
- Model workspace: `.runtime/second-user/<actual SID>/snapshot/<runId>/workspace`, disjoint from product data.
- Redacted evidence/screenshots/exports: `output/second-user/<actual SID>/evidence/snapshot/<runId>/`; report is `evidence.json`.

The report retains the installed B schema and adds `secondUser`, actual `desktopIdentity` and external-tool `dependencies`. The reusable workflow checks public login, real original failure/model-only repair, exact-scope GUI approvals, B inputs/outputs/receipts/hashes, export, full application restart/dedup and freshness. Successful B execution would cover only those observed rows, not automatically sign off refusal/stop/reload, missing tools, uninstall, or every manual second-user kit row.

Independent validation: `tests/snapshot-smoke-scope.test.ts` passed 10/10 with zero failures/skips/cancellations; typecheck passed. Pure eligible identities in these tests are explicitly fixtures, not a Windows-user acceptance result. The actual dedicated command was also run under the current real primary SID 1002: it returned `BLOCKED: current SID is the primary Windows user`, exit 1, before workflow directory creation, Playwright import, app launch or product-data access. No model/app was run and no genuine SID 1006 pass is claimed. The original primary development/installed scope derivation is regression-covered and retained.

### First Actual Second-User Attempt

Preserved evidence: `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791980373836/evidence.json`. Actual SID 1006/session 2 passed desktop and installed-resource gates. Installed 0.2.0 started with engine ready, publicLoggedIn true and hardware disabled. Optional provenance collection then failed at shared-root `git rev-parse HEAD` because the repository belongs to SID 1002. No workflow steps completed; cleanup normalClose=true and forcedFixtureCleanup=false. The Node DEP0190 notice is not the recorded terminal cause; npm's version notice does not require an upgrade for this fix.

The harness fix skips shared-repository Git provenance only in second-user mode, records sourceCommit/sourceDirty as null with an explicit not-observed reason, and records the harness file SHA-256. Primary provenance, owned disposable fixture Git operations, actual identity gates and installed-resource hash checks remain intact. No global/system Git trust configuration is changed. Regression checks do not replace a new actual SID 1006 run.

Post-fix validation: 14/14 targeted tests, TypeScript check, and coordinator full suite 115/115 passed (zero failed/skipped/cancelled, 158.023 seconds). The installed runtime and installer were not changed or rebuilt. Actual second-user rerun remains pending.

### 0.2.1 SQLite Long-Path Repair

The next actual SID 1006 run, `snapshot-1791981176577`, reached the real model and changed only `numbers.mjs`, but both builds failed at `sandbox_probe`: filesystem output writes succeeded while SQLite output could not open. It did not reproduce the arithmetic verifier failure or establish a passing repair. See `SQLITE_LONG_PATH_FIX.md` for the preserved evidence and independent 273-character path reproduction.

Runtime commit `c22b5a5b5660393775b5015714c5b48bd584d810` changes only the Windows SQLite argument representation and release version to 0.2.1. Targeted probe checks passed 9/9, including an actual native sandbox long-path module regression; these are primary-user checks, not a second-user or model admission pass. The harness now requires a verifier-stage exit 1 after complete sandbox/Node permission receipts before calling the original build an arithmetic-defect reproduction. Seven diagnostic/strict-assertion regressions passed.

The first full 0.2.1 regression run passed 123/124 in 138.872 seconds. The single failed existing elicitation diagnostic test returned an empty response list. Its fixture used a fixed 30ms reply timer; a new delayed-response regression reproduced the failure before the fixture was changed to reply only after the matching cancellation response. Both targeted elicitation tests then passed. No production engine code, permission policy or timeout changed. This initial failure remains part of the record; final rerun and installed-package checks are recorded separately below.

Final coordinator validation: 125/125 tests passed, zero failed/skipped/cancelled, 175.206 seconds; TypeScript passed. Installer creation and primary installation exited zero. Installer SHA-256 is `9375c0d22d57b9cfabf5be0df8e85a3fec66a17039f511ae97bcc0a6cf4ebbb9`; installed app.asar is `ed70cea2a18dc4da6665635e8558a4490aee42e30a1dee22ca4b0b056a2eca24`; installed sandbox-probe.mjs is `5506abee15a8b7c58abf65905f8a1479af13c0aba16165aa32bbef8a0ca69e6f`.

Installed 0.2.1 fixture evidence `output/playwright/snapshot/installed/snapshot-1791982555423/evidence.json` passed initial verifier failure, fixture correction, B input/output/hash checks, export, whole-app restart/dedup, source/artifact invalidation and final fresh pass. Both viewport checks passed, no page errors, normalClose=true and forcedFixtureCleanup=false. This run used a separate unauthenticated primary-user fixture data directory and manualFixtureCorrection=true; it is explicitly not a real-model or second-SID acceptance result. The installed runtime hashes above match the final package. Actual SID 1006 must upgrade through the kit and rerun its dedicated real-model entry.

After freezing the 0.2.1 package hashes, coordinator scope/provenance/diagnostic targeted tests passed 21/21. The PowerShell upgrade-policy memory regression independently passed 24/24, covering the explicit existing-account upgrade, original FirstUse gate, and all-ten-resource matching/missing/modified cases. These checks neither install under SID 1006 nor read its product or authentication data.

### Actual 0.2.1 Second-SID Pass

On 2026-10-14, the user completed the upgrade and ran `snapshot-1791984171287` from ForgeDeskTest SID 1006/session 2. Public evidence under `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791984171287/evidence.json` records result=passed, realModel=true, secondUser=true, version 0.2.1 and publicLoggedIn=true. Its SHA-256 is `ffc464d08c9a928ee0f520f0f56c906749524858c7bc01500586454e5851587b`. Recorded test-script SHA-256 matches the reviewed current harness; installed resource hashes match the frozen package.

Model gpt-6.1-sol first observed a genuine arithmetic verifier exit 1 after valid sandbox/Node permission checks, then changed only numbers.mjs and obtained a passing B build using a different requestKey. Both approvals were actual renderer-button allow-once decisions. The three fixed checks passed, five other inputs were unchanged, and no input files were added or removed. Snapshot/probe/manifest/artifact and export checks passed, as did whole-app restart, durable retry without a new probe or execution, source/output staleness and a final fresh build. Both viewport sizes passed, pageErrors and failures were empty, cleanup was normal with no forced termination.

This is a passing actual second-user fixed-template software workflow, not complete second-user matrix acceptance. Remaining process-owner/control/cross-account-denial/missing-tool/uninstall coverage and review boundaries are recorded in `SECOND_USER_RESULT.md`. No new app/model execution or private authentication-file read was performed by the coordinator during evidence review. Earlier failed runs remain unchanged.

## Remaining Second-User Tooling Preparation

The 0.2.1 installed runtime is unchanged. Additional second-user controls, process-PATH missing-tool diagnostics and scoped ACL/uninstall tooling are being prepared under `docs/SECOND_USER_REMAINING.md`. The existing SID1006 real-model B pass remains `snapshot-1791984171287`; these new scenarios require separate actual SID1006 observations.

- Coordinator full regression with the first frozen control/missing-tool assertions: **137/137 passed**, zero failed/skipped/cancelled, 163.951 seconds. Raw output: `output/second-user-selftest/remaining-preparation/full-suite.log`.
- The first TypeScript pass found one test-only save-dialog mock missing the required `filePath` field; the fixture was corrected. Final unified TypeScript passed. After the final no-kill cleanup refinements, the 16 focused control/missing-tool/no-kill tests passed, zero failed/skipped/cancelled; 35 PowerShell pure-gate checks also passed. Logs and the readiness index are in `output/second-user-selftest/remaining-preparation/`.
- Independent review required pre-read restriction of the public canary manifest path and separation of uninstall action records from subsequent verification records. Neither fix changes product permissions or reads credentials.
- Missing-tool checks intentionally inject PATH only into one installed application process. They do not establish that system Node/Git are uninstalled, or that a clean machine has no development dependencies. Uninstall remains a separate explicit final action after non-destructive evidence review. Hardware remains deferred.
- Actual primary SID1002 negative gates rejected all three execution entries before starting the second-user app or reading its private data. The no-kill helper verifies and removes only the newly introduced Playwright launcher exit hook before a failed harness may exit with the product still open; unknown hooks require human closure. The initial cleanup observed launcher exit zero and no termination signal; the later PID follow-up below adds separate actual-main/native-process absence checks. No actual SID1006 controls, ACL denial, missing-tool or uninstall pass is claimed by this preparation.

### Canary Relative Path Follow-Up

The user reported the relative `-CanaryManifest` invocation failing at the exact public directory/filename gate, before any manifest or marker read. Independently reproduced: with PowerShell location at this project and `.NET Environment.CurrentDirectory` at `C:\Windows`, the old `IO.Path.GetFullPath` resolved `./output/...` under `C:\Windows` and caused that gate error. The script now resolves paths using the PowerShell FileSystem provider before applying the unchanged exact-directory/filename, canary contract and reparse gates. No ACL, identity rule or product runtime changed; no live second-SID read-denial pass is claimed.

Coordinator rerun passed 55/55 pure PowerShell gates, including 20 new path-resolution and pre-read rejection checks. Evidence: `output/second-user-selftest/remaining-preparation/path-fix-gates.json`. The existing 35-case preparation result remains historical; no live application or model was started for this fix.

### Controls UTF8 Prefix Follow-Up

Actual second-SID run `snapshot-1791988175683` reached the native waiting command, then failed the exact command-body guard before clicking Stop. All five control outcomes remain pending. Public evidence SHA-256 is `8f1df51d58f13cd8bed2b2ece6d8b0c0be29d5dc48ac678dcbc8a2b8593545e2`; it records 0.2.1, SID1006/session 2, public login true, gpt-6.1-sol, hardware false, zero page errors and reported normal closure without forced cleanup. Subsequent PID investigation established that its observed exit zero belongs to the launcher, not an independently observed Electron main exit. The leading Node DEP0190 warning was not the assertion failure.

The actual command body contained the fixed `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}` prefix and one LF before the exact 45-second wait. The local Codex checkout at `72f999edc7848961b99c4b98bf1e62d12fa35798` defines this constant in `codex-rs/shell-command/src/powershell.rs:13`, adds it without changing the remaining script, and invokes the helper in `codex-rs/core/src/tools/runtimes/unified_exec.rs:582`. This matches the observed process text; that checkout is not asserted to be the vendored binary's build commit.

The harness guard now accepts only the original exact body or one exact LF-terminated prefix followed by that same body. It does not strip arbitrary PowerShell statements or relax the executable/flags, marker, wait duration, PID/creation-time, process-owner or Stop assertions. The entry records the guard helper SHA-256 as well as its own script hash. Earlier failed evidence is preserved; only an actual SID1006 rerun can establish control acceptance. No installed runtime or permissions were changed.

Coordinator verification: 18/18 focused control/missing-tool/no-kill tests passed (zero failed, skipped or cancelled), and unified TypeScript passed. Logs: `output/second-user-selftest/remaining-preparation/utf8-prefix-focused.log` and `utf8-prefix-typecheck.log`. Negative cases include CRLF instead of the observed LF, repeated prefixes, altered encoding/catch blocks, additional commands and encoded-command flags.

### Controls Launcher PID Follow-Up

Actual SID1006 run `snapshot-1791990626067` passed the command guard but failed the application-PID association before Stop; all control outcomes remain pending. Evidence SHA-256: `b61f2b3a0ce18450cbeab265967cd6f466c9a0ac98afd21ba6c2602c8af187b4`. The public ProcessProbe at 15:11:14 UTC observed application PIDs 6552/27392/2036/36712/42232, Codex 5264 and process-host 42584 under the second SID. Its original observation is preserved beside the failed run as `process-probe-observed-before-pid-fix.json`; that alone does not bind the observed app to the harness's actual Electron main identity or complete the controls workflow.

In the locally installed Playwright, `server/electron/electron.js:158-173` passes `shell:true` on Windows, and `process()` exposes the spawned shell process. A standalone primary-user hidden Electron fixture reproduced launcher PID 26932 as `cmd.exe` and main PID 24596 as `electron.exe`, with the main process parent matching the launcher. Evidence: `output/second-user-selftest/pid-probe/evidence.json`. This fixture did not launch ForgeDesk or a model, read credentials, or substitute for second-user acceptance. The first fixture's reporting attempt accessed `app.process()` after disposal and failed; retaining the ChildProcess handle before close corrected only that reporting error.

The fix distinguishes the launcher from the main identity obtained through Electron's main-process `app.evaluate`. ProcessProbe and restart must bind the actual main PID, browser process type and exact installed executable; wrapper exit code zero is labeled as a launcher observation, with separate native-process absence checks. PID identity and raw public probe evidence are retained before assertions. The installed 0.2.1 runtime, SID requirements, resource hashes and permission policies remain unchanged.

A follow-up hidden fixture exercised the actual identity assertions and native window close. Its first attempt established main ownership and launcher exit zero, then exposed Windows PowerShell 5.1 returning empty text for `ConvertTo-Json -InputObject $null`; that failed observation is retained as `output/second-user-selftest/pid-probe/verified-main-before-null-fix.json`. The native query now explicitly emits JSON `null` for an absent PID. Rerun `verified-main-evidence.json` passed with launcher 38724, main 38740, primary SID1002/session 1 and nativeAfter=null. This is a fixture-only check, not a second-user controls pass or a new product/model execution.

Final coordinator verification after both agents froze their changes: 22/22 focused control/missing-tool/no-kill tests passed, zero failed/skipped/cancelled (5.901 seconds); unified TypeScript passed. The focused suite includes actual Windows PowerShell 5.1 queries for its own Node PID and an absent PID, using the same query builder as the controls entry. Logs are `output/second-user-selftest/remaining-preparation/pid-fix-focused.log` and `pid-fix-typecheck.log`. This narrow test-harness change did not rerun the historical 137-case full suite or a real second-user/model workflow. The missing-tool harness also retains its launcher handle before disposal and confirms native installed-process absence before Playwright disposal. Next action is only an actual SID1006 Controls rerun; no installer update, login, canary repeat or uninstall is required.

### Controls Account Routing Timeout

Actual SID1006 run `snapshot-1791995219975` on 2026-10-15 at 00:27 Beijing time failed during the explicit startup connect with `Engine account/read: workspace routing discovery timed out`. Public evidence SHA-256 is `0c8ed1384a2769848acea5d37e2f8ac2b490766c0f9233bad28858e9c1117d5a`; entry and helper hashes match the reviewed PID-fix source. No owned test session or model turn was started, no page errors were recorded, and all control outcomes remain pending. DEP0190 was not the terminal failure.

The same real run confirms the prior fix: Electron main PID 36860, launcher 38076, exact installed executable, SID1006/session 2 and creation identity were observed. Normal window closure yielded launcher exit zero/no signal, nativeMainAfter=null and nativeInstalledProcessesAbsent=true before Playwright disposal. Those lifecycle observations do not establish Stop/MCP/diagnostics/restart acceptance. This timeout alone does not establish invalid credentials or identify a network, proxy or service-side cause; private authentication and engine files were not inspected.

The `nativeInstalledProcessesAbsent` observation in this historical report checks installed ForgeDesk.exe application processes only. It does not independently sample Codex or process-host absence; the current entry labels this scope explicitly. Shutdown source awaits adapter/runner cleanup, but source reasoning is not an independent process-tree receipt. The offline full-chain fixture separately tracks its own engine and host identities.
# Controls Whole-Chain Precheck (2026-10-15)

Fresh complete regression: 163/163 passed, zero failed/skipped/cancelled; typecheck exited 0. Logs are `output/second-user-selftest/remaining-preparation/controls-precheck-full-suite.log` and `controls-precheck-typecheck.log`. The primary SID negative gate still rejects before launching the installed application.

The independent offline Electron fixture passed startup recovery, real child-process Stop, exact MCP refusal, delayed approval rendering, diagnostic export/cancellation/redaction and restart without replay. Evidence: `output/second-user-selftest/controls-offline-1791997297075-psl0a5/evidence.json`, SHA-256 `719ae21a3677f943da39c6fd692cdd55003d0b237478418638de3efb574fdbf0`. Both owned application instances and their test engine/host identities exited normally. This is synthetic-protocol development validation, not real-model, installed-package or SID1006 acceptance. See `docs/CONTROLS_PRECHECK.md` for fixes and remaining boundaries.

# Actual Second-SID Controls Accepted (2026-10-15)

Run `snapshot-1791998032747` passed all five Controls on the installed 0.2.1 under standard interactive ForgeDeskTest SID1006/session2 using the real gpt-6.1-sol model. Public evidence SHA-256: `bc777c05318b7be3cf2ceaa2cfda556c5309d6933dcc2718cd68d3dc5830b806`. Root verified the entry/helper/observer hashes against the tested source, diagnostic export hash, and two screenshots; QA independently reviewed the time and protocol receipts. Both startup connections succeeded on attempt one. No page errors, failures or forced kills were recorded.

The sampled waiting process and child disappeared 30.569 seconds after creation, before the 40-second observation deadline and 45-second natural completion; exactly one original Stop IPC call fulfilled. One exact MCP call was declined after reload, with zero runner operations. Two real main-process instances exited normally around application restart; session/message identities persisted without runner replay. The normal-close absence check covers installed ForgeDesk.exe processes, not independently all Codex/host descendants. Stop historyIncomplete remains true; it is not a complete transcript claim. Shell cancellation, system restart, missing-tools, uninstall and hardware are not accepted by this result. See `docs/SECOND_USER_RESULT.md` and `docs/SECOND_USER_REMAINING.md` for current scope and next step.

# Actual Second-SID Missing-Tools Accepted (2026-10-15)

Run `snapshot-1791999969373159938` passed under standard interactive ForgeDeskTest SID1006/session2 using installed 0.2.1. Evidence SHA-256: `fcb22c870509e0e619b1465dac4a3187cad1b6eabc00b031e2a262df943d8c1a`. Root matched the entry hash to the tested script. Actual public APIs rejected Git with `spawn git ENOENT` and Node with `Executable not found: node` before acceptance persistence or verifier execution. The child PATH matched the empty directory, parent PATH stayed unchanged, and acceptance/profile/operation/evidence/input state remained unchanged. No model turn, test authentication-file read, hardware operation or system configuration change was recorded. There were no failures or page errors; normal close succeeded without forced kill.

This accepts only child-process PATH fault injection. It is not a clean-machine or physical-uninstall test and does not cover absolute Node commands/B profiles. Normal-close native absence covers ForgeDesk.exe, not independently the full engine descendant tree. No code changed for this review; the previous 163/163 regression and typecheck remain version-bound historical results, not a newly executed suite. Full scope is recorded in `docs/SECOND_USER_RESULT.md`.

# Development-Only Continuation (2026-10-15)

At the user's request, additional second-account validation is paused while development-side software work continues; no hardware, actual uninstall or Windows reboot was performed. Coordinator reran the full suite: 182/182 passed, zero failures/skips/cancellations, 109625.6364 ms; typecheck exited 0. Coordinator PowerShell checks passed 118 remaining gates, including 62 uninstall memory gates; the standalone 62-gate script also passed. These counts overlap and must not be added. Logs: `output/software-acceptance/2026-10-15/`.

Eight offline production-GUI controls passed in `controls-offline-1792001365810-fyQBWe`; evidence SHA-256 `eab6ccd0aec6913ac90f985a1d683a59c4f95d4b3ca50c45a8e65a7e9aa2b961`. New shell accept/cancel scenarios bind typed IDs and real client responses after delayed renderer reload; only accept executes one fixed harmless output command. Stale/unsupported/duplicate decisions are rejected. Both normal exits confirm the owned main/test-engine/host identities absent, without force. This is synthetic-protocol development evidence, not live-model or second-SID acceptance.

The harness now bounds close-request and Playwright acknowledgement waits and retains errors even when native exit times out. Pure AST regressions cover these changes. Uninstall preparation now refuses a residual uninstaller without an app/data directory and requires typed, consistent action receipts; tests execute only mocked branches, not uninstallers. Three packaging-configuration tests cover resource selection and data-retention settings, not a built-installer behavior guarantee. Installed runtime and installer remain unchanged. See `SOFTWARE_ACCEPTANCE_CONTINUATION.md` for evidence and deferred manual scope.

