# Engineering MCP bridge

`packages/engineering-mcp/index.ts` is a stdio MCP server backed by the single runner owned by the Electron main process. The bridge never opens a device, creates a task store, or executes a command. It publishes exactly these tools: `engineering.inspect`, `engineering.build`, `engineering.test`, `device.bind`, `device.flash`, `device.verify`, and `engineering.export`.

## Main-process integration

Create a fresh random token with at least 32 characters and a unique Windows named pipe for each main-process run. Start the bridge server after the authoritative runner is ready:

```ts
const bridge = await startRunnerBridge({
  pipeName: '\\\\.\\pipe\\forgedesk-runner-<random-id>',
  token,
  handle: async (name, args) => {
    // Resolve the active task from main-process session state. Never trust args.taskId.
    // Dispatch only to the authoritative runner with stored profile/acceptance commands.
    // Bind/flash/verify must independently check current hardware authorization.
    return dispatchEngineeringTool(name, args);
  },
});
```

The handler must reject a supplied `taskId` that does not match the current session's active task, compare `profileRevision` with the stored revision, and look up `verifierId`, `artifactId`, and `deviceIdentityId` in runner-owned records. `deviceIdentityId` denotes a runner-inventoried device; the model cannot supply a raw port or flash target. Build and test commands must come only from user-approved profiles and acceptance rules. The bridge deliberately has no generic shell or executable input.

`engineering.build` requires `taskId`, `profileRevision`, and `requestKey`. Use a new key for each intended build, including a build after source edits; reuse the same key only when retrying that exact invocation. The MCP bridge passes the key through unchanged. The runner owns idempotency and must detect reuse with changed arguments or inputs.

Bundle this module to `dist/mcp/index.cjs`, then launch it with `--mcp-stdio` and the environment variables `FORGEDESK_RUNNER_PIPE` and `FORGEDESK_RUNNER_TOKEN`. With Electron's bundled Node runtime, set `ELECTRON_RUN_AS_NODE=1` for this child process. If app-server launches the MCP process, verify how its configuration passes server-specific environment variables; do not assume they stay hidden from model-accessible shell tools. Never send the token to the renderer or model context. Runner-side task binding and separate hardware authorization remain mandatory even when pipe authentication succeeds. On shutdown, call `await bridge.close()`.

Example generated `config.toml` entry (use the installed executable and resource paths):

```toml
[mcp_servers.engineering]
command = 'C:\\<installation>\\ForgeDesk.exe'
args = ['C:\\<installation>\\resources\\app.asar\\dist\\mcp\\index.cjs', '--mcp-stdio']
startup_timeout_sec = 20
tool_timeout_sec = 360
required = false
enabled_tools = [
  'engineering.inspect', 'engineering.build', 'engineering.test',
  'device.bind', 'device.flash', 'device.verify', 'engineering.export'
]
```

The main process must verify the packaged executable invocation on Windows. In particular, Electron/asar paths and child-process environment are build-specific.

## Protocol and failure behavior

The MCP entry accepts newline-delimited JSON-RPC 2.0 over stdio. It supports `initialize`, `ping`, `tools/list`, and `tools/call`, and ignores notifications including `notifications/initialized`. Invalid methods and arguments get JSON-RPC errors. A runner failure produces a tool result with `isError: true`; exception text is never returned.

The local pipe accepts one JSON-line request per connection. Each request carries the token, an exact tool name, and schema-validated arguments. Frames are limited to 1 MiB; nested JSON beyond 16 levels and dangerous object keys are rejected. The internal deadline is 355 seconds, below the MCP 360-second tool deadline. A timeout means the result is unknown, not that a device action stopped. The runner must retain operation status and reconcile side effects after timeout or disconnect.

The token protects access to the local pipe; it does not replace task scoping or hardware authorization. A token leak, another process running as the same Windows user, or a compromised trusted build script remains outside this boundary.
