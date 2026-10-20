# FZ3B Acceptance Status

## Current Checkpoint (2026-10-16)

**The fixed PS security patch is deployed, and the bounded single-image runtime
computation passed. This is not installed Zynq/model integration acceptance or
semantic-accuracy acceptance.** The coordinator performed the live operations;
this document update reviewed local evidence only. Second-SID work remains paused.

The [current consolidated record](../output/hardware/2026-10-16-continuation/LIVE_DEPLOYMENT_RESULT.zh-CN.md)
links the deployed artifacts, independent reviews and remaining gates.

| Latest evidence | Result and boundary |
| --- | --- |
| [PS stop/deploy/start execution](../output/hardware/2026-10-16-continuation/live-plan/ps-security-1792122514610/execution.json) | `passed-ps-deployment`; all three SSH phases exit 0. Normal service stop/start, exact source patch and post-start hashes passed; no PL programming requested by this deployment |
| [Post-deployment readiness](../output/hardware/2026-10-16-continuation/readiness-postdeploy-live/1792123099122/stdout.json) | Service active/running; fresh application hashes recorded; actual `bind=127.0.0.1`, ports 8765/8766 |
| [Seven live negative cases](../output/hardware/2026-10-16-continuation/negative-live/1792123089058/stdout.json) | All seven `ok=true`: bad HELLO, duplicate JSON, partial header/body deadlines, wrong contract, threshold 2 and max_in_flight 0. Inference was not requested in these checks |
| [External-port rejection](../output/hardware/2026-10-16-continuation/public-ports-live/1792123180641/evidence.json) | Both external ports returned `ECONNREFUSED`; no payload sent. Together with the readiness read, this confirms the observed loopback restriction, not a general network-isolation audit |
| [Single-image computation](../output/hardware/2026-10-16-continuation/one-image-live/1792123520180/stdout.json) | `ok=true`, one result, upload completed 1, final inference `STOPPED`, frames 1, error null; R5 `semantic_matches` 0 -> 1, `score_engine=R5-Q15 / boundary-exact` |
| [Post-compute quiescence](../output/hardware/2026-10-16-continuation/post-compute-live/1792123992082/stdout.json) | Passed two proc scans with no A0005 device owners and no active control connections; app PID/dependencies/files unchanged, query 1/frame 1/STOPPED. This is point-in-time process evidence, not proof that every hardware engine is electrically idle |
| [Project-key SSH audit](../output/hardware/2026-10-16-continuation/ssh-audit/1792123494860/evidence.json) | Successful project-public-key access with TOFU host-key continuity; Linux/aarch64, deployed hashes and loader `READY_A0005` recorded. This is not independent chip authentication or measured loaded-image attestation |
| [Enterprise verification](../output/hardware/2026-10-16-continuation/license-audit/enterprise-check/RESULT.md) | Fresh Vivado batch selected Enterprise and the exact target part; entitlement expires 2026-12-15. Startup/license blocker resolved, not a perpetual license or full-build pass |

The image is a fixed synthetic 16x16 JPEG and the query is unit vector `e0`,
**not a text embedding**. This proves one runtime computation path, not semantic
accuracy, sustained throughput or a broad workload matrix. The accepted query
replaced the query snapshot (revision 1); the protocol did not expose or restore
its previous contents. `STOPPED` is the final application observation, not proof
that all remote PL/R5 activity or services stopped. Runtime start/upload can call
loader preparation and change PL/driver state; the single-image result is not a
claim that a new host-built bitstream was programmed or independently verified.

Baseline correction is explicit: the retained v1 archive contained Windows CRLF
checkout bytes, not raw Git bytes; its exact-preimage mismatch was not waived.
The [baseline comparison](../output/hardware/2026-10-16-continuation/board-baseline-review.md),
[v2 raw-Git audit](../output/hardware/2026-10-16-continuation/canonical-baseline-v2/raw-git-audit.json)
and [v2 manifest](../output/hardware/2026-10-16-continuation/deployment-bundle-v2/manifest.json)
record the correction: 53 fixed regular archive members checked against raw Git
blobs, preserved security overlays, and fresh exact deployment preimages. The
v1 artifacts and failed historical checks remain unchanged.

