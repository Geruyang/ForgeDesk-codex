# Hardware Gate Review

## Scope

This review covers current source-level admission only. It does not enable
hardware, execute a probe or serial connection, flash firmware, use the second
Windows account, or constitute installed-product T2 acceptance.

The hardware owner separately reported chip ID `0x419`, a 1 MiB backup and a
583464-byte GestureScreen HEX matching the existing firmware. This QA suite
neither repeated nor independently verified those physical observations. They do
not create a product device binding or authorize a product flash operation.

## Verified Source Gates

`node --import tsx --test tests/hardware-gate.test.ts`: 7/7 passed.
`node node_modules/typescript/bin/tsc --noEmit`: passed.

| Boundary | Offline verification |
| --- | --- |
| Public hardware state | Actual main source in the existing VM harness publishes `hardware.enabled=false`. Mutating the returned snapshot cannot change a subsequent snapshot. Unknown renderer enable/device IPC methods reject. |
| Main MCP dispatch | Actual captured main handler rejects `device.bind`, `device.flash` and `device.verify` with `HARDWARE_NOT_ENABLED`, including a valid active task and fabricated authorization flags. No runner execution or isolation probe is reached. |
| Task/build admission | No active task, foreign task IDs and missing approved software build profiles retain their separate rejection paths. |
| MCP protocol | Actual `handleMcpMessage` validates schemas and reports errors after the main policy rejection. Listed device tools are declarations, not granted capabilities. Additional approval flags, port-only identity and unregistered methods reject before dispatch. |
| Runner runtime | Actual runner rejects non-build/test operation kinds before accessing the command or task. No executable is resolved or started. |
| Snapshot profile | Actual profile admission/configuration rejects hardware profiles before filesystem/tool configuration. The supported profile remains `forgedesk.node-software.v1`. |
| Public type | TypeScript regression verifies that this release's hardware-enabled flag is the literal `false`. |

Source anchors: `apps/desktop/main/index.ts:53,146,263,270`,
`packages/engineering-mcp/index.ts:18,24-26`,
`packages/engineering-runner/index.ts:237`, and
`packages/engineering-runner/snapshots.ts:10,52,76`.

## Fixture Boundaries

- Main code is bundled and evaluated with mocked Electron, engine, runner and
  bridge boundaries through `tests/helpers/desktop-harness.ts`. No real Electron
  application, vendor engine, model turn or named pipe is started by these cases.
- MCP protocol handling is real, but its callback directly calls the captured
  main handler. Error normalization mirrors the bridge's `RUNNER_ERROR`; this is
  not a transport, authentication or real-model approval test.
- The runner-kind case uses a fresh test-owned data directory. Profile rejection
  uses inaccessible getter tripwires to fail if tool/filesystem configuration is
  unexpectedly reached. Neither case invokes a hardware executable.
- No installed package hashes, connected-device state, probe permissions or
  physical flash contents are observed by this suite. The separate typecheck
  passed; the Node test runner alone does not enforce TypeScript.

## Remaining Boundary

These are product routing gates, not operating-system device-access isolation.
The generic engine shell and user-approved A-level external verifier commands
are separate execution surfaces. This suite does not prove that such software
could never communicate with USB, a debug probe or a serial device.

The UI's disabled-hardware reason is static product text, not hardware inventory
detection. Connecting or externally identifying a board cannot change the
hardcoded admission policy. A future product hardware path still requires an
explicit implementation and acceptance of stable device identity, target
binding, exclusive ownership, operation-specific authorization, artifact binding,
failure/cancellation behavior and runner-authored readback evidence. None is
silently supplied by the Node arithmetic template or external probe observations.
