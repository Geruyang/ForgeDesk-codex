# T2 Installed Result: 0.4.0 Joint Real-Model Acceptance Passed

Current checkpoint: 2026-10-15. Installed 0.4.0 runtime
`b9a61615c564ea560604503ff7190ecc5e8620f0` executed the real `gpt-6.1-sol`
scope `real-model-fixed-target-installed-T2`, `realModel=true`, `secondUser=false`.
Original report `output/hardware-agent/hardware-agent-1792076310974-ba6e7c/evidence.json`
remains **failed** at the restart comparison. Its nine physical/model/export
controls passed; restartNoReplay and normalClose remain pending in that report.
Separate read-only continuation `readonly-continuation-1792077968892` passed all
eleven controls and is accepted jointly with this retained execution evidence.
It did not repeat a model turn, build or hardware action. The original overall
result and first failed continuation remain unchanged, not relabelled passed.

## Confirmed 0.4.0 Model And Hardware Chain

The actual model called only `embedded_status`, `embedded_build`,
`embedded_inspect`, `embedded_request_flash`, `embedded_verify` and
`embedded_export`, in order, with empty arguments. Host-owned call/request keys
bind four authoritative operations. Public policy records no execution
environments, disabled external MCP and a fresh restricted thread. Policy/inventory
fixture evidence is not a capture of all live provider traffic or OS isolation.
The coordinator operated the original visible native confirmation under explicit
user delegation (`automatedResponse=true`, `synthesizedDialogResponse=false`);
the model did not supply approval.

| Item | Confirmed original-run fact |
| --- | --- |
| Controller / task | `8918af01-bee3-4d46-a468-c8ecc66bf5d8` / `e61aa04d-8cfd-4625-b35f-f2fe4cda95b7` |
| Build / inspect operations | `d617954d-56ed-44a0-9337-84a00615d898` / `a2f00dcb-7fa6-4312-bee8-4f5be28b092f`, succeeded, process exit recorded |
| Flash / verify operations | `193d6bc5-593c-4206-a36a-aca1180fc9cb` / `eb6a9a3a-f4ea-4682-8b1c-d4641db99b89`, succeeded, process exit recorded |
| Compiled Build ID | `b70be3f97e3cb559b570f945c5f45ab3a2037707f7ca1d1eae983f1dd9abbc2e` |
| Built HEX / AXF SHA-256 | `1037c5c4c305178c86db00fca25ee10dccebb5f14bd67faf8dec049a38995c55` / `580331fadc58f7519b1dfd431da0a20d2a1ac56e9aeff9f7355ee31120b34553` |
| Inspect backup / preflash | Double-read 1,048,576 bytes, SHA-256 `e2ec1106067a5c211f3e44c581ace1aea4d2579fac38bd1b516b435b0588f3d3`; 32 defined bytes differed before flash |
| Flash / readback | Sector erase, smartFlash=false, keepUnwritten=true; SYSRESETREQ/halted/IPSR=0 precommit; 584,848 defined bytes read back, zero mismatch; SHA-256 `d0d562cb2879c23f499d189d745b41d2561747688f0cc22f232ac6424a38c3b0` |
| Independent nonce128 CDC responses | Build ID/UID/CRC matched; flags 31, frames `85 -> 88`, uptime `12979 -> 13340 ms` (361 ms), SYSCLK/PLL48 `168000000 / 48000000 Hz`, camera errors/timeouts and display errors zero |
| Export | Eight hash-checked files / four operations; evidence index SHA-256 `2c064fcf1ef7a2b7ab351866f82f4bd56807d97f5fc894e6d7bf498d253e9bbf` |
| Installed executable / app.asar SHA-256 | `a1ca77d56e099c4e6301495fe049f9df887487383903bbf3feea89d0310868d9` / `c47c4e1f2619e00d13e588ff783b4b8edd444e483274004c29d401e2e27a50ce` |
| 0.4.0 installer SHA-256 | `e95e29b52552c11e66f47aa8eced35703a696e4593a21d6d7d869b8298a4c67e` (unsigned) |

The target remains STM32 chip `0x419`, 1024 KiB Flash, UID
`0037001b3133510432383236`, fixed Challenger V1/fireDAP profile. Independent QA
checked the retained model/worker associations, raw responses, export and fourteen
installed resource pins; this documentation author did not access hardware.

## Original Failure And Passing Read-Only Continuation

The original deep comparison rejected undefined optional in-memory fields absent
after JSON persistence. The model/hardware chain had already completed; two native
normal-close records were retained, but the failing assertion left the original
restart/close controls pending. The original report is retained unchanged as failed evidence,
not a successful report with a corrected label.

The first separate read-only continuation,
`output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077610585/`,
failed on its bounded native CIM query timeout; its failure and
`operator-close.md` are retained. The operator confirmed the idle completed app,
closed it normally and observed the exact main PID absent. The second continuation
passed at `2026-10-15T15:28:47.928Z`, harness exit 0, all eleven controls passed,
empty failures/page errors, no pending cleanup. Its two read-only installed rounds
checked retained public state/artifacts and normal close/reopen without a model
turn, new worker or hardware access. A post-TTL derived approval state `expired`
cannot rewrite the historical approval/consume receipt or be reused.