The real `full-20261016-enterprise-03` Vivado run exited 0 with routed timing/DRC
and BIT/XSA exports. Its outer result remains FAILED because the original Tcl
serialized relative paths incorrectly at the `V:/` volume root. The separate
[read-only revalidation](../output/hardware/2026-10-16-continuation/pl-build-preparation/revalidation-full-20261016-enterprise-03.md)
verifies all 21 receipt artifact hashes and exports; it does not rewrite that
failure. Final WNS is +0.006 ns, TNS 0, WHS +0.010 ns, THS 0, WPWS +0.677 ns;
98,467/98,467 nets are routed, with no routing errors or DRC errors/critical
warnings. New BIT native payload is byte-identical to the pinned candidate008
native file; its BIT header differs. No new PL write or loaded-image readback
was performed. Unique silicon identity, measured loaded-image equivalence,
semantic accuracy, physical-fault/recovery matrix and installed ForgeDesk Zynq
real-model workflow remain unaccepted. STM32 T2 cannot substitute for these gates.

The [forward wrapper correction](../output/hardware/2026-10-16-continuation/pl-build-preparation/forward-fix-subst-parent.md)
uses a non-root mapped stage and retains strict receipt/capture checks. Offline
negative tests and preflight pass; no fresh full Vivado run has tested this
wrapper revision. The original failed execution and separate revalidation remain
distinct records.

Project-key access does not mean the board's default-password entry is hardened.
This work did not rotate the initial password or disable SSH password login;
account hardening and fallback-access verification remain open before deployment
to a shared or untrusted network.

## Historical Checkpoints (Retained)

Everything below preserves earlier observations and their then-current blockers.
Statements such as "not deployed", SSH denied, missing license or zero compute
frames describe those historical checkpoints, not the current state above.
Original evidence files were not rewritten or promoted to later passes.

### Security Continuation (Earlier 2026-10-16)

The [security continuation checkpoint](../output/hardware/2026-10-16-continuation/CONTINUATION_RESULT.md)
records the hardened source, 54 passing offline security tests, the verified
six-member data-only deployment bundle, and fresh platform regression results.
The default-concurrency run had one timeout (427/428); isolated reproduction and
the complete concurrency-2 rerun passed (2/2 and 428/428 respectively). Both runs
are retained. Type checking passed.

These fixes have **not been deployed**. Vivado still failed its startup license
check after the reported import, and the exact license path is unresolved. The
SSH username is confirmed as `root`, but authenticated access/host trust remain
unverified. Build preparation is not synthesis; no new Zynq compute, deployment
or installed-product acceptance is claimed. The following sections retain the
earlier live-observation checkpoint and its evidence boundaries.

Checkpoint: 2026-10-16, Asia/Shanghai. **Only live application status observation
and bounded invalid-request rejection, plus separate JTAG enumeration passed.
FZ3B/Zynq compute, deployment and installed-product acceptance have not
passed.** No new installer or installed hardware profile is claimed by this page.
The coordinator alone operates physical devices; this document's author reviewed
local files only. Second-Windows-account verification remains paused.

## Evidence And Scope

