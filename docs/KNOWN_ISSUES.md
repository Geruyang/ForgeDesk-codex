# Known Issues and Unverified Scope

## Latest FZ3B Scope (2026-10-16)

The [normal PS stop/deploy/start](../output/hardware/2026-10-16-continuation/live-plan/ps-security-1792122514610/execution.json)
passed on the live board, followed by
[seven bounded negative cases](../output/hardware/2026-10-16-continuation/negative-live/1792123089058/stdout.json)
and [one real single-image computation](../output/hardware/2026-10-16-continuation/one-image-live/1792123520180/stdout.json).
Final inference was `STOPPED`, frames 1, error null; R5 `semantic_matches` rose
0 -> 1. The synthetic JPEG / unit-vector `e0` query is not semantic text and
does not establish semantic accuracy or sustained performance. The query snapshot
was replaced, not restored. The runtime can invoke loader preparation; this is
not proof of a newly rebuilt or independently measured loaded PL image.

- [Post-deploy readiness](../output/hardware/2026-10-16-continuation/readiness-postdeploy-live/1792123099122/stdout.json) observed `bind=127.0.0.1` and active/running service; [external 8765/8766 checks](../output/hardware/2026-10-16-continuation/public-ports-live/1792123180641/evidence.json) both returned `ECONNREFUSED`. This is bounded exposure evidence, not a complete network security audit.
- [SSH now succeeds](../output/hardware/2026-10-16-continuation/ssh-audit/1792123494860/evidence.json) with the project key and TOFU host-key continuity. TOFU is not independent chip authentication; HELLO remains compatibility-only. Unique silicon identity and loaded-image attestation remain open.
- The board's initial password was not rotated and SSH password login was not disabled by this work. Key-authenticated test access is not default-account hardening; preserve and verify fallback access when completing that separate security step before using an untrusted/shared network.
- [Enterprise startup/part availability](../output/hardware/2026-10-16-continuation/license-audit/enterprise-check/RESULT.md) passed, entitlement through 2026-12-15. The real full PL run exited 0 with routed timing/DRC and BIT/XSA exports, but its outer result remains FAILED due to the original Tcl's volume-root relative-path defect. [Independent read-only revalidation](../output/hardware/2026-10-16-continuation/pl-build-preparation/revalidation-full-20261016-enterprise-03.md) checks all 21 receipt artifact hashes and exports without rewriting that failure. New native payload equals the pinned candidate008 bytes; no fresh PL programming/readback or installed acceptance is implied. WNS is only +0.006 ns; do not broaden this to environmental robustness.
- The retained v1 archive was CRLF checkout content, not raw Git. The [v2 raw-Git audit](../output/hardware/2026-10-16-continuation/canonical-baseline-v2/raw-git-audit.json) and [v2 manifest](../output/hardware/2026-10-16-continuation/deployment-bundle-v2/manifest.json) correct the baseline without rewriting v1 or waiving its failed preimage check.
- Installed Zynq real-model integration, semantic accuracy, sustained throughput, cold-boot/persistence and physical-fault/recovery acceptance remain pending. Second-SID work remains paused; STM32 T2 evidence does not accept FZ3B.
- The [forward short-path wrapper fix](../output/hardware/2026-10-16-continuation/pl-build-preparation/forward-fix-subst-parent.md) passed offline tests and preflight, preserving strict receipt gates and mapping ownership. It has not yet been exercised by a fresh full Vivado run; it does not relabel the existing outer FAILED result.

See [current FZ3B status](FZ3B_ACCEPTANCE_STATUS.md) for scope and evidence links.
The earlier FZ3B statements below are retained historical records: their
undeployed/SSH-denied/zero-frame limitations were true at that checkpoint and
are superseded only by the explicitly scoped live results above. Historical
evidence has not been altered. Other installed-version boundaries remain intact.

## Earlier Checkpoint And Other Limits

Checkpoint: 2026-10-16, Asia/Shanghai. Installed evidence remains version-bound.
The source fixes validated below are not an updated installed release.