| Linked evidence / continuation fact | Recorded result |
| --- | --- |
| Original execution evidence | `output/hardware-agent/hardware-agent-1792076310974-ba6e7c/evidence.json`, result remains `failed`; SHA-256 `aa521ab556b4ab7f7129da61b797bd21a7e5afff9423da56782d1bba65c8ddd3` |
| Passing read-only evidence | `output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077968892/evidence.json`, result `passed`; SHA-256 `995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0` |
| Submitted work | Zero model turns, zero hardware actions, no explicit connect; two read-only GUI rounds retained six original calls and four operations |
| Native lifecycle | Main PIDs `12780` and `29328` matched installed executable/primary SID/session/creation identity; normal window-close acknowledgement, launcher 0/null signal and exact native main absence after each close |
| Approval expiry | Original `approvedAt=2026-10-15T15:04:37.974Z`, expires `2026-10-15T15:08:44.400Z`, consumed by original flash; read-only public `approved -> expired` was recorded as actual derived TTL state, not edited in stored evidence |
| Retained artifact checks | Fourteen installed resources, pinned toolchain, firmware/source/export hashes and independently parsed raw FDR1 responses retained; no new live challenge was sent |

The passing report links and hashes the original failed bytes. The continuation
uses the defined JSON persistence view and only documented transient operation
telemetry/validated post-TTL approval differences for comparison; authoritative
calls, request keys, operations, grant history and artifacts cannot change. A GUI
launcher exit is separately labelled and native GUI absence is not an exhaustive
engine/host or whole-machine process-tree inventory. Four continuation screenshots
cover 1380x900 and 800x600 across both rounds. The original model/native operator
record and earlier failed continuation remain available alongside them.

Complete pre-package regression: 402/402, zero failed/skipped/cancelled,
330260.3434 ms; typecheck passed. Logs:
`output/hardware/t2-integration/test-0.4.0-final.log` and
`typecheck-0.4.0-final.log`. Final continuation/harness checks passed 53/53,
zero failed/skipped/cancelled, 18104.4061 ms:
`output/hardware/t2-integration/test-0.4.0-continuation-final.log`. Typecheck also
passed after the last test-only native-query change. The counts overlap and must
not be summed. Physical wrong-board,
disconnect, crash/forced termination/power loss, unrestricted autonomy and OS or
same-SID device isolation remain unaccepted. Second-SID work remains paused.

## Historical 0.3.4 Manual Fixed-Target Revalidation

Historical checkpoint: 2026-10-15. The formal background-Keil manual revalidation was installed 0.3.4 run `t2-1792069554285-c061bf`, **passed all ten controls**: build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash graceful-close guard and copied-artifact tamper refusal. The report has zero failures and zero page errors; the coordinator observed harness exit `0`. Completion was recorded at `2026-10-15T13:14:30.935Z`. Evidence: `output/t2/t2-1792069554285-c061bf/evidence.json`, SHA-256 `728c724034c3481f3c3be0d54fade98f21c2ec93b348d798c11adcf4a12ffd24`; frozen plan: `output/hardware/t2-plans/t2-1792069554285-c061bf.json`.

Runtime source remains `a8973639413132e15a0acb8f171236a842c1bfd6`. The new report's release version, executable, installer and resource hashes exactly match the earlier 0.3.4 report below; no new runtime or package was introduced for this revalidation. The formal route remains pinned UV4 with `-j0`, not the separate headless/direct Arm Compiler experiment. This is scope `user-driven-fixed-target-installed-T2`, `realModel=false`, `secondUser=false`; the coordinator operated the original visible native UI under explicit user delegation (`automatedResponse=true`, `synthesizedDialogResponse=false`). No autonomous-model, second-account or broader physical fault-matrix result is claimed.

| Latest revalidation item | Recorded result |
| --- | --- |
| Build / inspect operations | `76fe7d52-66ac-4b0a-885b-ba4a9eebcaf1` / `5e0557bd-5ebf-4593-87f4-df4c8fa5ca23`, succeeded with process exit recorded |
| Flash / verify operations | `dcb5e06b-0c66-4dea-8a8b-0708af6413e6` / `5684e0b8-5146-47d2-b730-d5e4584ad8b2`, succeeded with worker exit recorded |
| Compiled build ID | `369a39b1d46092b49a58b9e865dc21b6883ddabb7da78a953d2bd1fb612004e1` |
| Built HEX / AXF SHA-256 | `694197ae592a1daf84c4a212d536a000fe7f8596ef18e0175119b0c435d1449d` / `b16a07867917ffde884cdf1c154f54d322ce322edc1ec4880104650fc7610400` |
| Keil process exit / log SHA-256 | `0` / `6bb8336b69338a5109e6f5323ca62cef95aca214ef6b94291421cce7aca5f687` |
| Precommit / changed bytes | `SYSRESETREQ`, halted with `IPSR=0`, bound preflash hash unchanged; 32 defined bytes differed before programming |
| Defined-byte readback | 584,848 defined bytes, zero mismatch; readback SHA-256 `e2ec1106067a5c211f3e44c581ace1aea4d2579fac38bd1b516b435b0588f3d3` |
| Live CDC verification | Independent nonce128/raw FDR1 responses, CRC/UID/compiled build ID checked; flags `31`, frames `264 -> 266`, uptime `37977 -> 38350 ms` |
| Live health | Camera errors/timeouts and display errors zero; clocks `168000000 / 48000000 Hz`; UID `0037001b3133510432383236` |
| Export | Eight files / four operations; exported evidence index SHA-256 `9d431e0ca43a42b7a76a96005c23fc283f2a45fe5244c2f57038395a5e4e7ea4` |
| Lifecycle / negative checks | All ten controls passed; two normal closes with launcher exit 0/null signal and installed GUI absent; same-key restart/dedup and copied-artifact refusal passed. GUI absence is not a whole-machine process inventory |

