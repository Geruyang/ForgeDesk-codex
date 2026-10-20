# FZ3B Hardened Source And Acceptance Tools

This is a local acceptance workspace, not a completed board deployment or a new
ForgeDesk installer. Second-Windows-account acceptance remains paused.

## Provenance

`source/` contains the canonical Git bytes of the application subset from
`Geruyang/fz3b-semantic-video-search`, commit
`59cdbefade2535dbeea9a34d1658a307ab7f3bb7`, with the separately tested security
changes in this workspace. The original checkout and historical evidence remain
unchanged under `output/hardware/2026-10-16/`. The baseline archive is
`output/hardware/2026-10-16-continuation/upstream-application.tar`.

The source export does not contain the complete model weights, native libraries,
kernel build inputs, or a newly qualified PL bitstream. A source test, catalog
query, R5 build, and real-board inference are different evidence levels.

## Security Changes

- Bound JPEG bytes, dimensions, source pixels and intermediate resize pixels
  before expensive decoding or resizing. Preserve admitted-image preprocessing.
- Validate complete upload metadata and decoded dimensions before queueing or
  notifying R5; recheck admission after decoding to handle cancellation/races.
- Bound protocol buffers, JSON structure/numbers, resynchronization and partial
  frame duration; check deadlines even when the peer sends no further bytes.
- Restrict TCP control/video service and host clients to loopback. Remote access
  requires a separately authenticated SSH tunnel. HELLO is a compatibility
  handshake, not authentication. UART remains a physical trust boundary.
- Bound asynchronous CPU-frequency jobs and release resources on failure.

Do not replace the board configuration with `config.example.json`. An existing
`bind: 0.0.0.0` deliberately fails closed with the hardened server. Establish and
verify SSH access and forwarding before migrating the service. This protects
against unauthenticated LAN writes, not against another trusted local board user
or a compromised SSH endpoint.

The platform's earlier fixed direct-IP status probe is a separate legacy-status
path. It is not an authenticated tunnel client and is not evidence that the
installed ForgeDesk release supports the hardened FZ3B application.

## Access And Deployment

`tools/authorize_project_key.ps1` is an interactive, fixed-target SSH bootstrap.
It sends only the generated project public key, preserves existing authorized
keys, and never restarts board services. Verify host trust and enter passwords
only in the SSH terminal. The private key and known-hosts file stay in the
per-user ACL-protected, Git-ignored `.runtime/fz3b-private/` directory. Do not
include that directory in artifacts. Remove only the exact project public-key
entry from the board when this acceptance access is retired.

The deployment preparation tool is offline only. An archive/manifest that passes
verification is not permission to deploy. Required live gates include trusted
SSH, observed deployed-source baseline, backups and rollback, a working tunnel,
and a bounded independent post-deployment verification. No implicit loader,
driver, PL, model, clock or service-start action belongs in a source patch bundle.

New reports and test logs are under
`output/hardware/2026-10-16-continuation/`. Read the latest checkpoint there rather
than treating historical green tests or application telemetry as compute proof.
