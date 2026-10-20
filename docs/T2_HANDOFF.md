# T2 Continuation Checkpoint

All paths below are relative to `E:/AiProject/agent-design/ForgeDesk-codex`.

## Current Checkpoint: 0.4.0 Joint Real-Model Acceptance Passed

Installed runtime `b9a61615c564ea560604503ff7190ecc5e8620f0` has executed the
real `gpt-6.1-sol` six-tool/four-operation chain in
`hardware-agent-1792076310974-ba6e7c`, with native grant, readback, live CDC and
eight-file export independently checked. Its overall report remains failed at
the restart comparison (undefined in-memory properties omitted by JSON), and must
never be relabelled passed. The first separate read-only continuation failed on a
native CIM query timeout and retains its own evidence/operator-close record.
The second continuation `readonly-continuation-1792077968892` passed all eleven
controls at `2026-10-15T15:28:47.928Z`, harness exit 0, empty failures/page errors.
Two normal installed GUI close/reopen rounds retained the original completed
run/calls, hardware records and export, with no new model turn or hardware action.
Joint acceptance uses both reports, not a relabelled original or a second flash.

Final evidence:
`output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077968892/evidence.json`,
SHA-256 `995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`.
The original failed evidence remains SHA-256
`aa521ab556b4ab7f7129da61b797bd21a7e5afff9423da56782d1bba65c8ddd3`.

Do not start another model run, build, flash, verify or reuse a consumed grant for
this continuation. Only retained artifacts, public installed state, normal
close/reopen and no-replay checks are in scope. Native approval may derive from
`approved` to `expired` after its original TTL without changing the historical
approved-and-consumed grant or authorizing a new write. Root alone owns any
physical access. Second-SID verification remains paused.

The 0.4.0 package has its own exact hashes and runtime source; the historical
0.3.4 manual scope and manifest must remain unchanged. Complete pre-package
regression passed 402/402 with typecheck; final targeted continuation/harness
tests passed 53/53 separately, with overlap. Final pins and continuation links are in
[T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md).

## Historical Checkpoint: 0.3.4 Fixed-Target Run Passed

Installed 0.3.4 run `t2-1792067819027-e68a72` passed all ten controls with zero failures and zero page errors; coordinator-observed harness exit was `0`. Evidence: `output/t2/t2-1792067819027-e68a72/evidence.json`; plan: `output/hardware/t2-plans/t2-1792067819027-e68a72.json`. Runtime source is `a8973639413132e15a0acb8f171236a842c1bfd6`; installer SHA-256 `055b6c4abe4949c9b4999253a57edc8156ef3203ebabe5579ae050c0b2f3c01f`. Exact executable/resources, firmware and operation pins are recorded in T2_INSTALLED_RESULT.md and the run JSON.

Flash readback verified 584,848 defined bytes with zero mismatch. Two independent nonce128 FDR1 challenges matched compiled build ID `f4b481f80fa970c15dbc1d2eb1ca26113e5a03f6031f1af64d35053612a76b02` and UID `0037001b3133510432383236`, with frames `76 -> 78`, uptime `11657 -> 12011 ms`, zero camera errors/timeouts or display errors, SYSCLK 168 MHz and PLL48 48 MHz. Export verified eight files/four operations, evidence index SHA-256 `d7574577a7cd1bee0bffbb0e5a0fee2296a6d94a0b6c79c17a773f2ff7334950`. Normal closes, restart/dedup, during-flash graceful-close guard and tamper refusal passed for this installed version.

The root coordinator operated the actual native checkbox/Approve and warning OK under explicit user delegation; no synthetic dialog result was supplied. Scope remains `user-driven-fixed-target-installed-T2`, `realModel=false`, `secondUser=false`. Final regression passed 286/286, with successful typecheck, package and installation. Second-SID work remains paused; this result does not establish autonomous product-model hardware access, OS isolation or all physical fault scenarios.

The report contains 79 optional progress samples spanning multiple stages and finalizing; they did not capture every stage or readback. The coordinator separately observed readback 16.7% in the primary live UI tool image in this chat, without saving a separate screenshot file. Independent UI QA is separate, and the archived authorized-flash screenshot shows a later finalizing/unknown-progress state. Neither the ten-control pass nor that observation proves uninterrupted progress rendering. Actual background Keil build passed; continuous window-focus sampling was not performed.

## Historical 0.3.3 Failure Before Inspect Launch

Installed 0.3.3 run `t2-1792066168842-c9f6aa` failed with `EPERM` during the running-state rename from `state.json.<uuid>.tmp` to `state.json`, before inspect worker startup. Build and mode gate passed; inspect operation `ea3c57ad-a397-4db1-8441-e0c8e10884b0` remained `prepared`, and its operation directory was empty with no input, marker, phase or receipt. The original report remains `failed` and `needsHumanClose=true`: `output/t2/t2-1792066168842-c9f6aa/evidence.json`. No subsequent flash or live verification was reached in this run.