| Record | Scope / identity |
| --- | --- |
| [Live status JSON](../output/hardware/2026-10-16/fz3b-live-status-20261015T163152Z.json) | `passed-status-only`, failures empty; 2026-10-15 16:31:52 UTC / 2026-10-16 00:31:52 Beijing; elapsed 1.047 s |
| Live status SHA-256 | `ccbd842011cbb646c8d63044d9a4726beb8cd816bf90ebdc18f97133008db638` |
| [Live negative JSON](../output/hardware/2026-10-16/fz3b-live-negative-20261015T164459Z.json) | `passed-bounded-rejection-only`, failures empty; one separate TCP connection with no compute/programming |
| Live negative SHA-256 | `d267ff2a16c879244ce2148abce53d084612b203cf33b73e8c8fc7ac0e2b290a` |
| [Final source-bound status](../output/hardware/fz3b-status/status-1792083588117/evidence.json) | Fixed production-module client `passed-status-only`, not installed-app/model acceptance; 2026-10-15T16:59:48.158Z |
| Final source-bound status SHA-256 | `57f47486a108314de075ec53fe2d0b88bc8b67de7ee8c651a7b74b25e61df995` |
| [Host preflight](../output/hardware/2026-10-16/fz3b-host-preflight.json) | 2026-10-15T16:37:52.7462565Z; primary SID1002, not elevated; host metadata only, no programming/configuration changes |
| Host preflight SHA-256 | `fe816ddfd85b4d8eaa5c728ba96c79dd3a2dde4eaee9eeb1cf96cfc802e26921` |
| [Reviewed source checkout](../output/hardware/2026-10-16/fz3b-semantic-video-search/README.zh-CN.md) | `59cdbefade2535dbeea9a34d1658a307ab7f3bb7`; source snapshot, not a complete deployable binary/model bundle |
| [Source/protocol review](../output/hardware/2026-10-16/fz3b-source-review.md) | Transport, runtime/loader side effects, prerequisites, limited functional-smoke proposal; no device access by reviewer |
| [Platform integration review](../output/hardware/2026-10-16/fz3b-platform-design.md) | Separate initially disabled FZ3B profile/controller/artifact/grant/worker required; design is not implemented installed acceptance |
| [Software boundary review](../output/hardware/2026-10-16/software-boundary-review.md) | Baseline findings retained; later source fixes/final regression are recorded below, not FZ3B compute acceptance |

The existing installed 0.4.0 result is the distinct
[Challenger V1/GestureScreen T2 scope](T2_INSTALLED_RESULT.md), runtime
`b9a61615c564ea560604503ff7190ecc5e8620f0`. Its STM32 UID/probe, native grant,
HEX/AXF, readback and CDC contract cannot be relabelled as Zynq support.

## What Was Observed

The application records use FZVA TCP control `169.254.220.254:8765`, not an HTTP
or SSH transport; the separate SSH attempt is described below. The
reviewed [status probe](../output/hardware/2026-10-16/fz3b-status-probe.py) sent
one framed FZVA `hello`, then received a hello and two status objects. Its parser
checks the 16-byte header, version/kind/flags, 64 KiB bound and CRC32 before JSON
decoding. The retained JSON records parsed observations, not a separate raw-wire
capture or cryptographic attestation.

| Observed field | Recorded fact / limit |
| --- | --- |
| Application platform / protocol | `A0005` / `1` |
| Boot ID | `5ceb45a3-8903-4efc-9484-ec75c17280df`, stable across these messages; a process/boot epoch, not permanent chip identity |
| Semantic application contract | `332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e`, matches the checked-in application contract |
| Peer authentication | `authenticatedPeer=false`; no authenticated board identity, chip UID or measured firmware hash established |
| Initial camera | Reported 1280x720, frames `19601 -> 19627`, about `25.017 -> 25.018 fps`, requested 30 fps; `sequence_gaps=1`, error null. The later source-bound record reports 20.891 fps, so this is not a sustained 25/30-fps or image-quality acceptance |
| Inference | `STOPPED`, frames 0, error null, query revision 0; no compute/result acceptance |
| R5 core 0 heartbeat | `491080 -> 491712`; requests `4 -> 5` |
| R5 core 1 heartbeat | `561233 -> 561955`; requests `14 -> 16` |
| R5 compute | Application reports `offload_verified=true`, but `semantic_matches=0`; growing heartbeat/telemetry does not prove a new semantic or PL workload completed |
| CPU / health | Application reported verified actual CPU near 1.2 GHz and AMS/procfs telemetry; the coordinator did not request a clock change. Reported cached/sysfs and CCF values are distinct fields, not independently measured clock attestation |

The contract/boot ID, IP, ARP MAC and USB identifiers are observations, not an
authenticated chip identity. CRC detects transport corruption, not impersonation.
Status may send R5 telemetry upstream, and disconnecting the last control
subscriber may disable orphaned camera inference. Consequently this was a bounded
status observation, **not a strictly side-effect-free electrical probe**.

