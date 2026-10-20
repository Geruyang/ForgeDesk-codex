# Real-Model Fixed-Target Installed Acceptance

Status: accepted for the stated 0.4.0 real-model fixed-target scope by combining the original execution facts with a passed read-only continuation. The original installed report remains `failed` because its restart assertion compared omitted `undefined` fields, and the first continuation also remains failed. Neither file was relabeled. The second continuation passed all eleven controls, with zero failures/page errors, two read-only GUI round trips and two normal closes, completing at `2026-10-15T15:28:47.928Z`. Its harness exited `0`.

Accepted continuation: `output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077968892/evidence.json`, SHA-256 `995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`. The independent read-only release-reader check rehashed the actual installed installer/executable/resources and accepted this report with exit `0`, scope `real-model-fixed-target-installed-T2` and method `original-execution-plus-readonly-continuation`. That check did not create release files or repeat a model/hardware action.

The 0.4.0 scope is `real-model-fixed-target-installed-T2`, distinct from 0.3.4's completed `user-driven-fixed-target-installed-T2` run with `realModel=false`. That historical manual result remains version-bound and cannot satisfy this new scope by changing a label, selecting a model in the UI, or reporting an assistant success message.

## Actual Execution And Retained Failures

Original execution: `output/hardware-agent/hardware-agent-1792076310974-ba6e7c/evidence.json`, SHA-256 `aa521ab556b4ab7f7129da61b797bd21a7e5afff9423da56782d1bba65c8ddd3`. The file is retained unchanged with `result=failed`. Its first nine controls passed; `restartNoReplay` and `normalClose` remained pending when the assertion failed, despite two recorded normal GUI closes. The completed model run and post-restart failure snapshot are equal after JSON persistence; the difference triggering the original assertion consisted of the four omitted `undefined` fields. This does not rewrite the original report as passed.

The first continuation, `readonly-continuation-1792077610585/evidence.json` under that run directory, also remains `failed`. Its installed process identity query failed before a completed read-only round trip; its report records zero submitted model turns, zero submitted hardware actions, an empty round-trip list and `needsHumanClose=true`. The same directory's `operator-close.md` records the coordinator clicking the original close button normally and a subsequent CIM query confirming PID `26708` no longer existed; no forced termination was used. The original flag is preserved history, not a current outstanding request to close the app. That cleanup does not change the failed result or count as an automated acceptance round trip. The coordinator completed a separate second continuation without repeating the physical workflow.

| Confirmed execution fact | Original report / receipt |
| --- | --- |
| Installed version / runtime source | `0.4.0` / `b9a61615c564ea560604503ff7190ecc5e8620f0` |
| Installer SHA-256 | `e95e29b52552c11e66f47aa8eced35703a696e4593a21d6d7d869b8298a4c67e` |
| Executable / app.asar SHA-256 | `a1ca77d56e099c4e6301495fe049f9df887487383903bbf3feea89d0310868d9` / `c47c4e1f2619e00d13e588ff783b4b8edd444e483274004c29d401e2e27a50ce` |
| Model controller run | `8918af01-bee3-4d46-a468-c8ecc66bf5d8`, model `gpt-6.1-sol`, completed; generation `1792076405677838` |
| Session / task | `e61aa04d-8cfd-4625-b35f-f2fe4cda95b7` / same task ID |
| Engine thread / turn | `01a14014-05a1-7f40-91e6-e70d0b03352f` / `01a14014-0ccc-7031-abbc-dfcbea43a9fc` |
| Compiled build ID | `b70be3f97e3cb559b570f945c5f45ab3a2037707f7ca1d1eae983f1dd9abbc2e` |
| HEX / AXF SHA-256 | `1037c5c4c305178c86db00fca25ee10dccebb5f14bd67faf8dec049a38995c55` / `580331fadc58f7519b1dfd431da0a20d2a1ac56e9aeff9f7355ee31120b34553` |
| Physical workers | Exactly four: build, inspect, flash and verify; each succeeded with worker exit recorded |
| Flash readback | 584,848 defined bytes, zero mismatch; 32 differing bytes before flash; SHA-256 `d0d562cb2879c23f499d189d745b41d2561747688f0cc22f232ac6424a38c3b0` |
| Live verification | Two independent nonce128/raw FDR1 responses; CRC, UID and compiled build ID checked; frames `85 -> 88`, uptime `12979 -> 13340 ms`, flags `31` |
| Live health | Camera errors/timeouts and display errors zero in both responses; SYSCLK 168 MHz / PLL48 48 MHz |
| Export | Eight files / four operations, evidence index SHA-256 `2c064fcf1ef7a2b7ab351866f82f4bd56807d97f5fc894e6d7bf498d253e9bbf` |
| Frozen runtime full regression | 402/402 in `output/hardware/t2-integration/test-0.4.0-final.log` |
| Final targeted checks / typecheck | 53/53 in `output/hardware/t2-integration/test-0.4.0-continuation-final.log`; typecheck passed in `typecheck-0.4.0-continuation-final.log`. These later targeted checks are separate from, and are not added to, the 402-test runtime suite |
| Final read-only continuation | `readonly-continuation-1792077968892`, all eleven controls passed; two normal GUI round trips; zero new model turns/hardware actions, no explicit engine connection |
| Read-only release validation | Actual installer/EXE/resource hashes matched; source and continuation byte hashes verified; reader exited `0` without publishing |

