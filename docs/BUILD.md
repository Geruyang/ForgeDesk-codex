# Build and Run

Run commands from `E:/AiProject/agent-design/ForgeDesk-codex` in PowerShell.

```powershell
npm ci --no-audit --no-fund
node node_modules/electron/install.js
./scripts/vendor-codex.ps1 -SourceDirectory '<directory containing the four pinned official binaries>'
./scripts/build-process-host.ps1
npm run typecheck
npm test
node --test packages/process-host/process-host.test.mjs
npm run package
```

The original engine manifest pins version and hashes. Replacing the source binaries requires matching schema regeneration and protocol regression; do not treat the vendoring script's PATH discovery as release pinning.

The dependency lockfile is authoritative. Electron's download hook may need the explicit install.js command if local npm policy disabled lifecycle scripts. Build uses esbuild and bundles the renderer; no web server is required.

The historical 0.2.0 per-user NSIS installer is `release/ForgeDesk-0.2.0-x64-setup.exe`. Installation and uninstall should be tested on the generated installer, not inferred from `release/win-unpacked`. Uninstall retains data by default. Historical installers and source archives are retained separately.

That earlier implementation run installed it successfully (NSIS exit 0) into `E:/AiProject/agent-design/ForgeDesk-codex/install`. `scripts/launch.ps1` opens the current installed copy and directs user-session data to `.runtime/app` under this project. The earlier installed CLI resources were SHA-256 checked against the vendor manifest, all four matching. Releases remain unsigned.

For development with all run data inside this project:

```powershell
$env:FORGEDESK_DATA_DIR = 'E:\AiProject\agent-design\ForgeDesk-codex\.runtime\app'
npm run dev
```

The installed app includes four Codex executables, the process-host supervisor and the fixed Node snapshot template scripts outside asar. Node.js, Git, project compilers and board drivers used by engineering projects are separately reported runtime prerequisites; it is not valid to claim every project can run without them. B-level arithmetic snapshots require an explicitly selected Node 24.12+ executable in the 24.x line; the normal desktop startup does not depend on a source checkout or npm.

Source/third-party license files accompany vendor metadata. Product credentials live only in the product engine directory and must never be included in releases, support archives, or source commits.

Local release snapshots include a Git source commit and `release/ForgeDesk-source.zip`. `node scripts/record-release.mjs --runtime-source <full-runtime-commit>` produces the matching manifest and SHA-256 checksum list after the installer, installed resources and source archive exist. Pass the actual commit used for packaging when later documentation/test commits were added. Release artifacts, per-account ACL backups and runtime state are intentionally excluded from the source repository.

The historical accepted 0.1.0 runtime was built from `44fea73edcce31c7a9dd90aff73cdd9ceda47be5`. The latest release manifest records both source and runtime commits, installer/source hashes, installed app.asar and external template hashes. Version-bound installed regression is recorded in `docs/QA.md`; releases remain unsigned.

## Restricted-Model 0.4.0 Release

The current installed 0.4.0 runtime was packaged from
`b9a61615c564ea560604503ff7190ecc5e8620f0`, with 402/402 source regression tests
and successful typecheck/package/install. Later harness, release-validator and
documentation changes do not change that installed runtime pin. Final targeted
harness/continuation checks passed 53/53 with typecheck passing; these later
checks are separate from, and must not be added to, the frozen runtime's full
402-test suite. The actual
model/physical chain completed, but its original installed report and first
read-only continuation remain failed. The distinct second continuation passed
all eleven controls, and independent read-only release validation accepted the
combined evidence without creating release files; see
[HARDWARE_AGENT_ACCEPTANCE.md](HARDWARE_AGENT_ACCEPTANCE.md).

The real-model release route is separate from the historical manual route.
After successful final review, commit the intended source and documentation
changes, freeze HEAD, and prepare the dedicated source archive before recording:

```powershell
git archive --format=zip --output=release/ForgeDesk-source-hardware-agent-0.4.0.zip HEAD
node scripts/record-release.mjs --runtime-source b9a61615c564ea560604503ff7190ecc5e8620f0 --hardware-agent-evidence output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077968892/evidence.json
```

The command names the final accepted continuation, SHA-256
`995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`.
It is a separate coordinator release step, not something performed by the
read-only validation or documentation update. Do not substitute the original
failed report or first failed continuation, and do not repeat a physical write
to repair a reporting-only failure.

`git archive HEAD` includes committed tracked files only. The release script
hashes the existing ZIP and records the current HEAD as `sourceCommit`; it does
not itself check dirty state or prove the ZIP's contents came from that HEAD.
Commit intended files before archiving and keep HEAD fixed through recording.
The explicit `runtimeSourceCommit` remains the installed runtime commit above,
even if final harness/documentation commits make source HEAD newer. Do not put
untracked `output/`, `.runtime/`, credentials or generated artifacts into the
source commit/archive.

This route requires `release/ForgeDesk-source-hardware-agent-0.4.0.zip` and writes
`release/manifest-hardware-agent.json` plus
`release/SHA256SUMS-hardware-agent.txt`. Its manifest must preserve both original
failed execution provenance and the successful read-only continuation. The historical `release/ForgeDesk-source.zip`,
`release/manifest.json` and `release/SHA256SUMS.txt` remain untouched; the manual
`--t2-evidence` route keeps its original scope and checks. The two evidence
options are mutually exclusive.
