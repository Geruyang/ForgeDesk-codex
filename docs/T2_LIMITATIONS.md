# T2 Limitations

Checkpoint: 2026-10-15. Installed 0.4.0's real-model fixed-target scope is accepted jointly from its actual `gpt-6.1-sol` six-tool/four-worker execution (native authorization, flash/readback, fresh CDC and checked export) and passing read-only continuation `readonly-continuation-1792077968892` (restart without replay and two normal closes). The original overall report remains failed at its restart comparison, as does the first continuation; neither is relabelled passed. Historical 0.3.4/0.3.2 accepted the distinct manual scope (`realModel=false`). See [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md). Second Windows account work remains paused.

## Protection Boundary

Engineering controlled mode persists an application gate, stops the ordinary software model engine, blocks its send/connect/shell paths, and requires an idle service with revoked grants before leaving. Version 0.4.0 can start a fresh restricted hardware-agent thread with only six fixed empty-argument tools: status, build, inspect, request-flash, verify and export. Host code owns target, paths, toolchain, request keys and grants; external MCP and execution environments are disabled by its recorded policy. Ordinary model `device.*` remains denied. These controls do not establish OS-level hardware isolation, a separate security account, prevention of external same-user flash/debug tools, resistance to an administrator, or arbitrary hostile-code containment. The phrase "controlled mode" must not be presented as an OS sandbox. Offline inventory/protocol tests are not a complete live provider traffic capture.

The native dialog and one-artifact/one-device expiring consumed grant are separate from model output, shell approval and authorization granted in this Codex conversation. Source implementation and VM/fixture tests do not prove an installed approval. The actual 0.4.0 run records the coordinator operating the original visible native UI under explicit user delegation, with no synthesized result; it does not claim the model approved itself or a direct human click. Post-TTL derived `expired` status does not undo historical approval/consume and must not permit grant reuse.

Service HMAC records detect changes by callers without the local service key. The key and the service run under the same Windows account; this is not an independent signature, protected hardware key, or boundary against other same-account processes. Copied source, SHA checks, rejected links/junctions and before/after digests bind the documented workflow; they do not make files OS-immutable or prove a general hostile build environment is safe.

## Fixed Target and Tooling

The supported profile is only `gesturescreen-challenger-v1`: reviewed GestureScreen project/target, STM32F429IGTx/1024 KiB, UID `0037001b3133510432383236`, fireDAP serial `594AC1D7613FED24`, and separate CDC serial `326F32513133`. The current machine's reviewed Keil path and tool hashes are pinned. The profile is not a generic STM32 adapter, probe selector, arbitrary firmware flasher or portable clean-machine result. COM numbers are transient hints, not identity.

The fixed overlay contains four reviewed protocol files; it does not replace the complete project or alter the reviewed uvprojx. Every actual build injects a fresh random 32-byte build ID into its own copied header. Baseline diagnostic addresses belong to their original AXF and cannot be reused for the changed image without extracting a matching layout. A successful old HEX-to-Flash comparison does not establish the new random-ID image is running.

The earlier preflight build/inspect were direct controller/service actions, outside an installed GUI workflow. That historical backup remains `d89a6f8b49c55d2e504406d5153fbf526c1aa6c872a5c0578a3eda128a0ec07a`, 1 MiB, two reads matched; no preflight flash was recorded. Later installed runs, including 0.4.0, performed their own distinct writes/readback/live checks and must use their own exact hashes. The root coordinator alone owns physical devices. This document's author did not access a probe or serial port.

## Protocol and Health

FDQ1/FDR1 binds a fresh 128-bit nonce, compiled 256-bit build ID, UID and CRC to the current challenge. It supplies workflow identity/freshness evidence when combined with trusted build/download/readback. CRC and nonce echo are not cryptographic authentication against malicious firmware. A zero build ID must fail verification. A historical success record is not a new challenge or a current target observation.

There is one bounded query slot including its in-flight response. A full slot drops further requests and the host retries; no per-request queued-response guarantee is claimed. Responses serialize between GSFR frames. An active frame may delay a response through its existing 3000 ms frame timeout. Existing explicit STOP/expiry/cookie changes can truncate a frame; the old receive resynchronization contract remains necessary. Reset drops old query/RX state, and submission also checks the connection generation.

