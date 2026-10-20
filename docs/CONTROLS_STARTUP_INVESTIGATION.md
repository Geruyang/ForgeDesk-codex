# Controls Startup Investigation

## Scope And Evidence

This is a read-only investigation of the installed second-user controls startup failure, not a new acceptance pass. No application/model was started, authentication file or engine runtime data was read, network/service-status probe was made, or production timeout was changed during this investigation.

Project root: `E:/AiProject/agent-design/ForgeDesk-codex`.

- Public evidence: `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791995219975/controls/evidence.json`.
- Evidence SHA-256: `0c8ed1384a2769848acea5d37e2f8ac2b490766c0f9233bad28858e9c1117d5a`.
- Recorded UTC interval: `2026-10-14T16:27:14.071Z` to `2026-10-14T16:27:59.051Z`; result: `failed`.
- First error line: `page.evaluate: Error: Error invoking remote method 'forgedesk:invoke': Error: Engine account/read: workspace routing discovery timed out`.
- The recorded stack refers to the then-current `tests/second-user-controls-smoke.ts:84:88`, called at line 146. Its script hash is `edc0467694c2aeb1feb3e04ce7c60f9ecb8dcf385490955ea8fbdf0875bdad55`.
- Stop, MCP refusal, approval reload, diagnostics export and restart remain `pending`; cleanup records `normalClose: true` and `forcedProcessKill: false`. The interval includes launch and cleanup; it is not an account-request latency measurement.

## Product Source Chain

References below are current project source locations, not a reconstruction of private runtime logs.

1. `apps/desktop/main/index.ts:309` starts an automatic `connect()` after window loading. `connect()` at lines 105-110 calls `engine.start()`, `refreshAccount()` and then `engine.models()`. `refreshAccount()` at lines 100-103 calls `engine.account()`. Account notifications at line 96 can independently schedule another account refresh.
2. `packages/engine-adapter/index.ts:234` returns immediately when already ready and shares the in-flight start promise at line 236. The protocol/config readiness transition at line 286 precedes the main-process account/model refresh. A ready engine therefore does not prove automatic `connect()` has finished.
3. `packages/engine-adapter/index.ts:565` sends `account/read` with `refreshToken: false`. A received JSON-RPC error rejects that request with `Engine <method>: <server message>` at lines 398-399; this path does not itself stop/restart the engine.
4. The adapter request deadline is 30,000 ms by default at `packages/engine-adapter/index.ts:195`. Its own timeout at lines 492-496 says `Engine account/read timed out; request was not replayed`, which differs from the observed server-error text.
5. `connect()` is not unconditionally side-effect-free: `apps/desktop/main/index.ts:107` stops the engine and clears interrupted session state when any stored session is `engineUncertain`. No such session is established by this failure evidence. In the ordinary ready/non-uncertain path, repeated connect does not itself issue thread/turn creation, runner execution or login.

## Local Codex Source, Not Vendor Provenance

The inspected local checkout is `E:/AiProject/agent-design/code/openai/codex`, HEAD `72f999edc7848961b99c4b98bf1e62d12fa35798`. It is not proven to be the source of the pinned vendored CLI `0.162.0-alpha.17.2`. The following explains a matching source implementation; it does not prove the installed binary's internal deadline or establish the external cause of this failure.

- `codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs:90` defines the exact `workspace routing discovery timed out` message. `get_account()` at lines 174-185 maps routing failures to JSON-RPC internal errors.
- The same file at lines 425-435 wraps the complete account-read future in a 15-second deadline. That future includes configuration access, discovery-lock waiting, backend discovery and configuration revalidation; a timeout does not identify which stage was slow.
- Lines 270-307 coordinate/cache discovery per routing key, using a one-permit semaphore. Concurrent same-key requests can share discovery/cache state, but each caller retains its overall deadline. Cache misses do not prove independent requests (also documented at lines 1-4).
- `codex-rs/app-server/src/message_processor.rs:813` schedules routing discovery when a connection is initialized. Thus explicit account calls are not necessarily the only routing activity.
- `codex-rs/backend-client/src/client.rs:400` performs a bootstrap accounts-check GET, not a model inference call. `account_processor.rs:1103` avoids explicitly requested refresh when `refreshToken` is false; `workspace_routing.rs:309` still permits internal unauthorized recovery. Do not claim account queries can never affect cached/authentication state.

The product automatic connect and harness connect can overlap account calls because the harness waits for engine readiness, not completion of account refresh. Source coordination makes it unsafe to infer that duplication alone caused this observed timeout. Network failure, service failure, credentials and lock contention are not individually established by the public evidence.

## Bounded Test-Only Recovery

The reviewed helper is `tests/helpers/second-user-controls.ts:31`; its caller is `tests/second-user-controls-smoke.ts:84`. It permits at most one additional connect, only after the exact account-routing error (bare text or the exact observed Electron/Playwright wrapper), after the previous promise has settled and a five-second delay. It does not retry generic errors, adapter timeouts, login failures or model-list failures; it does not log in, alter authentication/configuration, change deadlines, reinstall, or replay any turn/runner operation. Exhaustion remains a failed acceptance run.

Before both attempts it reads a fresh global public snapshot and requires a ready engine, no uncertain/running/stopping session, no bound turn ID, no approval, no running task, and no prepared/running/stopping operation. It records bounded redacted public summaries before/after each attempt, excluding account labels, prompts, messages, credentials and raw diagnostics. Successful logged-out state still fails the caller's unchanged login requirement at `tests/second-user-controls-smoke.ts:88`.

These public guards are observations, not a lock. They cannot see the private `sendingSessions`/`protectedTasks` transition windows (`apps/desktop/main/index.ts:166`, before public running state at line 176), serialize automatic refreshes, or prevent manual UI actions after the snapshot. Recovery is restricted to startup before the harness sends a turn or starts a runner; the operator must not click login/send/stop/build during that window. Recovered `unknown` operations with `cleanup: unconfirmed` (`packages/engineering-runner/index.ts:481`) are not active-status matches, so the guard is not proof that every historical process was cleaned up. Such history requires separate evidence/manual review, not automatic repair. Historical `needs_attention` or `historyIncomplete` alone must not be relabeled as a live turn.

## Review Outcome

Read-only review of the current helper and its pure tests (`tests/second-user-controls.test.ts:155`) found no additional blocker within this bounded startup-only recovery scope. Tests cover sequential retry, two-failure exhaustion, nonmatching errors, global busy/uncertain states, rechecking after the delay, redacted summaries and the unchanged login gate. This review did not execute those tests or the product; root/QA retain execution and acceptance ownership. It does not certify that retry will succeed or that the routing fault is fixed.
