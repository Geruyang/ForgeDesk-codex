# T2 Installed User-Driven Hardware Acceptance

## Scope

This plan covers one reviewed GestureScreen/Challenger V1 target and fireDAP identity. Only the coordinating operator may execute the installed harness or operate the hardware. QA authors and runs pure tests only. No second-account, power-cut, disconnect, or arbitrary-device experiment is included.

The happy path is **user-driven**, not an autonomous model workflow. Model `device.*` remains denied. Entering persistent hardware mode must stop the engine and block `send`/`connect`; leaving mode requires idle service, no unknown-held lock, and revoked grants. These are application gates, not OS device isolation. External same-user processes are outside the protection claim. An unauthenticated dedicated T2 home suffices; no credential is copied from `.runtime/app`. Any later genuine-model activity needs separate evidence and explicit scope.

## Latest Accepted Run And History

Installed 0.3.4 run `t2-1792067819027-e68a72` passed all ten controls in this plan at `2026-10-15T12:40:46.914Z`, with no failures/page errors and harness exit 0. Runtime source: `a8973639413132e15a0acb8f171236a842c1bfd6`. Evidence: `output/t2/t2-1792067819027-e68a72/evidence.json`, SHA-256 `a4ee98757da188d413184974a56dab07ea84cd49e75c827d69835612be58d39d`; frozen plan: `output/hardware/t2-plans/t2-1792067819027-e68a72.json`. Scope is the local fixed Challenger V1 workflow, `realModel=false`, `secondUser=false`. The coordinator operated the visible native confirmation UI under explicit user delegation, with no synthesized dialog return.

Flash readback checked 584,848 defined bytes with zero mismatches. Two nonce/build-ID/UID/CRC-checked CDC responses showed frames `76 -> 78`, SYSCLK/PLL48 `168000000 / 48000000 Hz`, and zero camera errors/timeouts or display errors. M7 normal restart/same-key dedup passed. M8 covers tasks within the same application only; M9 covers graceful close after the erase/program marker only. M6 physical wrong-board/disconnect, cross-process OS isolation, crash/forced termination and power loss remain untested. Second-SID work remains paused. The 79 progress samples are optional telemetry, not pass criteria.

Historical 0.3.2 run `t2-1792065173815-dafb60` passed all ten controls at `2026-10-15T11:58:14.227Z`, with frames `53 -> 56`. Its separate evidence `output/t2/t2-1792065173815-dafb60/evidence.json` and plan `output/hardware/t2-plans/t2-1792065173815-dafb60.json` remain retained; the new pass does not replace or broaden that scope.

Installed 0.3.3 run `t2-1792066168842-c9f6aa` passed build but failed on `state.json` rename `EPERM` before inspect worker startup; no inspect worker started and no flash occurred. The coordinator confirmed no worker remained, then precisely ended the residual application. That cleanup is not a normal-close pass, and the failed evidence remains at `output/t2/t2-1792066168842-c9f6aa/evidence.json`.

Version 0.3.4 supplied its own new installed evidence after durable state-writer and pre-start cleanup fixes; it did not inherit 0.3.2 acceptance. Coordinator final verification passed 286/286 and typecheck, with package/install exit 0. Any later release or rerun needs its own reviewed pins and evidence. Historical 0.3.0 authorization timeout did not flash; historical 0.3.1 flash ended `unknown` with `IPSR=3` and remains a failed attempt. Full history and release pins are in [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md).

The production build uses [UV4 `-j0`](KEIL_BACKGROUND.md). The separate [same-Arm-Compiler IDE-free experiment](KEIL_HEADLESS_EQUIVALENCE.md) compared equal HEX bytes using a frozen zero-build-ID fixture; it is neither a flashed image nor installed acceptance of a replacement build chain.

## Execution Prerequisites