The coordinator did not start inference, upload an image/video, open the video
port, successfully log in through SSH, program PL/nonvolatile storage, restart
services or the board, change clocks, install drivers or change host network
configuration. One later password-free `BatchMode`/publickey-only SSH attempt as
`root` was rejected with `Permission denied (publickey,password)`; no remote
`cat` executed and no OS/loader identity was obtained. The
[observed host key file](../output/hardware/2026-10-16/observed-known-hosts)
came from this round's `ssh-keyscan`: TOFU observation, not pre-established trust.
No password guessing or authentication-file read was performed. A later JTAG
enumeration is recorded below; it did not halt/reset/program the target.

## Final Source-Bound Status Client

The final status report binds and matches these current file hashes:

| Source | SHA-256 |
| --- | --- |
| [Fixed entry](../scripts/fz3b-status.ts) | `53ba0e53813a8dd66826051f71feb10d2f453f1e75a45d2bd93661e44b44091e` |
| [Public module](../packages/engineering-runner/fz3b/index.ts) | `1cba7414bd409e416e4e5e4bb93e16ce8a2321a7cb47cefc7c3d0c222f6f65b2` |
| [Internal implementation](../packages/engineering-runner/fz3b/internal.ts) | `ec62c6a5840021fdab48b865f1be909a5d13f42ca51ef98cb9834623601b85f6` |

The application reports the same boot/contract ID, inference `STOPPED`/frames 0,
query revision 0, threshold 0.2 and max_in_flight 4. Camera frames are 51,377 and
reported FPS is 20.8910; R5 heartbeats are 1,538,429 / 1,758,206 with semantic
matches still 0. CPU current_khz remains 1,199,999. These are later unauthenticated
application fields, not a unique-chip or loaded-firmware measurement. The receipt
explicitly records programming and compute as `not-attempted`. The previous
[source-bound run](../output/hardware/fz3b-status/status-1792083232263/evidence.json)
remains separate, SHA-256
`15f3d68bc25a9054d9828b95a035d88f2e5f108ca69fbf41dc0fc6e797936e5e`.
Before JTAG, that record at 16:53:52 UTC reported 47,807 camera frames and
22.728 fps; afterward at 16:59:48 UTC, 51,377 frames and 20.891 fps. The 3,570
frame increase over about 356 seconds implies roughly 10 fps across that interval,
not sustained 25/30 fps. Cause is undetermined; this comparison does not establish
that JTAG caused the change. Boot is unchanged and R5 heartbeats increased, while
inference remained `STOPPED` with zero frames.

This checkout-level production client does not mean the installed 0.4.0 UI,
restricted model inventory or release resources have been updated for FZ3B.

## JTAG Enumeration, Not Programming

The coordinator's first Vivado launch was refused for a missing valid license:
[stderr](../output/hardware/2026-10-16/jtag-observe.stderr.log),
[process record](../output/hardware/2026-10-16/jtag-observe-process.json).
Its recorded launcher/server exit codes are null; it is not a successful Vivado
enumeration or license/build qualification. Vivado was attempted, not globally
absent or never executed.

A separate normal XSDB query succeeded, with
[target output](../output/hardware/2026-10-16/xsdb-observe.stdout.log) and
[process record](../output/hardware/2026-10-16/xsdb-observe-process.json) exit 0:

| Observed JTAG item | Value |
| --- | --- |
| Cable | Digilent JTAG-SMT2, exact serial `210251190311` |
| PL device class | `xczu3`, reported IDCODE `0x14710093`, IR length 12 |
| ARM debug access port | `arm_dap`, reported IDCODE `0x5ba00477`, IR length 4 |
| Action / cleanup | Target enumeration only; `programmingRequested=false`, `haltResetDownloadRequested=false`; XSDB and server exit 0 |

The coordinator reported no remaining hw_server/Vivado/XSDB/Electron processes
after cleanup. The subsequent source-bound application status retained the same
boot/contract and stopped inference; that is not independent proof of every PL
register or image byte being unchanged. IDCODE identifies a device class, not
unique silicon DNA, loaded PL bitstream hash, authenticated network peer,
boot medium or loader/OS identity. The coarse `xczu3` class also does not prove
the source target's exact EG variant, package or speed grade
`xazu3eg-sfvc784-1-i`. Those gates remain open.

