# Engineering Runner

The runner is the only component that writes task acceptance, operations and evidence. All public methods return promises. Import `EngineeringRunner` from `packages/engineering-runner/index.ts` and provide a product-private `dataDir` outside every model project root. Use the same instance for desktop and MCP requests. `close()` cancels active software processes, waits for final persistence and releases ownership.

```ts
const runner = new EngineeringRunner({
  dataDir: productPrivateDirectory,
  processHost: absolutePackagedJobObjectSupervisor,
  onChange: publishEngineeringProjection,
  excludedGeneratedDirs: ['dist'], // Only explicit, known generated directories.
});
await runner.createTask({ id, projectRoot, sessionId, title });
await runner.setAcceptance(id, [{
  id: 'trusted-test', title: 'Expected behavior', kind: 'automated',
  command: { executable: absoluteNodeExecutable, args: [trustedVerifier, projectRoot] },
  verifierFiles: [trustedVerifier],
}]);
await runner.run({ taskId: id, requestKey, kind: 'test', acceptanceId: 'trusted-test', command });
await runner.refresh(id);
```

`setAcceptance` is a user/template configuration action, never a model scoring tool. Automated items require exact command matching, a zero success exit code and explicit trusted verifier files outside the model workspace. Rules are persisted separately under `dataDir/engineering/verifiers/`. Manual items stay pending because this implementation provides no model/manual-pass endpoint. A task passes only when at least one required item exists and all required items pass. Build success alone never completes acceptance. A later failed, unknown or cancelled build overrides an earlier task pass and remains visible after refresh.

`createTask`, `listTasks`, `getTask`, `setAcceptance`, `run`, `cancel`, `refresh`, `exportTask`, `recover` and `close` are available. The type contracts are exported from `types.ts`. `run` waits for terminal status; observe `onChange` or query the task while it runs. Call `refresh` before showing existing evidence as current, including after project edits or reopening a project. `getTask` and `listTasks` return the persisted projection without scanning the filesystem.

## Persistence and Recovery

Storage is a schema-v1 JSON file written through a serialized queue, fsync and atomic same-directory rename. This avoids depending on Node's experimental SQLite availability in Electron's embedded Node runtime. Every task, acceptance item, snapshot, operation and evidence record has `schemaVersion`. Unsupported versions and corrupt data fail closed without overwriting state; automatic migrations are not implemented. A PID ownership lock rejects a second runner instance for the same data directory. It does not make a distributed database; route MCP through the authoritative desktop runner.

Intent is saved before starting the subprocess. `requestKey` is durable and globally bound to task, kind, acceptance ID and the entire normalized command (resolved executable, arguments, cwd, timeout and declared artifacts). Repeats return the original operation; changed parameters reject. Running requests also share the original promise. One operation locks an entire canonical project path; another task cannot verify that project concurrently. The client/engine must pause its own same-project writes while verification runs. External writers can still exist.

Recovery changes persisted `prepared`, `running` and `stopping` operations into `unknown`, expires passing evidence and performs no command replay. An unknown PID/process/device cannot be treated as successfully cleaned up. Software timeout/cancellation records terminal interruption or failure only after process cleanup; failed cleanup records `unknown`. A and B keep an active operation status throughout asynchronous log/evidence finalization, then publish terminal operation/task status and `completedAt` together. Cancellation during successful finalization prevents current acceptance from passing. Log/final-state IO failures conservatively record `unknown`; a durable duplicate still returns that original operation rather than replaying it. Process termination handles are cleared after child closure, so finalization cancellation never targets an exited child's PID.

## Evidence A

The input manifest hashes every regular file, including dirty, staged, untracked, ignored source, binaries, deleted-file effects, lockfiles and local build configuration. `.git` metadata is excluded from traversal but HEAD, staged and unstaged binary diffs and untracked names contribute separate hashes. Non-Git projects use the complete content manifest. Only explicitly configured generated directories are omitted. Git ignore is never used to omit file content. Hash collection checks file metadata before/after reading. Symbolic links/junctions, unsupported filesystem objects, missing inputs, excessive files (30,000 by default) or bytes (1 GiB by default) fail closed rather than silently omit inputs.

Execution fingerprints the project before and after, hashes user rule definitions, verifier files, executable bytes/version and the optional native supervisor bytes. Declared `artifactPaths` are hashed and rechecked during refresh. Any input/config/tool/artifact mismatch or collection failure expires the whole passing evidence group. Evidence remains historical; it cannot represent current acceptance after a change. A process exit can be `succeeded` while its evidence is `stale`, so consumers must display evidence/acceptance status to determine verification success.