- T1 passed the scoped final installed live-model software workflow on this host/user; arbitrary projects and other environments are not universally accepted. See QA.md for exact evidence and preserved earlier failures.
- T2 is implemented and accepted only for the fixed Challenger V1/fireDAP/GestureScreen scope. Installed 0.4.0's actual restricted-model six-tool/four-operation chain is accepted jointly with its separate passing read-only continuation. The original execution report and first continuation remain failed; neither was relabelled. Current FDQ1/FDR1 verifies an independent 128-bit nonce, compiled 256-bit Build ID, UID and CRC; the earlier 32-bit camera epoch was historical baseline evidence, not the current verification contract. See [T2 installed result](T2_INSTALLED_RESULT.md) and [hardware-agent acceptance](HARDWARE_AGENT_ACCEPTANCE.md).
- T2 does not establish physical wrong-board/disconnect/crash/power-loss recovery, cross-process or OS hardware isolation. Historical 0.3.4 manual contention/normal-close controls are not a repeat of every negative scenario on 0.4.0. Keep the 0.3.0 no-flash timeout, 0.3.1 unknown flash, 0.3.3 failure and later version-specific successes distinct. See [T2 limitations](T2_LIMITATIONS.md).
- FZ3B/Zynq is not accepted by the STM32 profile or installed 0.4.0 hardware evidence. The live follow-up passed unauthenticated status and four bounded invalid-request rejections, plus separate XSDB JTAG identity enumeration without halt/reset/program. Camera telemetry was initially about 25 fps and later 20.891 fps, not a sustained performance pass; inference stayed stopped with zero frames. A separate R5-subset offline compile/link passed, not a full application/PL build or deployed firmware proof. Compute/deployment, authenticated board/loader/runtime identity, unique chip DNA, loaded PL hash and installed FZ3B integration remain unaccepted. Starting inference can implicitly call `prepare-a0005` and change PL/driver state, so compute was not attempted. See [FZ3B acceptance status](FZ3B_ACCEPTANCE_STATUS.md).
- The fixed Codex executable is an official alpha version, not a claimed stable protocol release. Generated types match this executable.
- Unelevated Windows sandbox is weaker than MXC; sandbox escape/device bypass matrix is not accepted. The restricted hardware model exposes only fixed host-owned STM32 actions behind independent native approval, not generic shell/SSH/JTAG or unrestricted autonomous hardware control.
- Code signing is not configured. Installer signing state is unsigned; no instruction to disable Windows protections.
- One engine turn is allowed at a time. Stored sessions can be switched while it runs.
- Manual acceptance items remain pending; no model self-attestation or fabricated pass.
- `engineering.build` is unavailable until the user explicitly enables the single fixed Node arithmetic snapshot profile. It is not an arbitrary-project build interface; Node 24.12+ in the 24.x line is an external prerequisite.
- Evidence A detects input/config/tool/known-artifact changes but is not frozen input or tamper protection. A change restored during execution may evade before/after comparisons.
- Metadata uses atomic JSON with schemaVersion rather than the plan's preferred SQLite. No migration from prior products is attempted.
- UI projections are bounded. Historical gaps are explicit; arbitrary interrupted engine actions are not automatically resumed.
- Historical P3: the 0.2.1-era offline renderer fixture displayed raw `declined` after shell approval cancellation, while the session was correctly interrupted and the command was not executed. That evidence remains preserved. Current `apps/desktop/renderer/App.tsx` maps `declined` to Chinese, so a missing label is no longer a current-source issue. This observation does not upgrade an old installed binary or constitute a new installed UI run.
- Full interactive PTY, second engine, remote execution, arbitrary board support and auto-update are not included.
- T3 actual second-user 0.2.1 B workflow, one-direction ACL canary, five Controls and child-PATH missing-tools checks passed. The full second-user matrix remains incomplete: shell cancellation on this SID, complete descendant cleanup matrix, reverse ACL/default-AppData isolation, actual uninstall/data retention, OS restart and independent clean-machine checks are not accepted. Additional second-account verification is paused by the user; development fixtures do not substitute for it.
- Snapshot B targets trusted local source under tested native writable-root restrictions. It does not protect against arbitrary malicious code, same-user tampering or forged same-process verifier stdout. A missing ordinary verifier completion receipt fails, but receipts are not anti-cheating signatures.
- Project-local account data DACLs are restricted, with narrow existing Electron cache capability exceptions. Actual SID1006 read denial of the one designated primary-owned public canary passed. This is not reverse-direction or full-directory isolation evidence. Shared program files and ancestor directories retain their existing ACLs; this is not a hostile-user secure deployment.

## Software Follow-Up: Source Validated, Installer Unchanged