The six actual model calls were recorded in this order, with complete run/session/task/generation/thread/turn/call and request-key associations in the original JSON:

| Tool | Actual call ID | Worker operation |
| --- | --- | --- |
| `embedded_status` | `call_e501147d0da0435e87d29e451457a61b` | Read only |
| `embedded_build` | `call_d53248c483b84a19b5081f503cf44ae6` | `d617954d-56ed-44a0-9337-84a00615d898` |
| `embedded_inspect` | `call_6f1f32289d52409e99d4ac3c810095fb` | `a2f00dcb-7fa6-4312-bee8-4f5be28b092f` |
| `embedded_request_flash` | `call_34a641fe4f4e431383423a9fa6383a5c` | `193d6bc5-593c-4206-a36a-aca1180fc9cb` |
| `embedded_verify` | `call_bdba829607d34fda940d7faa6ecd1f6e` | `eb6a9a3a-f4ea-4682-8b1c-d4641db99b89` |
| `embedded_export` | `call_207c91e06f3e4487817a1eb1ce7ceed7` | Checked evidence export, no fifth hardware worker |

## Scope And Continuation Gates

The installed execution used the existing public product login without copying credentials, selected model `gpt-6.1-sol`, a verified restricted-hardware policy and a fresh engine thread/turn. The policy allowed only `embedded_status`, `embedded_build`, `embedded_inspect`, `embedded_request_flash`, `embedded_verify` and `embedded_export`, with no shell, external MCP or execution environments. The target remained Challenger V1, chip `0x419`, 1024 KiB Flash, UID `0037001b3133510432383236`, fireDAP serial `594AC1D7613FED24` and CDC serial `326F32513133`. The original native authorization was separately approved and consumed by the recorded flash; model output did not grant approval.

The read-only continuation must retain that completed model run, native grant, four worker records and export without submitting another model turn, connecting the ordinary engine, or invoking hardware actions. It must recheck installed pins and recorded receipts/exports and perform two GUI read/normal-close round trips. Only `hardware.operations[*].progress` and `run.calls[*].result.operation.progress` are excluded as telemetry during comparisons; other same-named fields remain significant.

A completed run's approval display may derive `approved -> expired` after the original consumed grant's expiry. The actual observed run remains expired and must carry exact `derivedApprovalExpiry` metadata bound to the original expiry and observation timestamp. Temporary comparison copies may normalize only that display field after checking time and the unchanged approval/consumption history. This does not permit reuse of the grant, another model turn, a changed call history or another write.

The successful continuation observed that display-only expiry at `2026-10-15T15:27:28.486Z` and `2026-10-15T15:28:25.679Z`, both after the original consumed grant's `2026-10-15T15:08:44.400Z` expiry. Both actual round-trip runs retain `nativeApproval=expired`; the historical original run remains approved. The grant, original approved call and its consumed flash association remained unchanged.

The original report schema uses `output/hardware-agent/hardware-agent-<13-digit timestamp>-<6-hex>/evidence.json`. A continuation uses that same run directory's `readonly-continuation-<13-digit timestamp>/evidence.json`, with `sourceExecutionEvidence` containing the original relative path, byte SHA-256, `result=failed` and exact original failure text. Required combined controls are `publicLogin`, `policy`, `modelCalls`, `build`, `inspect`, `nativeAuthorization`, `flash`, `verify`, `export`, `restartNoReplay` and `normalClose`, each `passed`, with empty continuation failures/page errors and no pending cleanup. A valid continuation does not erase the original failure. It records `readOnlyCheck` with zero submitted model turns/actions, no explicit connection and two observed round trips, plus the original policy/run/hardware/call associations/native/release/export facts.

Release recording has an explicit separate entry point, to be used only after actual evidence exists:

```text
node scripts/record-release.mjs --runtime-source b9a61615c564ea560604503ff7190ecc5e8620f0 --hardware-agent-evidence output/hardware-agent/hardware-agent-1792076310974-ba6e7c/readonly-continuation-1792077968892/evidence.json
```

Before recording, prepare the version-specific source archive `release/ForgeDesk-source-hardware-agent-<version>.zip` (for 0.4.0, `release/ForgeDesk-source-hardware-agent-0.4.0.zip`). The model branch requires that archive and records its own basename in the checksum list; it does not use or replace the historical `release/ForgeDesk-source.zip`.

Recording writes `release/manifest-hardware-agent.json` and `release/SHA256SUMS-hardware-agent.txt`, with explicit scope, model, runtime commit, continuation digest and original failed-source provenance. The accepted method is `original-execution-plus-readonly-continuation`, not an unchanged original run marked passed. Recording is a separate coordinator release step; this documentation update and read-only reader check did not publish those files. This route does not replace `release/manifest.json`, `release/SHA256SUMS.txt`, the old `--t2-evidence` checks, or their manual acceptance meaning. The two evidence options are mutually exclusive. The validator rejects changed original bytes, an original passed or unrelated failed report, altered model/hardware/native/resource facts, submitted turns/actions, incomplete GUI checks and invalid expiry normalization.

This combined acceptance establishes only this model, installed artifact, account context, restricted tool chain and fixed board. It does not establish unrestricted autonomy, OS device/account isolation, the second-SID matrix or a complete physical wrong-device/disconnect/crash/power-loss fault matrix. Second-SID work remains paused. All source, fixtures and retained evidence belong inside this project. The original failed execution and first failed continuation remain part of the delivered history.