## Bounded Live Rejection Checks

The separate [fixed negative probe](../output/hardware/2026-10-16/fz3b-negative-probe.py)
used one TCP control connection. After a CRC-corrupt HELLO, a valid HELLO still
succeeded; no direct board decoder-counter proof is exposed. Four exact invalid
requests then returned matching `request_id`/`op`, `ok=false` and expected errors:

| Invalid request | Actual response |
| --- | --- |
| Unknown `forgedesk_invalid_operation` | `unsupported operation` |
| `queries` with wrong semantic identity | `text/image semantic identity mismatch` |
| `settings` threshold 2 | `threshold must be finite in [-1,1]` |
| `settings` max_in_flight 0 | `max_in_flight must be 1..4` |

A subsequent `status` succeeded. Boot/contract ID, query revision, threshold,
input source, CPU current_khz and inference state/frame/error/inflight fields
remained equal to their pre-request values. Camera/heartbeat telemetry was not
required to remain static. These bounded refusal checks do not establish flood,
oversized-frame, giant-image, adversarial authentication or computation safety.
There was no `start`, `upload_begin`, input upload, loader invocation or firmware
write. The same status/disconnect caveats apply.

## Why Compute Was Not Started

Source `PS/vision_app/board_runtime.py:create_runtime()` unconditionally invokes
loader `prepare-a0005` before inference. The loader aliases this to
`switch-a0005`: even an existing ready A0005 state may unload/reapply the
driver/overlay; other states can program PL and change its clocks. Thus `start`
or `upload_begin` is not a passive discovery action. No proposed single-frame
synthetic smoke was executed, and a synthetic result would not by itself establish
text-image semantic accuracy.

The required independent loader/device identity, actual deployed resource hashes,
safe-state/recovery procedure and authenticated access are not yet available in
the retained evidence. A Windows client's exit would not prove remote Linux,
DMA/PL or R5 work stopped. Missing prerequisites must not be repaired implicitly
by invoking loader preparation, changing clocks or restarting services.

## Open Gates

| Gate | Current boundary |
| --- | --- |
| Independent target and loader identity | No authenticated physical-board/chip UID, current PL-manager/loader identity, live A0005 core/ABI/manifest or boot-medium identity has been independently collected. Application `contract_id` alone is insufficient |
| Actual deployed firmware/runtime | No independently verified loaded bitstream, firmware/R5 image/native runtime/model-byte hashes, backup/rollback or tested recovery plan in this observation |
| SSH trust and credentials | Reviewed helper expects a pinned `board-known_hosts` and host-owned credentials; the published clone lacks that trust material and private installation data. A password-free publickey-only attempt was denied, not a successful login; the newly scanned key is only TOFU, not independently trusted. No remote OS/loader evidence was obtained; do not infer identity from reachability or put credentials into model prompts/logs |
| Source resources | The source snapshot omits deployable BIT/BIN/DCP, model weights and native runtime binaries. Manifest hashes do not supply the missing bytes; this does not establish those resources are absent on the board |
| Source-package verification | [Original offline checksum log](../output/hardware/2026-10-16/fz3b-build-audit/verify-upload-original.log) rejected `PS/drivers/a0005/network10_v10_dma.c`. Audit found 148/393 raw-byte matches, 243 CRLF differences whose HEAD Git blobs match, plus two README Git blobs still different from the release manifest. The original verification remains failed; a separately derived source-only copy cannot turn it into a release-integrity or compute pass |
| FPGA toolchain | Initial PATH lacked `vivado`, `xsct` and `hw_server`; later existing tools under `D:/vitis/2026.1` were used for GCC 13.4.0/DTC R5 compilation and XSDB enumeration. Vivado launch failed its license check, not a successful synthesis. Reviewed XPR targets `xazu3eg-sfvc784-1-i` with Vivado 2026.1 and retained original absolute paths; R5 build script's old hardcoded `D:/Vivado` tool path is missing. No PL synthesis/implementation/bitstream build passed |
| UART / JTAG | CP2102N problem code 28 and no Win32 serial ports remain the host-preflight observation; no UART or driver-install attempt. Later exact-cable XSDB JTAG enumeration passed as above, without halt/reset/download/program; unique DNA and current PL-image identity remain unverified |
| Fixed computation | No input upload, A0005 run, independently checked PL output/counters, R5 semantic match or bounded clean drain/recovery observed |
| Product integration / authorization | A separate host-owned FZ3B profile, authenticated transport, explicit side-effect grant, remote operation/unknown recovery and scope-aware installed evidence remain unaccepted. STM32 grants/tools are not reused |
| Broader acceptance | No cold boot, persistence, semantic accuracy, sustained throughput, physical faults, second-SID or clean-machine result |