The run retained 60 optional progress samples; these are not pass criteria. M6 physical wrong-device/disconnect, M8 cross-process/OS isolation and M9 crash/forced termination/power loss remain outside this fixed-target pass. Second-SID work remains paused. The earlier 286/286 regression/typecheck/package/install receipts remain evidence for the same frozen release, not newly executed tests for this documentation update.

## Bounded Keil Window Observation For The Latest Run

`output/t2/t2-1792069554285-c061bf/keil-background-observation.json` contains 140 read-only process-metadata samples over a roughly 150-second window (`13:07:25.1791581Z` to `13:09:55.8328244Z`). Twenty-two samples observed the actual UV4 PID `17804` with the exact executable/run command, including `-j0`; all 22 reported `MainWindowHandle=0` and an empty title. They are observations of one process, not separate process launches.

The observer stopped at its deadline before build finalization (`13:10:19.491Z` terminal record). It did not cover the full UV4 lifetime or its exit; post-process hashing means build finalization is not a UV4 exit timestamp. `keil-window-samples.json` adds four sparse UV4/uVision-filtered window lists, all empty; the first three precede UV4 creation and the last lies outside the confirmed-alive sampling interval. No foreground PID or exhaustive hidden-window enumeration was captured. Thus the observation supports sampled main-window absence and the formal background command, **not** continuous no-focus-steal/no-window behavior, every child/compiler window or an OS-wide process-tree proof. See [KEIL_BACKGROUND.md](KEIL_BACKGROUND.md) for the full sample interval and interpretation.

Observation SHA-256: `9c3ba5c450b3f54901d36900b6b2308c8a1fe997699515217754dceb0ba02c4b`; sparse window-list SHA-256: `91bc0b316f1eed6456d918d782cb8051fb219c4fa8183caa28e6806cb99228f0`. The direct/headless same-Arm-Compiler comparison remains an offline zero-build-ID experiment, not the formal UV4 production replacement or a flashed acceptance image.

Independent retained-artifact verification accepted this scope in `output/t2/t2-1792069554285-c061bf/independent-audit.md`. It checked the retained inputs, artifacts and raw frames without launching software or hardware operations. Defined-byte readback results remain the bound worker-receipt claims; no raw full readback dump was retained for an independent rehash, and the audit is not a second hardware measurement.

## Earlier Accepted 0.3.4 Run

Earlier checkpoint: installed 0.3.4 run `t2-1792067819027-e68a72` **passed all ten controls**: build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash graceful-close guard and copied-artifact tamper refusal. The report has zero failures and zero page errors; the coordinator observed harness exit `0`. Completion was recorded at `2026-10-15T12:40:46.914Z`. Evidence: `output/t2/t2-1792067819027-e68a72/evidence.json`; frozen plan: `output/hardware/t2-plans/t2-1792067819027-e68a72.json`. The board returned live verified firmware responses after that distinct successful write.

This is the fixed Challenger V1 installed local UI workflow, scope `user-driven-fixed-target-installed-T2`, `realModel=false`, `secondUser=false`. Under explicit user delegation, the root coordinator actually checked the original native checkbox, clicked Approve, and acknowledged the original during-flash close warning. The harness did not supply a synthetic dialog result; the report records `automatedResponse=true`, `synthesizedDialogResponse=false`. This does not establish an autonomous product-model hardware path, OS/account isolation or the full physical wrong-device/disconnect/crash/forced-termination/power-loss matrix. Second-SID validation remains paused.