A matching before/after digest is not frozen-input or tamper-proof evidence. Edit-and-restore during execution and dependencies read outside the declared project/tool/verifier inputs remain limitations. This is a trusted local project workflow, not execution of hostile repositories. Same-user malicious processes are not isolated by JSON hashes.

## Evidence B

B is opt-in for the single fixed `forgedesk.node-software.v1` arithmetic-module template. The project must provide `numbers.mjs` exporting `average`; every project input is copied, but this is not a general build system. Templates live in `engineering/templates/node-software-v1/` and are packaged outside asar for the externally selected Node executable. Only stable Node 24.12+ in the 24.x line is supported. Other profiles and arbitrary user build scripts are refused.

The trusted main process supplies `snapshotTemplateDirectory`, `snapshotSandbox` (vendored CLI, product-private home and mode) and `snapshotPolicyDigest(projectRoot)`. The renderer supplies no commands, paths or isolation proof. Main obtains an actual model-workspace/protected-root write-denial receipt through the engine adapter and calls:

```ts
await runner.setSnapshotProfile(taskId, {
  id: 'forgedesk.node-software.v1', nodeExecutable, isolation,
});
await runner.runSnapshotBuild(taskId, requestKey, freshIsolation);
```

The runner validates the receipt's owned private log, SHA-256, canonical roots, stable policy binding, attempted protected path, denied write and cleanup. Revisions increment only when the user explicitly enables/configures the fixed profile. Fresh per-operation proof does not change the revision or request digest. Request keys bind the stable profile and mode; duplicates return the original operation before copying, probing or executing. Normal engine connection-generation changes do not invalidate historical proof files by themselves.

Enabling adds the protected `snapshot-software` acceptance item and keeps ordinary A-level items. Public `setAcceptance` receives ordinary items and automatically preserves the protected item; callers cannot create or override it. Public A-level `run` cannot score it. One `runSnapshotBuild` performs copying, native and Node permission probes, the fixed build, and all three fixed arithmetic checks. Build exit zero alone cannot pass acceptance, and an early `process.exit(0)` without the complete verifier receipt fails. Existing required A items still need current passing evidence.

Each operation gets a fresh, non-reused directory at `dataDir/engineering/snapshots/<task>/<operation>/`. `input/` is outside the model workspace and `output/` is separate. The copy includes dirty/staged/untracked/ignored files, binaries and empty directories; only `.git` metadata is excluded. The fixed arithmetic build does not use Git, so B does not invoke repository Git tools or filters: its Git commit/diff fields are null, and the manifest explicitly records `gitMetadata: not-collected-fixed-template-does-not-use-git`. Complete file/directory content hashes establish its input identity. A continues to collect Git metadata, and A/B evidence is refreshed with its own fingerprint policy so both can pass on the same unchanged task. B ignores the A-level configurable generated-directory exclusions. Source links/junctions, linked snapshot paths, excessive inputs and unsupported filesystem objects fail closed. Hardlinks are copied as detached file bytes. Each copied file must match the captured source hash and length, the copied directory/file manifest must match exactly, and the source must still match after copying. A mismatch executes no build command.

Each command runs through the native Windows Job Object supervisor and `codex sandbox --include-managed-config --permission-profile :workspace`, with cwd set to the independent output directory, no additional writable roots and fixed restricted configuration overrides. Before building, a plain Node probe with no Node permission flags confirms that filesystem writes to input/private/template roots and SQLite writes to input are denied, while filesystem and SQLite writes to output succeed. Creating a file and then failing to clean it up is not write denial; SQLite open, write, close and cleanup outcomes are distinguished. The trusted runner independently checks that every nonce marker, database, journal, WAL and SHM path is absent before accepting the probe, recording `hostMarkersAbsent` separately from the child receipt. Failure prevents acceptance. This tests actual runtime OS policy instead of inferring isolation from hashes or readonly attributes.

Node permission mode is a second layer. Real probes check input write denial, the build's output write allowance, the verifier's output write denial and denial of child processes, workers, addons, WASI and inspector access. The builder reads copied input and writes only `output/numbers.mjs`; verification loads that output and must complete empty/nonempty/signed checks. The runner independently hashes the output and matches the build/verifier receipts. Every stage uses fixed arguments, the trusted product `CODEX_HOME` only, a bounded timeout and the same managed process cleanup.

