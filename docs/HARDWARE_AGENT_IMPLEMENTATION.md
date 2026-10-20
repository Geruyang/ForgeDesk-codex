# Restricted Hardware Agent

This implementation is a new acceptance scope. The accepted 0.3.4 installed T2
records remain user-driven (`realModel: false`); they are not model acceptance.

## Installed Checkpoint

Installed 0.4.0 runtime source is `b9a61615c564ea560604503ff7190ecc5e8620f0`.
The actual `gpt-6.1-sol` controller run `8918af01-bee3-4d46-a468-c8ecc66bf5d8`
issued status, build, inspect, request-flash, verify and export calls. All six
calls and the four associated physical workers succeeded, including native
authorization, zero-mismatch defined-byte readback, nonce-bound CDC checks and
the checked eight-file export. This is actual restricted-model execution,
separate from the offline protocol probe below.

The original report at
`output/hardware-agent/hardware-agent-1792076310974-ba6e7c/evidence.json`
nevertheless remains `failed`: its restart assertion compared transient
`undefined` properties against their omitted persisted JSON representation.
Original SHA-256 is
`aa521ab556b4ab7f7129da61b797bd21a7e5afff9423da56782d1bba65c8ddd3`.
The first read-only continuation also failed during installed process identity
querying. Its same-directory `operator-close.md` records a normal original-window
close and native CIM confirmation that PID `26708` was absent, with no forced
termination. Its retained `needsHumanClose=true` flag is historical, not an
outstanding close request. Both failures remain retained; the physical workflow
is not retried, and this cleanup is not an automated acceptance round trip.

The second read-only continuation,
`readonly-continuation-1792077968892/evidence.json` in the original run directory,
passed all eleven controls with zero failures/page errors and two normal GUI
round trips at `2026-10-15T15:28:47.928Z`. It rechecked the same installed pins,
model run, grant, four worker receipts and export, with zero submitted model
turns/hardware actions and no explicit engine connection. Its SHA-256 is
`995d5cd044ac6953e624c026252253c114b16b9e2b130df527eb3bcb4aaf32b0`.
An independent read-only release-reader run rehashed the actual installed
artifacts and accepted this combined evidence with exit `0`; no release was
published by that check.

Only `hardware.operations[*].progress` and
`run.calls[*].result.operation.progress` may vary as telemetry. Both continuation
observations retained the actual derived `nativeApproval=expired` after the
original consumed grant expired. Exact metadata records this display-only
change; temporary comparison copies normalize only that field, while original
call/grant/state facts remain bound and the grant cannot be reused.

The accepted method is the retained failed execution plus a passed read-only
continuation, not a relabeled original report. See
[HARDWARE_AGENT_ACCEPTANCE.md](HARDWARE_AGENT_ACCEPTANCE.md) for confirmed facts
and the exact source/continuation evidence references. The frozen runtime full
regression passed 402/402; final harness/continuation targeted checks passed
53/53, with typecheck passing. These are separate receipts and must not be
added into a single suite count. Logs are
`output/hardware/t2-integration/test-0.4.0-final.log`,
`test-0.4.0-continuation-final.log` and
`typecheck-0.4.0-continuation-final.log` in the same directory.

## Ownership

- Engine adapter: isolated app-server profile and fixed-binary tool inventory probe.
- Embedded controller: durable run ownership, fixed tools, ordered operations and audit.
- Desktop: dedicated controls and read-only native approval status.
- Coordinator: main-process integration, native approval, packaging and hardware execution.
- QA: offline failures and separate installed real-model evidence.

All generated results stay inside ForgeDesk-codex. Second Windows account
acceptance is paused.

## Execution Boundary

The ordinary software engine is stopped before a fresh restricted model thread
starts. The restricted thread and every turn disable environment access. Its
fixed tool inventory must be demonstrated using the shipped binary and a local
fixture provider before hardware is enabled. That fixture is not real-model
acceptance. No ordinary device MCP permission is added.

The model may call only fixed status, build, inspect, request-flash, verify and
export tools with empty arguments. The host owns project, task, target, paths,
toolchain, request keys, grants and receipts. Each meaningful operation must have
an actual model tool call; an automatic host sequence is not model acceptance.

Native authorization remains separate from model output. A cancelled, expired or
invalid grant cannot launch flash. After approval, runtime and artifact checks
still apply. Stopping the model stops planning and cancels unapproved dialogs;
it does not kill a flash worker, clear an uncertain lock or retry a write.

## Evidence Gates

1. Fixed-binary outbound tool inventory and protocol rejection tests.
2. Controller and main-process tests for scope, ordering, cancellation, duplicate
   calls, persistence failure and restart without replay.
3. Full regression and typecheck, followed by a new installed version.
4. Official-account real model calls linked to native approval and worker receipts.
5. Independent flash/CDC/export evidence audit and normal shutdown/restart.

Only completed gates may be reported as passed. Hardware scope remains the
confirmed Challenger V1 board, fixed fireDAP and fixed GestureScreen profile.

## Offline Protocol Evidence

The final production-adapter probe is
`output/hardware/model-agent-capabilities/adapter-1792073768468/result.json`.
Its transport-only subclass used a loopback fake Responses provider without
authentication. Both captured requests contained exactly the six fixed tools;
one actual dynamic-tool protocol callback reached the host. The production
adapter source SHA-256 remained
`9adc6970a95f7a79fd960dcefcd28517a71dfa0167588d9f811b494c491d1b90`
before and after the probe.

The required MCP and SessionStart-hook marker files were absent. Marker positive
controls and authenticated app/plugin positive controls were not executed.
This is offline protocol evidence, not an official-model run, device test or
general security certification.