| 0.3.4 Item | Recorded result |
| --- | --- |
| Runtime source | `a8973639413132e15a0acb8f171236a842c1bfd6` |
| Installer SHA-256 | `055b6c4abe4949c9b4999253a57edc8156ef3203ebabe5579ae050c0b2f3c01f` |
| Executable / app.asar SHA-256 | `282ce1e2aede06b195dad89f26a039a78ae8c502b25bd120b75c368b2022baa3` / `eb5539c2d48484c7f0f0b39aa548fcc75730476144214d3005f3c0db111ddba7` |
| Hardware worker SHA-256 | `00afe49ab02ecc639599eab8fbc54242c293a1bf6674286e94ca389636b35a3f` |
| Build / inspect operations | `224054fe-51ce-498e-900d-b82e6dc3c5ef` / `2227f34f-36d3-4f5e-b761-de6e684ecc50`, succeeded with worker exit recorded |
| Flash / verify operations | `81440278-ca2b-48ce-84d0-f9d2f61d645a` / `b9f5fc86-8e54-4505-8850-fb2b1c54b0f8`, succeeded with worker exit recorded |
| Compiled build ID | `f4b481f80fa970c15dbc1d2eb1ca26113e5a03f6031f1af64d35053612a76b02` |
| Built HEX / AXF SHA-256 | `e92090c4ed100838e4c4d2896687a1c31b9ea62e3537bf0759fc0daf64760623` / `4c8673966ba85a7d3cf306492052524cfcb4186de95bc9dd1ef746584c7d8c23` |
| Precommit / changed bytes | `SYSRESETREQ`, halted with `IPSR=0`, bound preflash hash unchanged; 32 defined bytes differed before programming |
| Defined-byte readback | 584,848 defined bytes, zero mismatch; readback SHA-256 `3f7d3ed3118fbab8c628e016c8fe3539825673d3a7cbcaa64900dc2d2f5738d1` |
| Live CDC verification | Two independent nonce128/raw FDR1 responses, CRC/UID/compiled build ID verified; flags `31`, frames `76 -> 78`, uptime `11657 -> 12011 ms` |
| Live health | Camera errors/timeouts and display errors zero in both responses; SYSCLK `168000000 Hz`, PLL48 `48000000 Hz`; UID `0037001b3133510432383236` |
| Export | Eight files / four operations; exported evidence index SHA-256 `d7574577a7cd1bee0bffbb0e5a0fee2296a6d94a0b6c79c17a773f2ff7334950`; bundle path retained in run JSON |
| Lifecycle / negative checks | Graceful close guarded after erase/program marker, two normal closes and restart/dedup passed; tampered copied HEX rejected before verify, then original hash restored; tampered bytes never flashed |

Final regression is 286/286 with zero failures in `output/hardware/t2-integration/full-regression-0.3.4-final.log`. Typecheck, packaging and installation succeeded; supporting logs include `typecheck-0.3.4.log`, `package-0.3.4.log` and `installed-0.3.4-run.log` in the same directory. The installed build also passed through the background Keil invocation; continuous foreground-window/focus sampling was not performed, so build success is not comprehensive focus-suppression acceptance.

The report retains 79 optional progress samples and explicitly excludes progress telemetry from its pass criteria. Samples cover multiple stages and finalizing but do not include every stage or the readback moment. The coordinator separately observed readback at 16.7% in the primary live UI tool image in this chat; no separate screenshot file was saved for that observation, and independent UI QA is separate. The archived `authorized-flash-1380x900.png` shows the later finalizing state with unknown progress, so that file is not evidence of the 16.7% readback moment. These observations do not establish uninterrupted progress rendering across every stage. All retained artifacts remain inside this project.

Independent offline verification is recorded in
`output/t2/t2-1792067819027-e68a72/independent-audit.md`; the coordinator's
separate native UI observation is in `coordinator-ui-observation.md` alongside
it. The audit rechecks retained artifacts, not a second hardware run.

## Historical 0.3.3 Prelaunch Failure

Installed 0.3.3 run `t2-1792066168842-c9f6aa` **failed before the inspect worker launched**. Build and mode gate passed; the inspect UI action failed with `EPERM` renaming a unique `state.json.<uuid>.tmp` to `state.json`. Inspect operation `ea3c57ad-a397-4db1-8441-e0c8e10884b0` remained `prepared`; its operation directory was empty, with no worker input, process marker, phase or receipt. No inspect or flash worker was started for that operation. Evidence remains failed with `needsHumanClose=true`: `output/t2/t2-1792066168842-c9f6aa/evidence.json`.

After confirming no owned Python, process-host or UV4 worker existed, the root coordinator checked installed executable path and exact main creation time, then terminated only the stranded test main PID `28604`; its three recorded Electron children were also absent afterward. `output/t2/t2-1792066168842-c9f6aa/coordinator-cleanup.md` records this forced pre-device-launch cleanup. It is not normal-close acceptance or termination of an active flash; the original failed report, task state and probe lock were preserved. Cleanup did not access the board. At that checkpoint the last successful firmware execution evidence was 0.3.2; the distinct 0.3.4 run above now establishes the latest success.

0.3.3 runtime source was `0b202b12f578f90113831ac147dbbda7d5534d99`; installer SHA-256 `44eac1051c7e1d03079096560ca4e07fcd19fe1b5da9505d75b99bc04c8d8e8d`; executable SHA-256 `35e6df749fadc92c002eb967fa1dfec673eea99ae4bfe53d3eee970064f2572d`; app.asar SHA-256 `4ecc8d39ec97c2cb4aea34be152b7887424c44f10d230de1ff76c3524f1db373`. Build operation `b0957fcb-0a8e-4a3e-a69e-018ba04fbfa8` succeeded with process exit `0`. These build/mode-gate results do not pass the remaining controls; later 0.3.4 acceptance does not alter the failed 0.3.3 report.

## Completed 0.3.2 Fixed-Target Run

