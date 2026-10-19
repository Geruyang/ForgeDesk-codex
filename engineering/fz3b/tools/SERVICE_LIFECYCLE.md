# Fixed Application Service Lifecycle

`service_lifecycle.py` is a standalone Python 3.6 standard-library helper. A
reviewer sends the reviewed script bytes to the board's existing authenticated
SSH session as `python3 -B -`; it does not install itself, connect SSH, deploy
files, import the application, or open a device. This implementation has only
offline mock coverage until a separately recorded board run exists.

The only action target is `fz3b-vision-console.service`. Only one normal
`systemctl stop` or `systemctl start` is permitted. There is no restart, kill,
dependency action, loader command, inference/upload operation, retry-action flag,
arbitrary path, alternate executable, or skip-gate option.

## Invocation

The sender may append an explicit call to the reviewed source instead of running
its final `__main__` block. Both forms use the same `main([...])` parser:

```text
python3 -B - --mode stop --expected-boot-id 5ceb45a3-8903-4efc-9484-ec75c17280df
python3 -B - --mode start --expected-boot-id <same-reviewed-UUID> --expected-hashes-json <exact-approved-five-key-JSON>
```

`--expected-hashes-json` is mandatory for start and forbidden for stop. Its keys
are exactly `board_agent.py`, `camera.py`, `image_boundary.py`, `protocol.py`, and
`upload_source.py`; the values must equal the approved v2 hashes embedded in the
helper. It is not a mechanism to bless arbitrary code. The JSON is an argument,
not data read from the script's stdin. No board files are changed by the helper.

The fixed application root is `/root/fz3b-vision-console-20261009-001`. Readiness
evidence contains SHA-256/size, not bodies, for the unit, five payload files,
`run.sh`, `link_setup.py`, `board_runtime.py`, and semantic contract. Only fixed
config bind/port fields are emitted; no environment, auth, license, key, process
command line, or arbitrary config body is read/emitted. The unchanged start-chain
code hashes are observations for the operator's separate readiness review, not
additional newly approved payload files. Both mode gates bind the supplied boot
UUID before and after the action.

## Gates

The unit's raw SHA-256 must be
`1089e63bb0138e9c0f0c45f22ad8f95a74bcc92fca998fa541f37836844d599b`.
The live manager must report the exact fragment, no drop-ins, no pending daemon
reload, non-transient, fixed working directory, `Restart=no`, `SendSIGKILL=no`,
and `TimeoutStopUSec=6min` (360 seconds). Other renderings fail closed rather than
being guessed equivalent.

Stop requires active/running with a positive MainPID. A single loopback
`127.0.0.1:8765` socket sends only HELLO and status. Both responses must have the
fixed semantic contract, platform A0005, protocol 1, matching boot, inference
`STOPPED` with literal JSON null error, no upload, and no CPU-frequency change.
The socket is closed before `/proc` inspection. All remaining live 8765 TCP
states block; only LISTEN, TIME_WAIT and CLOSE are non-active. Every 8765
listener must belong solely to the reported application MainPID.
Normal application shutdown may also restore its configured serial getty and
close camera/UART/R5 resources; the helper does not replace that shutdown path.

The helper is Linux-root-only to avoid claiming a partial process scan as a
complete one. It compares `/proc/*/fd` metadata to the fixed A0005 character
device's rdev, so an alias path is not ignored. It uses no device open or ioctl.
Permissions, malformed proc records, scan limits, missing device, foreign network
namespace, unowned/foreign listener, or any device owner block the action. A
short bounded passive scan allows the helper's closed TCP socket to drain; it
does not exempt that connection or any CLOSE_WAIT connection.

Start requires inactive/dead with MainPID 0 and no 8765 listener/active connection
or A0005 owner. All five deployed payload hashes must match the fixed v2 mapping,
and config must explicitly bind `127.0.0.1` with fixed control/video ports
8765/8766 (defaults for omitted port keys are the application's fixed defaults).
The loader, R5, and CPU services must already be active; this helper does not
start/restart them. It checks their active state again after normal start. Start
readiness retries only a connection-refused status probe for at most 25 attempts;
it never retries the start action. After start, HELLO/status must still show
clean STOPPED, the listener must belong to the new MainPID, and A0005 must remain
unowned. Code/config/unit bytes and boot are rechecked.

Normal startup **does have accepted existing effects**: ExecStartPre link setup
may add the fixed Ethernet alias; apply_boot_defaults can set R5/CPU defaults;
startup can stop serial getty and open camera/UART/TCP resources. This is the
existing application startup chain, not a headless replacement or new PL step.
The already-active dependency check is a point-in-time guard, not an atomic lock;
the operator must exclude concurrent service/deployment/hardware activity. It
cannot prove that a third party did not change a dependency between checks.

## Timeout And Result

Stop's systemctl client deadline is 370 seconds; start's is 70 seconds. These are
not whole-script deadlines: fixed metadata/status checks have their own bounds.
The action subprocess has stdin/stdout/stderr attached to DEVNULL and a minimal
fixed environment. On timeout the helper does **not** call kill or terminate,
does not retry, does not claim that the client/service exited, and reports
`result=unknown`, `exitObserved=false`, `humanReviewRequired=true`. The operator
must inspect before any subsequent action. The helper is not a rollback tool.

Exit codes: 0 = all requested-action and postcondition gates passed; 1 = blocked
before action; 2 = action was issued but a timeout/nonzero exit/postcondition
failure leaves the result unknown. An already inactive service is not silently
accepted as a successful stop. JSON `passed` is bounded lifecycle evidence, not
SSH authentication, inference, deployment, firmware, or full acceptance proof.

Offline test command, run from the project root:

```text
vendor/hardware/python/python.exe -I -B tests/test_service_lifecycle.py
```
