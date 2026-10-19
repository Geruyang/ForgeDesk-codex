# Pure Software CI

`.github/workflows/software-checks.yml` is deliberately a **Windows clean-checkout subset**, not the full product, release or installed acceptance gate. It has no build, package, installer, actual Electron/App, browser launch, Codex/model, authentication, SSH, board, native consent/UAC, clock, service, account or second-SID action. It does not consume private runtime or historical `output` evidence.

The workflow runs for main pushes, pull requests and manual dispatch. It does not use `pull_request_target`, application secrets, an environment credential or an SSH key. The standard ephemeral checkout token has read-only contents permission and is not persisted. Checkout and setup-node are pinned to full official action commits; this is a reviewed-code/trusted-runner job, not a sandbox for malicious JavaScript or arbitrary dependency code.

Before checkout, the ephemeral hosted runner executes `git config --global core.autocrlf false`. This preserves reviewed source/resource bytes instead of allowing an inherited Windows `autocrlf=true` conversion. It is a CI-runner setting, not permission to modify the developer's global Git configuration; the local validation helper parses this step but deliberately does not execute it.

## Toolchain And Install Policy

Node is fixed to **24.21.0 x64**, the local version used for the selected verification. The project currently has no `engines.node` declaration; this workflow does not invent one or silently follow a changing major-version tag. The runner is Windows Server 2022, not a claim about every Windows version.

Before installation, the lockfile must match the root name/version and every non-root package must have an HTTPS `registry.npmjs.org` URL and SHA512 integrity. Linked, custom-registry and credential-bearing URLs refuse. npm user/global config paths are two empty job-temporary files; no npm token is supplied. Installation is exactly:

```powershell
npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org/
```

This prevents dependency lifecycle scripts, including Electron downloads, from being run. Optional packages remain enabled because esbuild/tsx require the platform esbuild executable. The workflow explicitly resolves the locked `@esbuild/win32-x64/esbuild.exe`, checks its reported version against the esbuild API and performs one in-memory TypeScript transform. Missing/broken optional packages fail; there is no fallback installer, `npm rebuild`, browser install, private binary fetch or successful skip. Esbuild is a native **build tool** subprocess, not a product/device/native-ABI test. [esbuild's official install guidance](https://esbuild.github.io/getting-started/#additional-npm-flags) explains the `--ignore-scripts`/optional-package distinction; [npm ci documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/) defines the lock-based installation behavior.

The official action release/commit references are [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) at [3d3c42e5aac5ba805825da76410c181273ba90b1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1) and [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) at [949feb2413d6458794dcd2491c4babbbce0c15c1](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1). [The official Node 24.21.0 release page](https://nodejs.org/en/blog/release/v24.21.0) lists the Windows x64 downloads and their checksums. These versions/commits were checked against primary sources, not inferred from a mutable major tag. There is no dependency cache, so an earlier machine's `node_modules` or generated vendor resources cannot make this subset pass.

## Explicit Coverage

After `npm run typecheck`, only these files run with serial Node test execution:

| File | Cases | Resource/behavior boundary |
| --- | ---: | --- |
| `tests/test-discovery.test.mjs` | 8 | Temporary source-name fixtures and fake spawn ports; discovery/arguments/cancellation, no full-suite invocation |
| `packages/engineering-runner/runner-boundaries.test.ts` | 12 | New output-only state/project/junction fixtures, real runner ownership/input helpers; command execution/perform is refused or explicitly replaced |
| `packages/engine-adapter/lifecycle-regressions.test.mjs` | 8 | Actual source bundled in memory; fake FS/children/timers, real model/process creation trapped |
| `packages/engine-adapter/snapshot-boundary-regressions.test.mjs` | 9 | In-memory production snapshot functions with fake FS/fingerprint/process ports |
| `tests/main-exit-regressions.test.mjs` | 15 | Current main AST/VM and memory DesktopStore; not the Electron entrypoint |
| `tests/controls-stop-observer.test.ts` | 4 | Serialized observer and Promise/Map/IPC VM fixtures, no App |
| `packages/engineering-runner/fz3b/backend-grant-binding.test.ts` | 3 | Actual private grant/check methods on memory receivers, no constructor/init/key/runtime |
| `packages/engineering-runner/fz3b/grant-window.test.ts` | 4 | Actual backend/worker grant rejection before key/lock/transport, synthetic clock values |

**63 cases are required, all passed, zero failures/cancellations/skips/todo.** A missing file, changed registration count or missing summary fails rather than shrinking the set. Case changes require updating/reviewing the explicit contract; internal loop variants are not additional top-level cases. Tests may create their own non-secret `output/software-audit-20261019/...` fixtures; those directories need not exist in a clean checkout and are not historical evidence inputs.

The equivalent test command is the exact eight-file list in the workflow, starting with:

```powershell
node --import tsx --test --test-concurrency=1 --test-reporter=tap <the-eight-explicit-files>
```

Do not replace it with `npm test`, recursive discovery, a `--test-name-pattern` filter or a blanket skip. `npm test` is now the complete recursive standard-suite launcher; that broader scope has other resource needs and is separately validated under the release freeze.

## What This Does Not Prove

This job does **not** run the full reviewed 58-stage suite (standard Node plus explicit Python/MJS/grammar and actual-count/source-stability gates). It excludes vendor resource/manifest/compiler/native-helper tests, installed/ASAR/installer tests, software-process/runtime integration requiring private binaries or local fixtures, actual snapshot permission probes, real-model workflows, T2 STM32, ZYNQ, recovery deployment/fault qualification, clock/UAC, upgrade/uninstall, clean-machine GUI and second-account tests. Exclusion is an explicit subset boundary, not a skipped test or an acceptance pass.

Typecheck covers the checkout's configured TS source set, including tests; it is not execution of excluded tests. Ignoring install scripts means Electron, process-host, hardware tools, CodeX resources and product build dependencies are not provisioned. This CI must not call `scripts/build.mjs`, `npm run package`, `npm start`, actual smoke scripts or private-runtime preparation to compensate for missing resources.

The workflow and exact subset can be syntax/command-checked locally using existing dependencies. Such a local run does not prove `npm ci --ignore-scripts` succeeded from a new Windows checkout, nor that GitHub Actions has run. Remote CI remains unverified until the workflow is published and its actual run reaches terminal. No local clean install is performed just to claim that outcome.