`output/t2/t2-1792066168842-c9f6aa/coordinator-cleanup.md` records the root coordinator's cleanup after confirming there was no owned Python, process-host or UV4 worker. Exact installed path and main creation time identified stranded main PID `28604`; the coordinator terminated that specific main, and all four recorded Electron processes were absent afterward. This was forced cleanup of a failed test before device-worker launch, not normal close acceptance and not interruption of an active flash. The failed report, task state and probe lock were preserved; cleanup did not access the board.

The later distinct 0.3.4 run above passed its own installed verification. Preserve this 0.3.3 failure and the completed 0.3.2 success below as separate version-specific evidence.

## Completed 0.3.2 Fixed-Target Run

Installed 0.3.2 run `t2-1792065173815-dafb60` passed all ten controls: build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash graceful-close guard and copied-artifact tamper refusal. Evidence: `output/t2/t2-1792065173815-dafb60/evidence.json`; frozen plan: `output/hardware/t2-plans/t2-1792065173815-dafb60.json`. Runtime source is `5d596985ac8f22a1f7e98a9188dd4c1fc39ae200`; installer SHA-256 is `525d3e88850a0af5c7ea8489ffa2abef588dcdfe8a002eb516ad407f4de37be1`. Full artifact and operation pins are recorded in T2_INSTALLED_RESULT.md and the run JSON.

The successful flash wrote and read back 584,848 defined bytes with zero mismatch. Two fresh independent nonce128 FDR1 responses matched compiled build ID `09cc003f9b234c6a901f52fc250c4f9a8222dd06b4660af13c005cd97602f039` and UID `0037001b3133510432383236`. Camera frames advanced `53 -> 56`, uptime `8520 -> 8879 ms`; camera errors/timeouts and display errors were zero, SYSCLK was 168 MHz and PLL48 was 48 MHz. The board ran this verified firmware at the 0.3.2 checkpoint and later received the distinct 0.3.4 build above; the earlier halted state below is historical. Export checked eight files/four operations; its evidence index SHA-256 is `fd3ed112dffa2f9f2d1f8c90fb79c452d987debdea33abbe46d97887f8b0eb6b`.

Scope remains the fixed Challenger V1 local installed UI workflow, `realModel=false`, `secondUser=false`. The coordinating agent operated the visible original native approval under explicit user delegation (`automatedResponse=true`, `synthesizedDialogResponse=false`). This is not an autonomous product-model hardware path, OS isolation result, direct-human-click claim, or completed physical wrong-device/disconnect/crash/power-loss matrix.

## Historical 0.3.4 Coordinator Continuation

- Keep second-account validation paused and retain all evidence inside the project, including every failed run, the 0.3.3 cleanup record, original backup and the partially erased Flash image.
- The root coordinator exclusively owns all probe/CDC access. Preserve the 0.3.1 flash as `unknown` and 0.3.3 as failed; later successful operations do not rewrite history or replay prior grants.
- Use 0.3.4's completed report and exact runtime source/installer/resources for the current release record. Preserve 0.3.2 acceptance with its own version and evidence; do not substitute hashes between versions.
- Actual installed background Keil builds passed in 0.3.2, 0.3.3 and 0.3.4; continuous focus/window sampling was not performed. Progress samples and screenshots remain supplementary, with UI QA separate from the ten acceptance controls.
- Keep every source archive, installer and document claim bound to its actual version. A successful-release record must never use one of the failed reports.
- Expand physical fault scenarios only with their own actual receipts. Graceful close during flash does not establish crash, forced termination, disconnect or power-loss recovery.

## Historical 0.3.1 Flash Failure

At this earlier checkpoint, T2 was not complete. Installed 0.3.1 run `t2-1792063884804-e2f11c` failed after actual build, inspect, persistent-mode gates and concurrent-task refusal passed. Evidence: `output/t2/t2-1792063884804-e2f11c/evidence.json`; frozen plan: `output/hardware/t2-plans/t2-1792063884804-e2f11c.json`. Flash operation `40f85f16-b2e6-4e60-ad51-30065a20c0ea` consumed its native-approved grant, reached `erase_or_program_started`, and became `unknown` on `FlashFailure: target was not halted as expected after calling flash algorithm routine (IPSR=3)`. Never relabel this as a successful flash or a no-write timeout.

The coordinator collected `output/hardware/t2-integration/fault-readonly-1792064512754796900/evidence.json` and `flash-current.bin`. Recovery was `SYSRESETREQ reset_and_halt`, with no erase/program/resume. Actual chip `0x419`, 1024 KiB Flash and UID `0037001b3133510432383236` were readable again. Two complete 1,048,576-byte Flash reads matched SHA-256 `b70bf5ef3eb2d7312c81d99534cdc53dbd9486bd882483824252c2597479ccdb`; 16,261 bytes differ from the original backup `d89a6f8b49c55d2e504406d5153fbf526c1aa6c872a5c0578a3eda128a0ec07a`. The retained file's first 16 KiB sector is entirely `0xFF`. The board was left halted pending repair at that checkpoint and was subsequently repaired by the successful 0.3.2 flash/verify above. Reset/halt changed debug/target state; the directory name does not imply an electrically passive diagnostic.