- Root supplies a reviewed JSON plan: exact installed version, runtime commit, executable/installer/resource SHA-256s, repository-contained project, fixed Keil path, pinned profile and board/probe/CDC identity.
- All resources including the external hardware worker and firmware template are pinned. The harness verifies hashes before launch. Old 0.2.1 resource pins cannot be reused for the new runtime.
- Use a fresh `.runtime/t2/<runId>/data`; evidence is retained under `output/t2/<runId>`. Existing runs are never cleared or reused.
- Close the user's application normally. No name-wide process killing, credential-file reading, ACL changes, automatic login, or copied authentication state.
- A reviewed file-chooser substitution selects only the plan's project and repository evidence destination. It restores the original chooser afterward. Keil is fixed by main, with no chooser or path override. **`showMessageBox` is never replaced.** Native flash confirmation must be read and operated in the original visible UI by the human operator, or by the coordinator under explicit user delegation. The latter is recorded as delegated UI automation, never as a direct human click or synthesized dialog return.
- The guarded entry is `node --import tsx tests/embedded-installed-smoke.ts --execute-user-driven <absolute-reviewed-plan.json>`. Root must freeze the plan and new installed hashes before using it. Without both explicit arguments it refuses before launching an application. The harness is not run by QA.
- The latest accepted installed release is **0.3.4**, bound to the run/pins above; new runs still require fresh reviewed plans. The failed pre-inspect 0.3.3 run is not accepted; its precise residual-app termination is not normal-close evidence. The expired 0.3.0 authorization and unknown 0.3.1 flash cannot be resumed as successful writes or reused as current acceptance.

## Actual Installed Matrix

| Step | Required evidence | Failure policy |
| --- | --- | --- |
| Launch/import | Exact native Electron main PID/path distinct from launcher; installed hashes/version; approved project selected in UI; fresh home | Abort before hardware on mismatch |
| Configure | Real UI; fixed project/tool/profile; persistent mode active; engine stopped | No automatic reconnect or mode recovery |
| Model gate | `send` and `connect` rejected; no new session turn/message or hardware operation | Exact engine-call-zero is a separate real-main VM assertion, not inferred from public state |
| Build | Real UI; one successful Keil operation; immutable-in-the-workflow copied-source manifest checked; source/tool/template digests; HEX/AXF hashes and linked unique build ID | Infrastructure errors are not accepted as a firmware result |
| Inspect | Real UI; pinned UID/chip/probe/CDC identity and complete 1 MiB double-read backup with hash | Wrong identity or incomplete backup stops before authorization |
| Cross-task guard | While the real inspect operation is publicly `running`, one public inspect request from an already-created second empty task is rejected; its operation list stays empty | Missing the running window is not a pass; never retry the second request automatically |
| Flash | Original visible native confirmation under human operation or explicitly delegated coordinator UI operation binds exact artifact/build/profile/identity/scope/expiry; consumed grant; one succeeded operation; observed worker exit; actual changed bytes and zero defined-byte readback mismatches | No synthesized dialog return or unrecorded automation, no retry after uncertainty, no timeout-driven kill |
| During-flash close | While the same flash is `running`, read only its owned `phase.json` with matching operation ID and `erase_or_program_started`; request native window close once; original native warning is acknowledged in the visible UI under the recorded operator/delegation scope; same main/window survives and same flash succeeds | Observer only counts the original `showMessageBox` call and passes through its arguments/result/error. No generated response, process kill, simulated crash, power cut or disconnect |
| Verify | Real UI; current-operation FDQ1/FDR1 nonce128, build ID, UID and checks/CRC; succeeded worker exit | Old buffered CDC data/model text is not proof |
| Export | Real UI; approved evidence destination; exported bound build, grant and operation receipts; referenced hashes checked | No private authentication or binding-key contents copied |
| Restart/dedup | Normal close; same home; persistent hardware mode prevents engine start; same request key returns the same terminal record without a new worker/native approval | Unknown/prepared/running recovery is never replayed automatically |
| Tamper preflight | Optional operator-approved final negative step; change only owned copied HEX; new verify request rejected before worker, unchanged operation count; restore bytes and retain failed evidence | Snapshot status is historical, not a current/stale certificate; never flash altered bytes |
| Leave/close | Explicit leave only when idle; grants revoked; normal native main disappearance and launcher exit observed; no force kill | Unknown-held operation remains blocked and requires human recovery |

