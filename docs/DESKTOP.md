# ForgeDesk Desktop Renderer

The Chinese-first React renderer reads the real `window.forgeDesk` bridge from `packages/shared/contracts.ts`. It never supplies fixture projects, conversations, account state, diffs, or evidence. Opening the bundled HTML in a browser without the bridge displays a desktop-required notice and disables project import.

## Workflows

- Import a local project, create a task, select an engine-returned model, and send an instruction. During an active turn the send action becomes steer; stopping requests interruption and leaves the terminal status to the engine snapshot.
- Approval requests display their method, generation, raw parameters, and only the decisions supplied by the backend.
- Code review fetches the real project diff and preserves backend truncation warnings. Changing project or session invalidates in-flight diff reads.
- Engineering delivery displays the selected task's real acceptance, operations, and evidence. The editor accepts an executable, a validated JSON string array of arguments, absolute paths to project-external trusted verifier files, and a 100–300000 millisecond timeout matching the runner. Manual acceptance items cannot be marked passed by this interface.
- Expanding an operation reads its actual raw log through `readOperationLog`; refresh reads current output. Eligible prepared/running/stopping operations have a stop action through `cancelOperation`. Log requests are guarded against unmounted records and task switching.
- Run acceptance, recheck evidence, and export a task through the bridge. Concurrent clicks are guarded; an uncertain run failure retains its request key for a retry.
- Settings expose the real engine executable, isolated home, account state, diagnostics, and disabled hardware reason, plus connect/login and diagnostics export actions.

Selection, model choice, and per-session unsent drafts persist in renderer local storage. Credentials are never collected or stored by the renderer. Failed send/steer requests retain the draft, and completed requests only clear the exact text submitted to the original session. Subscription cleanup and guarded async responses prevent abandoned results from replacing the active view.

Messages and logs render as escaped React text, never injected HTML. Unified diff lines are escaped text with addition/deletion coloring. The CSP forbids remote connections, scripts, embedding, and form navigation.

## Layout and Verification

The layout targets 1380x900 and 800x600 Windows windows, using three compact panes, a collapsible review pane, native form controls, lucide icons, a local 256x256 bitmap brand mark (and Windows ICO), and a native modal settings dialog. Browser-only preview is an explicitly disconnected surface, not a substitute for installed desktop/engine validation.

The 2026-10-15 embedded-panel layout checks used the actual renderer with an explicitly labeled offline, read-only fixture bridge, not a device or installed product. Screenshots are retained outside the source tree at `output/hardware/ui-fixtures/embedded-ui-fixture-1792059751536-{1380x900,800x600}.png` and `output/hardware/ui-fixtures/embedded-recovery-ui-fixture-1792060063819-{1380x900,800x600}.png`. Both viewports had no document/panel horizontal overflow, overflowing buttons, or page errors, and were visually reviewed. These images are layout checks only and do not establish T2 acceptance. The embedded renderer's seven targeted gating/escaped-text tests and the whole-project typecheck passed at handoff.

Development Electron screenshots at `output/playwright/development/` were visually reviewed on 2026-10-14: the empty 1380x900 workbench, delivery 800x600 view, and settings 800x600 view were nonblank, displayed the brand, and had no document horizontal overflow or incoherent text overlap. QA exercised real isolated engine initialization without authentication, UI project import/task creation, disabled unauthenticated send, actual trusted verifier failure/pass against a manually corrected fixture, and draft preservation across reload. These checks do not establish an authenticated agent software task or installed application acceptance. The newer raw-log reader and operation cancellation still require their dedicated integration checks.

The renderer produced no TypeScript diagnostics after the integration changes, and the product build completed successfully on 2026-10-14. The whole-project check still had a QA harness environment typing error at renderer handoff. Re-run `npm run typecheck` and `npm run build` after that fix. Installed Electron verification must cover real login, streamed tool output, approval decisions, stop terminal states, steer failures, project/session switching during diff reads and execution, acceptance failure logs, evidence invalidation, and exports. Actual completion of these checks is recorded by the integration owner; this document does not claim they have passed.