Installed 0.3.2 run `t2-1792065173815-dafb60` **passed all ten planned controls**: build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash normal-close guard and copied-artifact tamper refusal. Evidence: `output/t2/t2-1792065173815-dafb60/evidence.json`; plan: `output/hardware/t2-plans/t2-1792065173815-dafb60.json`. Completion was recorded at `2026-10-15T11:58:14.227Z`. The board successfully resumed and returned live firmware health responses, superseding the earlier halted recovery checkpoint. The later 0.3.3 prelaunch failure does not change this version-specific pass.

Scope remains `user-driven-fixed-target-installed-T2` for this Challenger V1, with `realModel=false` and `secondUser=false`. Under explicit user delegation, the coordinating agent operated the visible original native confirmation UI. The receipt records `automatedResponse=true`, `synthesizedDialogResponse=false`; it does not claim a direct human click, synthetic dialog return, autonomous product-model hardware path, or OS account isolation. Wrong-device, cable disconnect, crash/forced termination and power-loss recovery have not passed a complete physical fault matrix. Second-account work remains paused.

| 0.3.2 Item | Recorded result |
| --- | --- |
| Runtime source | `5d596985ac8f22a1f7e98a9188dd4c1fc39ae200` |
| Installer SHA-256 | `525d3e88850a0af5c7ea8489ffa2abef588dcdfe8a002eb516ad407f4de37be1` |
| Executable / app.asar SHA-256 | `e3643f9d68ea98f4fc982f45d400331b6aef23af887d687ba2d1de0114808557` / `2974494e600a0d89a7b4dfca94c6e7bc3b6f1ae7f4b976274a18fef04b192e3e` |
| Hardware worker SHA-256 | `2e1d54df4d094e88ef33fa7cbbc3afd0bf27f8cc1001460358eb5520f4c4336b` |
| Build / inspect operations | `c20d6ff1-59ad-4f6d-80f5-dbc2c8a8853b` / `ae7ae745-ea26-430e-803e-80462b3d67ee` |
| Flash / verify operations | `9bb00f76-2aba-44be-9b38-aecf30ceefb7` / `b54f5585-51d8-40f2-8fb2-9f49ccc44997`, both succeeded with worker exit recorded |
| Compiled build ID | `09cc003f9b234c6a901f52fc250c4f9a8222dd06b4660af13c005cd97602f039` |
| Built HEX / AXF SHA-256 | `b4e13d2607e8c3f1a93f32a096d5bd6faf3ffa2b127fc86652258375f13cc1d9` / `a92f3c59384e5fe7b0a2fb0b723856cac9e9f8c5a8baaaecd9d5071c876d4f8f` |
| Precommit reset | `SYSRESETREQ`, halted with `IPSR=0`; Flash hash still matched the bound post-failure backup before the new write |
| Defined-byte readback | 584,848 defined bytes, zero mismatch bytes; readback SHA-256 `665f9e603b17eb87a3feafa634434395d8e6117b11288977dfa1d2ed4eae24fb` |
| Live CDC verification | Two independent nonce128/raw FDR1 responses; harness rechecked CRC, UID and compiled build ID; camera frames `53 -> 56`, uptime `8520 -> 8879 ms`, flags `31` |
| Live health | Camera errors/timeouts and display errors all zero in both responses; SYSCLK `168000000 Hz`, PLL48 `48000000 Hz` |
| Export | Eight files / four operations; exported evidence index SHA-256 `fd3ed112dffa2f9f2d1f8c90fb79c452d987debdea33abbe46d97887f8b0eb6b`; bundle path retained in the run JSON |
| Lifecycle / negative checks | Graceful close guarded after the erase/program marker; normal close/restart and same completed flash key returned without replay; copied HEX tamper rejected before verify and original hash restored |

0.3.2 introduced operation progress, reset/halt flash preparation and background Keil execution, but progress telemetry was optional and was not a success criterion in its run. 0.3.3 addressed `progress.json.tmp` update conflicts and operation visibility, then encountered the distinct inspect-start state rename failure above. Actual installed Keil builds succeeded in both versions; continuous foreground-window/focus sampling was not performed, so comprehensive focus-suppression acceptance is not claimed. See [KEIL_BACKGROUND.md](KEIL_BACKGROUND.md). All source, diagnostics and retained artifacts remain inside this project.

## Historical 0.3.1 Failure Checkpoint

At the preceding checkpoint, **T2 was not complete**. Installed 0.3.1 run `t2-1792063884804-e2f11c` failed. Actual installed build, inspect, persistent controlled-mode gates and concurrent-task refusal passed. Flash operation `40f85f16-b2e6-4e60-ad51-30065a20c0ea` reached `erase_or_program_started`, then ended `unknown` with `FlashFailure: target was not halted as expected after calling flash algorithm routine (IPSR=3)`. Preserve `output/t2/t2-1792063884804-e2f11c/evidence.json` and its frozen plan `output/hardware/t2-plans/t2-1792063884804-e2f11c.json`. The later 0.3.2 success does not change this failed operation's terminal state.