Capture 1380x900 and 800x600 views at configuration, authorization, final verification and restored delivery. Screenshots redact any account label in the DOM; public logged-in Boolean only if needed. Reports retain failures and are explicit about launcher versus Electron main PID and GUI-only close sampling.

The firmware receipts retain two raw FDR1 frames and independent nonce128 challenges, with timestamps. The harness re-parses their CRC, build ID, UID and decoded counters and binds the sample times to the verify operation. The report also hashes the source parser used for that check. A receipt Boolean alone is insufficient. Flash additionally binds a full pre-program read to the inspect backup hash. The close-warning observer is a disclosed test-only wrapper of a public dialog function, restored after the original promise settles; its source hash is in evidence. Native flash authorization is not counted or altered by it.

## Offline Negative Matrix

Missing/expired grant; wrong UID/probe/CDC; altered HEX/AXF/source/template/tool; duplicate/conflicting request key; unknown recovery/no replay; held lock; forged receipt/old nonce/wrong build ID; malformed frames/CRC; worker timeout without confirmed exit; failure before/after native authorization. These use module/VM/worker fixtures, labeled simulated or source-level, not actual installed hardware proof. No physical interruption is required to claim these offline gates.

## Export-Only Continuation

The service exports an outer destination containing `forgedesk-embedded-<task>-<uuid>/evidence.json`, firmware copies, build records and receipts. The shared export verifier checks this nested layout and every listed file's hash/size plus the source-manifest binding.

`tests/embedded-installed-resume.ts --resume-export-only <original-plan> <failed-evidence> <reviewed-failed-file-sha256>` is reserved for one precise harness-export lookup failure **after** real flash and verify, M8/M9 controls, native grant and normal close have all already succeeded. It rejects pending/expired-before-flash/unknown hardware, different errors, versions, SIDs, homes, plans or resource pins. It also requires the original nested export to be valid, proving the service export itself succeeded. It is not a general retry or a way to finish an unapproved flash.

If eligible, the coordinator launches the same home and performs only UI export, restart, same completed-key dedup, owned HEX verify-preflight tamper/restore, leave mode and normal close. No build, inspect or new flash key is permitted. New evidence lives in `output/t2/t2-<timestamp>-resume/evidence.json`, with the original run/plan/runtime paths, write-once failed-attempt byte copy and SHA-256, original failure text in `priorFailures`, new script/helper hashes and explicit per-control provenance. Original evidence is not overwritten. No such continuation has been executed by QA.

## Acceptance Boundary

Only an actual installed successful build, explicit native UI approval, flash/readback and nonce-bound live CDC result can complete the happy-path T2 scope. Installed 0.3.2 and 0.3.4 supplied separate evidence for the fixed board and their own exact resource pins. Existing board contents matching an earlier HEX, compilation alone, a simulator, root's manual backup, a successful fixture or the zero-build-ID compiler-equivalence experiment does not complete a new release's matrix. UI history remains history when inputs change. The close check covers only graceful-close gating after an erase/program marker while the operation is still running, not the complete M9 crash/power-loss matrix. No claim of arbitrary malicious firmware safety, OS account isolation, autonomous shell safety, full-machine process cleanup, or fault-injected physical recovery is made.

## Current Offline Preparation

`tests/embedded-installed.test.ts` checks the no-auth fresh scope, release/path pins, operation success/dedup, build binding and native-grant lifetime/device binding using pure in-memory data. `tests/embedded-main.test.ts` bundles the actual main source and invokes its actual IPC handler with explicitly injected runtime/service/dialog boundaries. It proves stop-before-configure persistence, no new engine entry in controlled mode, interrupted account discovery not continuing to models, canceled/unchecked native confirmation never dispatching flash, completed-key dedup before dialog, and leave-mode idle gating. These tests do not open Electron, execute Keil, access USB/CDC, or constitute T2 completion.