The [2026-10-16 boundary review](../output/hardware/2026-10-16/software-boundary-review.md)
found the following in the reviewed 0.4.0 baseline using offline actual-source
fixtures, not physical fault injection. The checkout fixes are implemented and
passed the final source/native regression below. Installed 0.4.0 was not rebuilt
or replaced; no installed fault-recovery acceptance is assigned these changes.

- Unknown-owner recovery: the reviewed baseline could dead-end after Stop despite worker exit. The new source recovery path is host-owned and tested for exact exit, wrong task, active planner, unresolved callback/worker and persistence failure; unknown history stays unknown, with no replay or renewed grant.
- Utility-child Stop: the reviewed baseline could wait indefinitely for `close`. The new bounded source tests retain unconfirmed process references/failed state, including kill failure, throw and late-close paths; elapsed time alone cannot establish `stopped`.
- Instruction admission: the reviewed baseline allowed 20,000 renderer characters while main rejected over 12,000. The source now aligns UI admission with the host limit; this was an input-contract issue, not an observed unauthorized write.

Final [full regression](../output/hardware/2026-10-16/full-regression-final.log):
428/428 passed, zero failed/skipped/cancelled, 172715.2433 ms.
[Typecheck](../output/hardware/2026-10-16/typecheck-final.log) and
[source build](../output/hardware/2026-10-16/build-final.log) exited 0.
Separate [renderer regression](../output/hardware/2026-10-16/renderer-regression-final.log)
passed 26/26; it is not added to the 428 full-suite count.
The [real isolated Electron software smoke](../output/playwright/software-20261016-final/evidence.json)
passed eight steps with zero page errors/failures: fixed verifier failure/manual
fixture correction/pass, reload, restart without replay, stale-input detection
and diagnostics. It used no login, real model or hardware and was not a new
installation; the coordinator reviewed its 800x600 screenshot. This software
smoke is not hardware-fault acceptance. Prior 402/402 and 53/53 records remain
separate historical evidence, with overlap; do not add counts.

## Snapshot Native Startup Follow-Up: Source Validated

The [2026-10-16 snapshot report](../output/qa/2026-10-16-snapshot-startup/RESULT.zh-CN.md)
supersedes the open source-level native startup diagnosis, not earlier installed
receipts. The pinned CLI's explicit built-in workspace profile ignored legacy
TEMP exclusions. A fixed named profile now restricts TEMP/TMP writes, retains
workspace metadata protections and validates merged policy at each actual
snapshot command directory before and after execution. The 30-second native
deadline and executable pins are unchanged. Fresh and historical capability
directories, real merged-config rejection and ordinary workspace writes passed.

The expanded complete regression passed 664/664 with no failed, skipped or
cancelled tests; final typecheck, source build and actual development Electron
snapshot smoke also passed. Current B state becomes stale when policy is
unavailable while historical proof remains unchanged; a new explicit build is
required, and durable retries do not replay. This is trusted-template B scope,
not atomic protection against malicious same-SID configuration races. No real
model, hardware or second-account execution occurred in this follow-up.
Installed 0.5.0 was not rebuilt or replaced; its acceptance does not include this
new source fix. Earlier failed results remain preserved, not relabelled.

## Snapshot 0.5.1 Installed Follow-Up

The [2026-10-16 installed snapshot report](../output/qa/2026-10-16-snapshot-installed/RESULT.zh-CN.md)
records the subsequent 0.5.1 package and same-directory installation. Its
primary-SID real-model run passed two actual approved MCP builds (expected
baseline verifier failure, then a model-only source fix and pass), independent
artifact checks, export, normal restart, durable no-replay and stale evidence
checks. The earlier source-only and installed-version statements above are
historical checkpoints, not the current installed snapshot status.

The separate installed GUI/native boundary run passed actual-output-cwd
profile-injection rejection before any outer command, five-stage clean B,
normal window closure and filesystem/SQLite write denials for distinct TEMP,
TMP, protected and workspace metadata directories. Workspace writes had
positive controls. The fixed native deadline remains 30 seconds and installed
resource pins remain checked. Two failed harness attempts remain preserved;
their cleanup-expectation and disabled-config-layer fixture corrections are
documented separately from the passing third run. Final suite counts and
identity checks belong to the linked report, not to historical test totals.

This remains trusted fixed-template, primary-account acceptance, not arbitrary
malicious same-SID code isolation, an atomic config-race guarantee, a new
hardware run or complete exception/crash/network testing. Second-account
execution remains paused. The local 0.5.1 installer is unsigned. Existing
signed FZ3B history was preserved, and no credentials were copied.