Coordinator recovery evidence is `output/hardware/t2-integration/fault-readonly-1792064512754796900/evidence.json`. The recovery performed `SYSRESETREQ reset_and_halt` with no erase/program/resume. Chip `0x419`, 1024 KiB Flash and UID `0037001b3133510432383236` were readable again. Two full 1,048,576-byte reads matched SHA-256 `b70bf5ef3eb2d7312c81d99534cdc53dbd9486bd882483824252c2597479ccdb`, differing from the retained original backup in 16,261 bytes. File inspection of `flash-current.bin` confirms the first 16 KiB sector is entirely `0xFF`. At that diagnostic checkpoint the target was halted and had not been restored; successful recovery was subsequently established by the distinct 0.3.2 flash/verify above. This diagnostic reset/halt is an active debug operation despite the evidence directory's `fault-readonly` name.

At that earlier checkpoint, 0.3.2 was still being developed and had no installed acceptance. The current 0.3.2 receipts above supersede that pending status while preserving the 0.3.1 failure and diagnostic evidence.

## Historical 0.3.0 Checkpoint

At the earlier 2026-10-15 checkpoint, **T2 was not complete**. Actual installed 0.3.0 build, inspect, controlled-mode gates and concurrent-task refusal passed. Run `t2-1792060865425-81feaa` then timed out waiting for human native flash authorization. No flash operation was created or started. The failed report is retained at `output/t2/t2-1792060865425-81feaa/evidence.json`; it recorded `needsHumanClose=true` because its native dialog was then pending. The controller did not synthesize approval or kill the application.

Second Windows account work remains paused. This T2 work does not resume SID1006 testing, account changes, uninstall or Windows restart. Installed 0.3.0 is distinct from the new 0.3.1 candidate, which adds bounded native approval cancellation and the GestureScreen MIT notice. The export harness was also corrected before any target write: it had expected a JSON file directly in the outer export folder, while the service correctly creates a nested evidence bundle. Future completed-flash runs can use a strictly guarded continuation without repeating the flash; this run has no flash and is deliberately ineligible.

## Implemented Local Workflow

The desktop main process now exposes a human-driven local workflow for exactly `gesturescreen-challenger-v1`. Entering persistent engineering controlled mode records the gate and stops the engine; device actions require the engine to be stopped. Model send/connect/shell paths are blocked by application checks while that mode is active, including recovery after restart. Model `device.*` tools remain denied. This is an application execution policy, not OS device or account isolation.

`EmbeddedService` owns copied build snapshots, fixed profile/tool/template identities, per-build random 32-byte build ID injection, operation records, backup binding, expiring consumed grants, an exclusive lock, unknown-operation recovery and evidence export. The configured target is STM32F429IGTx/1024 KiB, chip ID `0x419`, UID `0037001b3133510432383236`, fireDAP `1FC9:5601 / 594AC1D7613FED24`, and separate CDC `0483:5740 / 326F32513133`. Profile configuration is an expectation; the actual inspect receipt is the observation.

The main-process native flash dialog displays the task, probe, UID, HEX SHA-256, build ID, expiry and write scope, defaults to cancel, and requires both the explicit approval button and target checkbox. Only then does main approve the prepared grant and dispatch flash. The 0.3.1 run records a native approval and consumed grant with `automatedResponse=false`, followed by the failed flash. In the successful 0.3.2 run the coordinating agent operated this visible native UI under explicit user delegation; its distinct grant was consumed by the successful flash. A model text response alone is not a completed ForgeDesk native grant.

Firmware implements `FDQ1` with a raw 128-bit nonce and CRC, and `FDR1` with that nonce, the compiled 256-bit random build ID, HAL UID, health fields and CRC. The compiled ID is not taken from the request; all-zero default IDs fail verification. Existing GSCT/GSFR capture remains supported, and the existing single CDC TX owner serializes responses between image frames. See [T2_FIRMWARE_IMPLEMENTATION.md](T2_FIRMWARE_IMPLEMENTATION.md) and [T2_SERVICE.md](T2_SERVICE.md).

## Historical Real Service Preflight

Evidence root: `output/hardware/t2-integration/preflight-1792060052916`. This was the main controller's direct real service preflight, **not an installed GUI run**. It includes a real Keil build and physical inspect/backup, with no flash operation in its records.

| Item | Recorded result |
| --- | --- |
| Task / profile | `t2-preflight` / `gesturescreen-challenger-v1` |
| Build operation | `0fa7b11e-e3f6-49c0-87f2-dcd73ddc07e5`, succeeded, process exited |
| Build ID | `d0fce654281ec619bb529ed9571cb68e3b571a166665267725eb6f7c0c0a6339` |
| HEX SHA-256 | `995ca5a5d61f604f0b6349f066641c7d6c1f43debc2ea7f816f6ebe4ea4e02ae` |
| AXF SHA-256 | `8c9001ff30922397166a4dfb86703c134b436bc437d9902afb9717c9565fe0c6` |
| Snapshot source SHA-256 | `2acb0384cd84d1e87a597b77dafc7d1f68d7ba43c7d72c8b7ca10bdf89cf4b6a` |
| Build process exit / log SHA-256 | `0` / `8dbc97a5c7b8278d6f5fc8c3fac8589b32132557857944a77917c01d04162865` |
| Inspect operation | `bf54d137-89dd-485a-bfd7-ccd3773bb1ba`, succeeded, process exited |
| Actual chip / Flash / UID | `0x419` / 1024 KiB / `0037001b3133510432383236` |
| Backup | 1,048,576 bytes, two complete reads matched |
| Backup SHA-256 | `d89a6f8b49c55d2e504406d5153fbf526c1aa6c872a5c0578a3eda128a0ec07a` |