## Offline Source-Only Audit

The [complete reproducibility report](../output/hardware/2026-10-16/fz3b-build-audit/FZ3B_BUILD_REPRODUCIBILITY.md)
is SHA-256 `5e0e5dc767e839e47a24462861a822677643b9376b33f86752250e3eeb152b95`;
it separates source checks, missing inputs, existing tool files and unexecuted
build/device stages.

The [source audit](../output/hardware/2026-10-16/fz3b-build-audit/source-audit.json)
preserves the original publication verification failure above. In a separate
audit directory, a Git-derived source-only copy excluded 18 media files
(134,637,139 bytes) and received a new manifest; it did not edit or replace the
upstream release manifest. The
[derived manifest](../output/hardware/2026-10-16/fz3b-build-audit/canonical-upload/UPLOAD_MANIFEST.json)
SHA-256 is `ebbd1ea4252e714a63c0c799869e670bfd4044678b520a9febb0ef2324f8c2b1`.

[Derivation results](../output/hardware/2026-10-16/fz3b-build-audit/derivation-results.json)
checked 375 mapped files / 5,265,322 bytes, 37 XPR references, successful copied
verifier/materializer execution and a second idempotent materialization. The
original 393 listed files were unchanged. These are internal-copy consistency
checks, not original-publication integrity, synthesis, runtime build, deployment
or inference acceptance. The source audit parsed 120 Python files without syntax
errors; it did not import or execute the board application.

The [release-resource inventory](../output/hardware/2026-10-16/fz3b-build-audit/release-resources.json)
found 10/17 listed resources with matching hashes, but seven ONNX/parameter files
totalling 71,433,040 bytes are absent from the clone. The inspected Python 3.12.14
environment matched only pyserial among 16 pinned packages; fifteen were absent.
That is one audit environment, not a full-machine package survey. No missing
package was installed, and no hardware tool, service or application was started
by these source-only checks.

### Later R5 Subset Compile/Link

After separate coordinator authorization, a
[real offline R5 build](../output/hardware/2026-10-16/fz3b-build-audit/build-attempt/R5_BUILD_RESULT.md)
compiled/linked both freestanding R5 cores and generated the DTBO twice, with
all build commands exiting 0 and no compiler/linker diagnostic. The report
SHA-256 is `074408cf936448156d607283fe1458b2b59b41b82909048763e568b73e261eee`.
It used copied unchanged inputs and the original flags with isolated output/tool
paths, not the upstream script's missing hardcoded locations. R5 and A53 GCC
version probes both returned 13.4.0; no A53 application was compiled.

| First-build artifact | SHA-256 |
| --- | --- |
| R50 ELF | `200761f9f832c29aac815195934a231555b6071c6f4c76bcf044acb8e2b018ab` |
| R51 ELF | `2a8fe6a8ed6a34b0678266b61d62e3b35fa88b635e0fb0f84d8486f1cd0a30ea` |
| DTBO | `5e00adf8408f74d4aa735c67f2b388a32850af00e50b7d0ad94c759669acd3f3` |

Whole-ELF byte repeatability **failed**: the two `.strtab` sections contain
different temporary object names. Entry points and all PT_LOAD payload/memory
content match, and DTBO bytes are identical across these two builds. Optional
DTBO decompilation retained six generated-fixup warnings. This does not prove
original-historical-binary equivalence, target TCM/remoteproc compatibility,
runtime stack health or application/PL rebuildability. Nothing was loaded onto
the board. The original source/audit bytes stayed unchanged, original publication
verification remains failed, and missing full-application assets remain blockers.

