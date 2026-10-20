# T2 Embedded Service

`packages/engineering-runner/embedded/index.ts` exports the independent
`EmbeddedService` and its TypeScript contracts. It does not expose model tools.
The desktop main process owns configuration, native confirmation, controlled
engineering mode, and the trusted hardware adapter.

## Fixed Target

The only profile is `gesturescreen-challenger-v1`, STM32F429IGTx, Keil target
`GestureScreen`. The profile fixes probe `1FC9:5601 / 594AC1D7613FED24`, target
UID `0037001b3133510432383236`, chip ID `0x419`, 1024 KiB internal flash, and
CDC `0483:5740 / 326F32513133`. These are expected identities; a configured
profile alone is not a live device observation.

The reviewed UV project and UV4 executable hashes are fixed in `profile.ts`.
All three compiler/linker/assembler executables are also checked. The final
packaged overlay manifest is pinned to
`d69f4e175352d29669d262d92f3da77a3c877d3f0673681d685d4bc667cf04f7`.
Its four explicitly listed file hashes and byte sizes must match; extra overlay
files are refused. The overlay never edits the UV project.

## Main Process Contract

Construct with `{ dataDir, templateRoot, processHost, hardware, onChange? }`.
`hardware` implements `inspect(context)`, `flash(context)`, `verify(context)`
and optionally `confirmProcessExited(operationId, operationDir)`.
The adapter returns the existing `FlashOutcome` contract. Receipt JSON is
stored as an opaque string. The service supplies paths from its own records.

- `configure(taskId, projectRoot, {keilExecutable})`: bind a task to a project;
  repeated configuration revokes its grant. Main supplies trusted paths.
- `build(taskId, requestKey)`: create and compile a fresh snapshot.
- `inspect(taskId, requestKey?)`: perform fixed-target inspection and backup.
- `prepareGrant(taskId)`: create a five-minute preview bound to exact build,
  HEX/AXF/source/profile, backup hash, and expected device identities.
- `approveGrant(taskId, challengeId)`: main calls this only after a native user
  dialog approved that exact preview. There is no renderer-provided hash/path.
- `flash(taskId, requestKey)`: consume the approved grant before dispatch.
- `verify(taskId, requestKey)`: require a successful flash of this exact artifact.
- `status(taskId)`: return historical records; this is not a live freshness test.
- `export(taskId, destination)`: copy allowlisted current evidence to a new
  directory and return `{path, sha256}` for its JSON index.
- `recover()`: record interrupted actions as unknown; never replay them.
- `assertIdle()`, `revokeGrants()`: support leaving controlled engineering mode.
- `close()`: terminate tracked builds and await outstanding service calls.

All action methods other than preview, export, recovery, and lifecycle methods
return `EmbeddedStatus`. See `types.ts` for exact field definitions.

## Build And Evidence

State lives at `dataDir/embedded/<task>/state.json`; build snapshots live at
`dataDir/embedded/<task>/builds/<operation>/source`, outside the input project.
Snapshots reject symbolic links, junctions, path escape and non-regular files.
Only these exact paths are excluded: root `.git`, root `Build`,
`MDK-ARM/Objects`, `MDK-ARM/Listings`, `demo/GestureScreen-demo-HQ.mp4`.
An unrelated `Other/Build` or source image remains an input.

The packaged overlay replaces four files in the snapshot. A random 32-byte
identifier is generated into `App/Inc/forgedesk_build_id.h` as
`FORGEDESK_BUILD_ID_BYTES`; the existing project includes `App/Inc`.
The compiled AXF must actually contain those bytes. The UV project remains
byte-identical to the reviewed project and has no nonempty custom hooks.

UV4 is invoked with `-b`, the exact project path, `-t GestureScreen`, and `-o`
for a captured build log. The executor uses `shell:false`, `windowsHide:true`
and the native process-host on Windows. Success requires exit 0 or 1, no
timeout/cancellation/unconfirmed cleanup, and `0 Error(s)` in the UV4 log.
The output folder starts empty. Source digests before/after, tool identities,
profile, overlay digest, HEX/AXF hashes, and log hash are bound in the build
record. Every later authorization/flash/export rechecks the current inputs.
The latest failed build attempt cannot fall back to an earlier artifact.

Durable state and per-build evidence carry an HMAC with a local service key.
This detects record edits by callers without the key. It is not an independent
signature and does not protect against another process with the same account
and access to that key.

## Operations, Locks And Recovery

Every accepted action records a request key, argument digest, unpredictable
nonce and durable intent before dispatch. An existing request key returns its
existing result; a changed binding is rejected. There is no automatic retry.
Build, inspect, flash and verify share one atomic directory lock across tasks.
An unconfirmed process exit retains that lock. Lock age never grants recovery.

Successful inspection must provide a one-MiB backup under its trusted
operation directory. Its bytes and hash are checked before preview, approval
and flash. An unknown operation blocks later actions until recovery proves
the original process exited. Recovery preserves status `unknown` and records
`recoveredAt`; it does not turn an unknown flash into success. Any later grant
requires a successful inspection newer than the previous flash operation.
New inspection, configuration, build, and leaving mode revoke old grants.

`assertIdle` refuses while a service queue, build control or probe lock exists.
`revokeGrants` first requires idle. The main process must keep the model engine
stopped while controlled mode is active, including after desktop restart.
This is a human-driven local workflow, not independent OS account isolation.

The main process also invokes `verifyHardwareRuntime(root, workerPath)` before
dispatch and recovery. Runtime manifest and worker SHA-256 values are compiled
into the desktop bundle. Verification hashes every listed runtime file,
requires the exact file/directory inventory, and rejects extra import/DLL/bytecode
resources, non-regular files, links and reparse points in every parent path.
The same checks cover the manifest and worker. These checks read files only.

## Export And Validation

Export copies the latest HEX, AXF, Keil log, snapshot source manifest, packaged
overlay manifest, and each operation receipt. The JSON index lists each copied
file's SHA-256 and byte size; it embeds state and profile records. Original
backup bytes remain in service storage; the inspection receipt retains their
hash. Export refuses stale source/tool/template/artifact/log evidence and
destinations inside the input project, build source or service state.

`npx tsx --test packages/engineering-runner/embedded/embedded.test.ts` runs
isolated state-machine/filesystem tests with an injected mock compiler and
hardware adapter. They cover identity injection, precise exclusions, junction
rejection, grant expiry/consumption, source/artifact/template/backup tampering,
request deduplication, cross-task locking, unknown recovery and export copies.
These tests do not access a probe, serial port, or physical device. Installed
physical acceptance is the main controller's separate responsibility.