The copied manifest, complete input digest, profile revision, tool/config hashes, isolation receipt and actual runtime probes are stored with B evidence. Input/manifest/output/template/tool/config changes expire evidence. Source edits during execution do not change the copied build input, but they mark current acceptance stale; `snapshot.verificationResult` preserves the historical build result. Cancellation and crashes preserve snapshots and phase records, move unfinished work to interruption/unknown and never replay operations. Refresh validates the actual snapshot and output, not merely the original workspace digest.

B means **task-specific snapshot build under the tested model/runtime writable-root policies**. It is not a frozen-input, cryptographic, anti-cheating or tamper-proof guarantee against arbitrary malicious code or same-user processes. The fixed scripts and local source must be trusted. Verifier code imports the project module in the same process: a malicious module can attempt to interfere with stdout or fabricate an argv nonce receipt. The receipt rejects missing/incomplete ordinary execution; it is not a proof against hostile JavaScript. Node explicitly documents its permission model as a restriction for trusted code and warns about malicious-code and non-fs access bypasses; native sandbox probes are required independently. See the [Node 24.21 permissions documentation](https://nodejs.org/download/release/v24.21.0/docs/api/permissions.html) and [Node 24.20 CLI permissions flags](https://nodejs.org/download/release/v24.20.0/docs/api/cli.html).

Exports include snapshot IDs, content/manifest digests, profile revisions, historical verification result and probe receipts. They exclude private paths, raw copied source, authentication/config files and artifact bytes. Original A-level tasks/stores remain compatible; directory inputs now contribute to fingerprints, so older evidence may conservatively expire on its next refresh.

## Commands and Exports

Commands use a resolved executable and argument array with `shell:false`, `windowsHide:true`, explicit cwd, bounded 100-300,000 ms timeout and a minimal environment whitelist. Product authentication variables are not inherited. Windows `.cmd`, `.bat` and `.ps1` executables are refused; use an explicit trusted interpreter when needed. Both output streams share a 256 KiB cap, with a visible truncation marker. Typical API keys, bearer values, credential assignments and quoted JSON secret keys are redacted before logs reach disk or export. Redaction is best effort; users should avoid logging unrelated sensitive content.

When `processHost` is supplied on Windows, commands, Git fingerprint probes and version probes run through the native suspended-child/KILL_ON_JOB_CLOSE supervisor. Killing the host closes its job and kills assigned descendants; the runner waits for host closure. Missing/configured host errors fail without silently falling back. Development/tests without a supervisor use Windows `taskkill /T /F` (or Unix process groups), and evidence states the weaker containment. Native supervisor ownership/real process tests are maintained by the device/process-host implementation.

Export requires an empty destination outside source/state roots. The allowlist is a versioned manifest, redacted operation logs, evidence/configuration/input digests, tool versions/hashes and declared artifact hashes. It excludes command arguments, request keys, verifier/rule files, arbitrary workspace content, authentication files and binary payloads. It is an evidence bundle; generated binaries must be delivered through a separately reviewed artifact workflow. Arbitrary source directories are never zipped.

Device execution is not provided by this module. Passing an unsupported operation kind rejects, and software evidence cannot imply device binding, flash or actual hardware success. Device functions remain gated by their separate adapter.

## Reproducible Software Fixture

```powershell
npx tsx --test packages/engineering-runner/*.test.ts
npx tsx packages/engineering-runner/demo.ts
```

The fixture in `engineering/fixtures/software/workspace/numbers.mjs` throws on empty input. The trusted verifier is in the sibling `verifiers/` directory outside the model workspace and tests empty/nonempty/signed inputs. The demo creates a fresh workspace/private-state pair, performs a real syntax build, records the trusted verifier failure, changes only the implementation, records the successful verifier run, exports evidence, then adds source and demonstrates expiration. It never edits the trusted verifier. Raw evidence, logs and `report.json` are kept under `engineering/fixtures/software/demo-output/run-*`.

Focused tests cover failure/pass/restart, duplicate suppression and mismatched keys, ignored binary/deletion/staged/untracked changes, edits during execution, project locks, timeout/cancellation, export redaction, unknown recovery, unsafe verifier rejection and fingerprint bounds. Snapshot tests additionally cover complete detached copying, transient copy mismatch, real native and Node permission probes, incomplete verifier receipts, A/B coexistence, host marker checks and A/B failure/cancellation/IO-error finalization. Native Job Object behavior is tested when the packaged helper is present; direct fallback results must not be advertised as native containment.