`build.json` SHA-256 is `38422609a6e632ff09be4d044a88cb3488841363e637a6cea3ab2b5aedb6b82f`; `inspect.json` SHA-256 is `f9c80fec14133b902c8b07333ec4e75c29924bc3e4b53e9e3365d131860772f3`. This historical preflight records build plus inspect only, before either installed flash attempt. Its backup matched the earlier baseline; its own random-ID image was not shown running by that preflight.

## Verification Matrix

| Check | Evidence class | State at this checkpoint |
| --- | --- | --- |
| Earlier exact chip/probe/UID, original HEX readback, 35 camera frames and bounded RAM health checks | Real hardware through coordinator tools, original firmware | Passed within [HARDWARE_BASELINE.md](HARDWARE_BASELINE.md); not installed T2 |
| Final protocol sender, default/nonzero ID, queue/reset/TX boundaries | Actual native C execution with hardware mocks, independent Python wire checks | Passed; [T2_FIRMWARE_IMPLEMENTATION.md](T2_FIRMWARE_IMPLEMENTATION.md) |
| Default and injected-ID firmware compilation | Actual offline Keil toolchain | Passed, 0 errors/0 warnings; not target execution |
| Service grant/expiry/tamper/dedup/unknown/lock/export and main model gates | Module/VM/worker fixtures | Test coverage is separate from physical acceptance; final suite receipt belongs to controller |
| Preflight snapshot build | Real direct service with actual Keil | Succeeded, exact artifacts above |
| Preflight identity and full backup | Real direct service with physical board | Succeeded, backup unchanged |
| Latest installed 0.3.4 attempt | Actual installed UI/main and target | All ten controls passed, zero failures/page errors; final regression 286/286 |
| Historical installed 0.3.3 attempt | Actual installed UI/main | Build and mode gate passed; inspect-start state rename failed before worker launch, remaining controls unpassed |
| 0.3.3 failure cleanup | Exact owned-process identity and no-worker check | Forced cleanup recorded, not normal-close acceptance; original failure retained |
| Frozen installer/executable/app.asar/worker/runtime/template pins and installed launch | Actual installed binary | Passed for 0.3.4; latest successful plan `output/hardware/t2-plans/t2-1792069554285-c061bf.json`; earlier plan retained separately |
| Enter persistent mode and exercise installed model gates | Actual installed UI/main | Passed for 0.3.4: send/connect denied, no public session mutation; realModel=false |
| Exact native dialog reviewed and approved under user delegation | Actual visible native UI and recorded grant | Passed for 0.3.4; root coordinator operated checkbox/Approve and warning acknowledgement, no synthesized dialog return |
| Consumed grant, one actual flash, changed bytes and zero defined-byte readback mismatch | Actual installed service plus target | Passed for 0.3.4: 584,848 defined bytes, zero mismatch. Historical 0.3.1 flash remains unknown |
| Fresh FDQ1/FDR1 nonce/build ID/UID/CRC/health after that flash | Actual installed service plus target | Passed for 0.3.4 with two independent nonce128 responses; frame and uptime counters advanced |
| Installed export with checked hashes | Actual installed UI/evidence | Passed for 0.3.4: eight files / four operations |
| Normal restart, persistent mode and same-key terminal result without replay | Actual installed lifecycle | Passed for 0.3.4; same flash operation returned, no repeated write |
| During-flash normal-close guard | Actual installed lifecycle after erase/program marker | Passed for 0.3.4; not a crash, forced termination, disconnect or power-loss test |
| Copied-artifact tamper refusal before worker | Installed verify preflight negative check | Passed for 0.3.4; copied HEX restored, tampered bytes never flashed |
| Concurrent second-task request during real installed inspect | Actual installed UI/main with active real worker | Passed for 0.3.4; second task rejected and no operation added |
| Wrong-device/disconnect/power-loss/uncertain flash physical recovery | Physical fault scenarios | Actual 0.3.1 uncertain flash retained; distinct 0.3.2 flash/verify restored running firmware. Full physical fault matrix remains unexecuted |
| Second-account full matrix | Actual SID1006 workflow | Paused, not advanced by T2 |

## Historical 0.3.0 Attempt And Remaining Work

0.3.0 runtime commit: `de2067109981194544f4e18d583abb9431324312`.
Installer SHA-256: `6d9d6ece95d9e788202755ec79422f63cb8b00a6ee94feff760f403c0874cc19`.
Installed app.asar SHA-256: `aef0f4ce3bfddcdda54e9baa9aa4fc98ec0bde697b496cb0ee23eccb51711b97`.
Installed run build ID: `0fb833b6e3ba85b3238fe83d2826afe42f91c8da47aa6b5916cffe31fabbd90a`.
Built HEX SHA-256: `adda3a52cdbfc70abc9b1dd11eaf09f57b129f77aaf086776f65e48db2169fdc`.
The image was not flashed. The full backup still matches `d89a6f8b49c55d2e504406d5153fbf526c1aa6c872a5c0578a3eda128a0ec07a`.