## Software Follow-Up

The reviewed 0.4.0 baseline's offline-confirmed unknown-owner recovery, utility
shutdown and instruction-limit defects have checkout fixes. Final
[complete regression](../output/hardware/2026-10-16/full-regression-final.log)
passed 428/428, zero failed/skipped/cancelled, 172715.2433 ms;
[typecheck](../output/hardware/2026-10-16/typecheck-final.log) and
[source build](../output/hardware/2026-10-16/build-final.log) exited 0.
Separate [renderer regression](../output/hardware/2026-10-16/renderer-regression-final.log)
passed 26/26; this is not added to the complete-suite count.
These current results are separate from historical overlapping 402/402 and
53/53 receipts; counts must not be added. [Known issues](KNOWN_ISSUES.md) retains
the baseline findings and installed-version boundary.

The [real isolated Electron smoke](../output/playwright/software-20261016-final/evidence.json)
passed eight steps, zero failures/page errors, SHA-256
`39231cb2335e6fdd611faf3cc7b3fe3dae43c8b982e324ce894c70f24547f306`.
It exercised a fixed verifier's original failure/manual fixture correction/pass,
reload, restart/dedup, stale-input detection and diagnostics; the coordinator
reviewed the 800x600 screenshot. It performed no login, real model or hardware
action and was not an installed upgrade. No updated installer or installed
fault-recovery acceptance is claimed; the 0.4.0 installation remains unchanged.

## 2026-10-17 Local Recovery Update

The sections above retain their original observation scope and are not a current
claim that the installed version remains 0.4.0. ForgeDesk 0.5.3 is now installed.
The exact preflight-refused inspect case completed its fresh native-authorized
local recovery, followed by a separately observed restart/explicit-local-finish
and normal-close check. The original inspect remains `unknown` with
`remoteQuiescent=false`; no original device action was replayed.

The final finish-only run `fz3b-preflight-1792238733530-866856` recorded the exact
UI pending/settled sequence, no action error, native main-process disappearance,
launcher exit 0, and no forced kill. Earlier failed harness runs remain failed.
See the [independent actual acceptance addendum](../output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3/ACTUAL_FINISH_ACCEPTANCE.md).

The corresponding frozen offline revision passed 949 Node tests, 85 Python tests,
10 supplementary Node tests, and type checking. These counts are separate suites,
not new hardware coverage. See the [frozen QA report](../output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3/VALIDATION_RESUME_FINISH_JSON.md).

New source development has started after that acceptance freeze. The installed
binary has not thereby acquired those unfinished changes. Open work includes a
main-only authenticated persistent finalization record, read-only new-boot
qualification, immutable historical-profile compatibility, PS admission at all
supported entry points, real remote HostACK verification, and the subsequent
installed running-stop/cancel/disconnect/unknown-result recovery observations.
No new boot has been adopted, no new fault trial enabled, and no remote deployment
is implied by a source-only test. Second-account acceptance remains paused.

### Retained SSH Hardening Evidence

The older default-password statements above describe their original observation
dates. A later 2026-10-16 root-only public-key policy transaction did commit and
reload, with unchanged non-root contexts, successful independent project/recovery
key logins, and a separate publickey-only method-offer observation. See the
[independent evidence check](../output/hardware/2026-10-16-next/qa/ssh-policy-live-evidence-check.json).
This did not rotate the account password or change local-console access, and it
is not a fresh attestation for the subsequent board boot. Do not replay the
one-shot policy transaction or describe key login alone as full account hardening.

## Next Acceptance Boundary

Only the coordinator may propose a separately authorized fixed computation after
authenticated target/loader identity, actual resource bytes/hashes and recovery
are established. A native grant must explicitly include any PL/driver/R5/clock
effects. The model must not receive generic SSH, shell, Tcl, register writes or
arbitrary paths. Begin with offline controller/receipt/timeout/replay tests; any
eventual prepared-board functional run, FPGA rebuild, semantic evaluation and
installed real-model workflow require their own separately labelled evidence.
