# Device boundary and local inventory

## Current Installed Acceptance, 0.3.4

Installed 0.3.4 run `t2-1792067819027-e68a72` passed all ten controls for `gesturescreen-challenger-v1`: build, inspect, flash, verify, export, restart/dedup, mode gate, concurrent-task refusal, during-flash normal-close guard and copied-artifact tamper refusal. Failures/page errors were zero and the harness exited 0. It is the fixed Challenger V1 local user-driven workflow, `realModel=false`, `secondUser=false`. Under explicit user delegation, the coordinator operated the visible original native confirmation UI; the dialog return was not synthesized. Runtime source is `a8973639413132e15a0acb8f171236a842c1bfd6`. See [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md) and `output/t2/t2-1792067819027-e68a72/evidence.json` for resource pins and evidence.

The flash receipt records 584,848 defined bytes with zero readback mismatch. Two independent nonce128 FDR1 responses passed compiled build-ID, UID and CRC checks; camera frames advanced `76 -> 78`, clocks were `168000000 / 48000000 Hz`, and camera errors/timeouts and display errors were zero. Normal restart returned the same completed flash record without replay. Contention was checked between tasks in the same application. The close guard covered a graceful close request after the erase/program marker. Physical wrong-board/disconnect, cross-process OS isolation, crash/forced termination and power loss remain outside this acceptance. Second-SID work remains paused.

The separate `EmbeddedService` uses a pinned portable Python/pyOCD runtime, exact build/artifact/profile/device grants and FDQ1/FDR1 verification. Persistent controlled mode stops the model engine; model `device.*` routes remain denied. The 79 observed stage-progress samples are optional telemetry and never change an operation's failed/unknown result. This is not OS device isolation. The old EngineeringRunner device route remains disabled; the separate local embedded service is the implemented route.

Historical 0.3.2 run `t2-1792065173815-dafb60` also passed all ten controls; its frames `53 -> 56`, evidence and exact release pins remain preserved separately. Historical 0.3.0 approval timed out without flashing. Historical 0.3.1 flash ended `unknown` at `erase_or_program_started` with `IPSR=3`; that operation remains unknown despite the distinct successful later 0.3.2 and 0.3.4 writes.

Installed 0.3.3 run `t2-1792066168842-c9f6aa` passed build, then failed on `state.json` rename `EPERM` before inspect worker startup. No inspect worker started and no flash occurred. The coordinator confirmed no worker remained before precisely ending the residual application; this was not a normal-close pass. The failed evidence remains at `output/t2/t2-1792066168842-c9f6aa/evidence.json`; the distinct 0.3.4 pass does not rewrite that history. The following baseline and unavailable-adapter descriptions refer to earlier checkpoints.

Fixed production builds use [UV4 `-j0` background invocation](KEIL_BACKGROUND.md). The [IDE-free same-Arm-Compiler HEX equivalence experiment](KEIL_HEADLESS_EQUIVALENCE.md) is offline evidence for one frozen zero-build-ID fixture, not a target flash or a production toolchain replacement.

## Historical Hardware Baseline, 2026-10-15

The user now authorizes testing and confirms the physical EmbedFire Challenger V1 / STM32F429IGT6 with fireDAP SWD. Root observed fireDAP 1FC9:5601 serial 594AC1D7613FED24 and separate board CDC 0483:5740 serial 326F32513133 (currently COM4; COM3 is the fireDAP VCOM). STM32 DBGMCU ID was 0x20036419, Flash size 1024 KiB, UID 0037001b3133510432383236. Keil is installed outside PATH at D:/STSoft/Keil5; project-local pyOCD 0.44.1 was added under output/hardware/tooling without global installation or elevation.

Non-halting generic CoreSight attachment, stable full-Flash backup and byte comparison, USB frame reception and runtime diagnostics passed. Debug attachment configures CoreSight access and is not electrically passive. No reset/halt/flash/erase or option-byte changes occurred. See HARDWARE_BASELINE.md for exact artifact hashes, physical test receipts and untested cases. Product device routes remain disabled; stm32-target.ts is a pure candidate/readback validator, not an active adapter or authorization grant.

## Historical Inventory, 2026-10-14

Inventory time: 2026-10-14, Asia/Shanghai. This was read-only enumeration; no port was opened and no probe or flash command was run.

| Check | Result |
| --- | --- |
| `Win32_SerialPort` | No serial ports returned |
| Present USB/PnP devices | Ordinary USB controllers, hubs, Bluetooth and composite devices; no identifiable J-Link, ST-Link, CMSIS-DAP or UART adapter |
| Flash/debug CLI on `PATH` | No J-Link, STM32_Programmer_CLI, OpenOCD, probe-rs or pyOCD |
| Embedded compiler/IDE on `PATH` | No arm-none-eabi-gcc or Keil UV4 |
| Selected board, probe serial, chip target | None supplied or verified |
| Existing embedded project and manual build/flash/UART chain | None identified |

Device writes are disabled. `DeviceUnavailableAdapter` is the runtime default. The only enabled adapter in tests is named `fixture-simulation`, returns an explicit simulated receipt, and does not access hardware. Test results cannot satisfy T2 real-device acceptance.

## Historical Foundation Contract

The trusted runner must own `DeviceOperationCoordinator` and place its journal and authorization lookup outside model and renderer writable roots. At startup it must call `recoverInterrupted()` before accepting device requests. The MCP and renderer may submit requests and reference an authorization ID; only trusted UI approval code may create a grant. Engine command approval does not count as a device grant. Before enabling a real adapter, verify that the chosen profile corresponds to a real board and that the user's existing manual build, flash and UART chain works.

An identity requires VID, PID, probe serial, chip target and recorded evidence. COM number is a connection hint. Authorization matches task, artifact SHA-256, stable device identity, target, profile revision, acceptance digest, policy version and expiry. The coordinator writes request intent before invoking an adapter, deduplicates request keys, and keeps unknown operations out of automatic replay. A lock with unconfirmed process exit remains held even after timeout or runner restart. An adapter must prove process exit to release it; the hardware result remains unknown until separately verified.

The foundation required a fresh 128-bit nonce and expected build binding for each verification. The implemented FDQ1 request sends the nonce, and FDR1 returns the firmware's compiled build ID, UID and CRC; the host compares them with the trusted expected values. The compiled ID is not copied from the request. The real adapter drains stale input and enforces a timeout and bounded read buffer. This checks version freshness, not cryptographic authentication against malicious firmware.

## Enablement Gate And Remaining Physical Tests

1. Identify the user's embedded project, exact target chip, board, probe serial and UART association; record how these were verified.
2. Validate installed drivers and the user's existing manual build, flash and serial test chain with explicit device authorization.
3. Implement a target-specific adapter with process ownership, bounded output, confirmed exit detection and readback where supported. Review any destructive options; full erase, fuses and protection changes are outside the default path.
4. Verify the engine cannot bypass the runner by invoking flash CLIs or equivalent scripts in controlled mode.
5. Keep each physical result scoped separately: installed 0.3.2 and 0.3.4 independently completed normal restart/dedup, fresh CDC verification, same-application task contention and graceful-close gating. Physical wrong-target/disconnect and crash/power-loss recovery still need separate authorization and evidence; offline fixtures do not complete them.