The original native authorization expired at `2026-10-15T10:48:06.838Z`; approving it later cannot start flash. The human has been asked to cancel that dialog and close the old application. Only then can the new candidate be installed and a fresh reviewed plan run. Remaining real checks are native approval, flash/readback, during-flash normal-close guard, live nonce-bound verification, export, restart/dedup and artifact-tamper refusal. Physical disconnect/crash/power-loss remain separate unexecuted scenarios. Do not relabel this failed attempt as passed.

Offline regression before the follow-up fixes: 250/250, `output/hardware/t2-integration/full-regression-final.log`. Version-specific follow-up results will be recorded separately.

### Historical 0.3.1 Candidate Preparation

Runtime source commit: `bdc15c58d868cbfb9b3a3a57266c7d827fbe8874`. Installer `release/ForgeDesk-0.3.1-x64-setup.exe` SHA-256: `5e2813796a094b3c0cc4b615a8b9c303129a66b99c29fac16cfa5f3ee421ac3d`. Candidate metadata: `release/manifest-0.3.1-candidate.json`; source: `release/ForgeDesk-source-0.3.1.zip`. This was the candidate-preparation checkpoint; 0.3.1 was subsequently installed and failed its real flash attempt below. The candidate manifest itself does not claim T2 acceptance; the stable historical `release/manifest.json` must not be treated as acceptance of this run.

All 256 Node tests passed (`output/hardware/t2-integration/full-regression-0.3.1-final.log`), and typecheck passed. The unpacked candidate's exact 1,021-file hardware runtime plus worker passed integrity verification in 542 ms without hardware access. Packaged `dist/licenses/GestureScreen.txt` was extracted and matched the upstream MIT file SHA-256 `c5b2cddacd7ac7f5da4bdada3c06c28261f5d77abf73f7d1356943be9ec5ad9e`. These are package/source checks, not installed 0.3.1 acceptance. See T2_HANDOFF.md for the continuation procedure.

The candidate checkpoint required an eventual completed run to record exact source/runtime and installed resource pins, reviewed plan, native approval observations, operation IDs, firmware build identity, readback, export hashes and lifecycle results. The distinct 0.3.2 receipts now provide those results above; they do not promote either historical failed run to success.

## Historical Installed 0.3.1 Failure And Recovery Handoff

| Item | Recorded result |
| --- | --- |
| Run / result | `t2-1792063884804-e2f11c` / `failed` |
| Installed version / runtime source | `0.3.1` / `bdc15c58d868cbfb9b3a3a57266c7d827fbe8874` |
| Executable / app.asar SHA-256 | `02d6c7f5e4a5857c068254fa0c8aecd2c48fc07441f493f6aaa24667c98ae318` / `72788651737e00ec70b3639850a302b1e56e6f360a9dd814a58db323bf38a724` |
| Build / inspect operations | `eb472b4b-a4fd-4097-8276-f2c27965813d` / `35fc5c84-3ffb-462f-9b70-3ed41ba5bf3d`, both succeeded with worker exit recorded |
| Built ID | `1e66926b2709a262ae6240b4d1dcc51b600b56839a9005e3dbbed14d144d9833` |
| Built HEX / AXF SHA-256 | `4a96e043f5e6a84b0d3dbb705ed7a21903dd3c96706e390ba2f36ee6586d6589` / `30c5299eae8a4eb2a06ff826a143a68873213a99e4b58762c386519a46d4759e` |
| Native grant | `c19385c3-32dc-47bd-a5bd-7aabd37cd155`, approved and consumed by flash `40f85f16-b2e6-4e60-ad51-30065a20c0ea` |
| Flash terminal state | `unknown`, stage `erase_or_program_started`, HardFault exception number `IPSR=3`; worker exit recorded |
| Post-failure diagnostic | Reset and halt only; identity readable; double-read changed Flash image retained; target left halted at that checkpoint, subsequently repaired by 0.3.2 |
| Installed GUI close | Failure-path warning acknowledged and normal close recorded; installed GUI absent afterward. This does not pass the planned during-flash-close or restart/dedup checks |
| Acceptance that was pending | Later passed by distinct 0.3.2 run: repair/flash with defined-byte readback, live nonce/build-ID verification, export hashes, normal restart/dedup and planned negative checks |

Do not replay the consumed 0.3.1 flash grant or promote its `unknown` operation to success. The distinct 0.3.2 and 0.3.4 installed runs establish their own successful writes. The root coordinator exclusively owns hardware access; documentation changes do not authorize another writer. The failed 0.3.3 attempt remains failed.

Follow [T2_ACCEPTANCE_PLAN.md](T2_ACCEPTANCE_PLAN.md). Read [T2_LIMITATIONS.md](T2_LIMITATIONS.md) with this result. Historical baseline-stage statements in DEVICE/ACCEPTANCE/PROJECT_STATE about disabled product routes or absent build-ID firmware describe earlier checkpoints. The historical 0.3.4 result establishes its stated manual fixed-board workflow, not model operation. The separate 0.4.0 model chain and passing linked read-only continuation are recorded at the top of this document; neither scope establishes an unperformed physical fault matrix.