Health flags/counters are individually sampled running values, not a coherent multiword diagnostic transaction. SDRAM-ready records startup testing, sensor-ready records successful sensor ID/configuration, and flash-profile-match records a JEDEC ID. These do not prove continuous memory integrity, image/color correctness, external flash contents, LCD visual quality or gesture/model accuracy. A static reader screen need not advance its display-frame counter. Fault diagnostic registers are recorded snapshots, not continuously sampled core state. A full-frame CRC proves transport integrity for those bytes, not scene or model correctness.

The historical baseline camera observation was 35 original GSFR frames over 10 seconds, with matching UID, random 32-bit epoch, frame CRC and changing counters. It predates FDQ1/build-ID firmware and cannot be relabelled as installed verification. The separate 0.4.0 responses do bind two independent nonce128 values, compiled Build ID, UID and CRC with advancing frames/uptime; their bounded health counters still do not establish visual quality, gesture accuracy or continuous peripheral correctness.

## Process and Failure Scope

Intent records, request-key deduplication, exclusive locks, tracked native workers and unknown-state recovery are implemented. Timeout or aged lock state is not proof a hardware operation ended. Unconfirmed exits keep operations blocked; recovery must not replay an unknown flash or convert unknown into success. Historical 0.3.1 reached an uncertain flash and a distinct later 0.3.2 write restored verified firmware; this does not cover every uncertain recovery. Same-application contention and graceful-close guards passed in the historical manual scope, not cross-process isolation or the entire 0.4.0 negative matrix. Actual power removal, physical disconnect during erase/program and wrong real board/probe fault injection remain unexecuted. Module/VM/worker fixture tests provide software evidence only.

The write scope is the reviewed internal-Flash image with required sectors/readback and target reset/run after an explicitly approved flash. It does not authorize option-byte/protection/fuse changes, external memory writes, whole-chip erase beyond that scope, arbitrary debugger actions or automatic retries after uncertainty. The 0.4.0 receipt records sector erase, smartFlash=false, keepUnwritten=true, precommit SYSRESETREQ/halt/IPSR=0, and 584,848 defined bytes read back with zero mismatch. Its subsequent read-only continuation must not replay the model or any hardware operation.

Normal exit and native process-host checks concern the application's tracked workers. They do not prove cleanup of every process on the machine or remove external users of the device. The original 0.4.0 report records worker exits and two normal GUI closes but failed its restart assertion; the separate read-only continuation passed two restart/no-replay rounds and normal closes with no new submitted work. Native application absence checks cover the exact Electron main/installed ForgeDesk GUI, not a full engine descendant inventory. A GUI launcher exit alone is not native Electron main exit proof.

## Evidence and Acceptance

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Source review and implemented UI/service | Intended local contract and code paths | Installed execution or human approval |
| Native C test with hardware mocks | Real sender-state-machine execution for specified fixtures | Physical USB timing, camera, probe or target flash |
| Python protocol/VM/worker/service fixtures | Bounded software rejection/recovery cases | Fault-injected hardware recovery |
| Actual Keil compilation/AXF ID bytes | Build succeeded and compiled ID exists | Target running that image |
| Direct real service inspect plus backup | Observed target identity and preserved internal Flash | Installed native grant/flash/verification |
| Historical original-firmware live frames/RAM | Scoped baseline device operation | New firmware freshness or full peripheral acceptance |
| Actual installed model/hardware happy path plus passing linked read-only continuation | Only its exact binary/model/target/run and accepted controls, without model/hardware replay | Relabelling the original failed report, all T2 negatives, arbitrary projects or OS isolation |

Exact 0.4.0 runtime/installer/resource, firmware and export hashes are recorded in [T2_INSTALLED_RESULT.md](T2_INSTALLED_RESULT.md) and its public evidence. Joint acceptance preserves the failed original and accepts only its linked passing read-only continuation, not a rerun or erased failure. Historical software/manual results cannot be attributed to a new binary or scope. No full M6-M9 hardware fault gate, complete second-account acceptance, unrestricted autonomy or security certification is claimed. See [T2_ACCEPTANCE_PLAN.md](T2_ACCEPTANCE_PLAN.md) and [HARDWARE_AGENT_ACCEPTANCE.md](HARDWARE_AGENT_ACCEPTANCE.md) for the distinct scope contracts.