The failed run records a human-acknowledged failure-path close warning, a normal GUI close, and absence of installed GUI processes afterward. It does not establish the planned during-flash close guard, live firmware verification, export, or restart/dedup acceptance. Re-enumerate current process identity before follow-up work.

## Historical Post-Failure Continuation

These were the pending actions before 0.3.2's successful installed run; current continuation is above.

- Keep second-account validation paused. Retain both failed installed runs, original backup and post-failure Flash image inside the project.
- The root coordinator exclusively owns all real probe/CDC access. Do not introduce another hardware writer, automatically replay the consumed grant, or infer restoration from readable UID/Flash size.
- At that checkpoint 0.3.2 was being developed for actual operation progress, reset/halt flash preparation and background Keil execution, and was not yet installed or verified. Its later installed result is recorded above separately from 0.3.1.
- Complete and review the repair implementation, validate its offline checks, and freeze the exact candidate installer/resources before an installed attempt. Follow the existing native human authorization path for any new flash grant.
- Record a distinct subsequent recovery/write operation and defined-byte readback, then live nonce/build-ID/UID/CRC/health evidence before successful firmware acceptance. Preserve the 0.3.1 operation as `unknown` regardless of later repairs.
- Complete export hash checks, normal restart/dedup and planned negative checks from actual installed evidence. Physical disconnect/crash/power-loss remain unexecuted unless separately performed.
- Do not run successful-release recording with either failed report. Update final release/acceptance documents only from a completed successful run and retain its exact runtime source/resources pins.

## Historical 0.3.0 Human Action

The following instructions describe the earlier timeout checkpoint and are retained as history; current continuation is above.

1. In the old ForgeDesk native flash dialog, click Cancel. Its grant expired at 2026-10-15 18:48:06 Asia/Shanghai; do not approve it.
2. Close ForgeDesk normally and tell the coordinator it is closed. Keep the Challenger V1, fireDAP SWD and board USB CDC connected.

The old harness timed out without creating any flash operation. Its report is `output/t2/t2-1792060865425-81feaa/evidence.json`; build and inspect succeeded with confirmed worker exit. The application was deliberately retained rather than force-killed while a native dialog was pending. Do not infer the current process identity from the old PID; re-enumerate before any action.

## Historical 0.3.1 Installation Procedure

This procedure was prepared before 0.3.1 installation. That version was subsequently installed and failed its real flash attempt; do not execute this old checklist as the current recovery plan.

- Keep second-account validation paused. Do not read/copy credentials or change user accounts/ACLs.
- Confirm old installed GUI processes exited normally. Do not install over a running application or dismiss a new native approval automatically.
- Verify candidate installer SHA-256 `5e2813796a094b3c0cc4b615a8b9c303129a66b99c29fac16cfa5f3ee421ac3d` against `release/manifest-0.3.1-candidate.json`.
- Install 0.3.1 into the existing `install` directory. The candidate is unsigned. Preserve the old 0.3.0 installer and failed attempt.
- Verify installed resources against `release/win-unpacked/resources` and ensure packaged version is 0.3.1. Then generate the plan with `node --import tsx scripts/t2-installed-plan.ts bdc15c58d868cbfb9b3a3a57266c7d827fbe8874`.
- Review the generated plan, then execute `node --import tsx tests/embedded-installed-smoke.ts --execute-user-driven <absolute-plan-path>`. It uses a fresh, independent no-auth T2 home. No login is required and no credentials are copied.
- Before native approval, use a user-input popup explaining the fixed target/UID and the checkbox plus Authorize button. During the actual flash operation, the test requests one normal close; its native warning needs a human OK. No tool may synthesize either response.
- The 0.3.1 main cancels an unanswered flash dialog at grant expiry. The hardened harness checks actual export bundle layout and can preserve a genuinely successful flash for export-only continuation. This old 0.3.0 attempt has no flash and is intentionally rejected by that continuation guard.
- After a successful installed run, review raw challenge responses, readback, exported file hashes, normal close/restart and old-key dedup. Update T2_INSTALLED_RESULT, ACCEPTANCE, PROJECT_STATE and README from the actual evidence only. Physical disconnect/crash/power-loss remain separately unexecuted unless explicitly tested.
- Rebuild the source archive after final documentation, then use `scripts/record-release.mjs --runtime-source <installed-runtime-commit> --t2-evidence output/t2/<successful-run>/evidence.json`. Do not use that command with the failed or pending attempt.

## Historical Frozen 0.3.1 Candidate

- Runtime source: `bdc15c58d868cbfb9b3a3a57266c7d827fbe8874`.
- Candidate: `release/ForgeDesk-0.3.1-x64-setup.exe` (subsequently installed; its T2 run failed).
- Hardware runtime manifest: `71736b44808ffae3fdc703bfcf57059cb2c646251557f97a1cc4470f153d02b2`.
- Worker: `9f29fbb6279227d76d88e9eb7a5642bc971618711f96abede56d7491f1420256`.
- Trusted overlay manifest: `d69f4e175352d29669d262d92f3da77a3c877d3f0673681d685d4bc667cf04f7`.
- Final source regression: 256/256 and typecheck passed. Candidate runtime integrity and packaged MIT notice passed; none substitutes for installed flash acceptance.
