# Offline PS Deployment Bundles

`prepare_deployment.py` is a host-side Python 3.9+ standard-library tool. It
produces or verifies local data only. It contains no SSH connection, remote
command execution, extraction, service activation, device access, or PL action.
Local success never authorizes deployment or proves target authentication.

## Fixed Policy

The current policy is `fz3b-ps-loopback-data-v2-gitcanonical`. Its upstream input
is the exact `59cdbefade2535dbeea9a34d1658a307ab7f3bb7` canonical application archive
with SHA256 `b847d3768a765625b421ba0e798d9d75f5673c980114fe7c15e1d7960b247d95`.
Each of its 53 regular members was checked byte-for-byte against `git cat-file
blob` and its Git object hash. Archive selection is the exact v1 application-file
list, not the broader HOST/PS roots which also contain unrelated model sources.
There is no command-line override for that pin or for the payload allowlist:

- `PS/vision_app/board_agent.py`
- `PS/vision_app/camera.py`
- `PS/vision_app/image_boundary.py` (new file, deployed target must be absent)
- `PS/vision_app/protocol.py`
- `PS/vision_app/upload_source.py`
- `PS/config.example.json` (reference only)

The example is labeled `config.example.hardened.json`; it is never an instruction
to replace an installed `config.json`. Its bind must be a literal IPv4 loopback
address. Inline credential fields are rejected. Referenced token paths are not
opened. This is not a general credential-content scanner: inputs must be trusted,
reviewed source, not arbitrary uploaded Python files.

All other source files must match the pinned upstream archive, except the three
explicit non-deployed HOST patches `HOST/vision_app/protocol.py`,
`HOST/vision_app/transports.py` and `HOST/vision_app/video_analysis.py`.
These HOST patches are recorded but never shipped.
Extra files/directories, missing files, symlinks, reparse points and hardlinked
regular files fail closed. Source is read twice to detect changes during planning.
Existing-link checks do not claim to resist malicious same-user concurrent path
replacement. Review and freeze the trusted local source before using this tool.
Wait for all source owners to freeze before making a release bundle; fixture
tests do not freeze current production-source hashes.

V1 is retained under
`output/hardware/2026-10-16-continuation/deployment-policy-v1/`, along with the
unchanged original `deployment-bundle/` and `upstream-application.tar`. Its archive
SHA is `a740b83895d86834fb880534fb74a498395d3847cbf975d5e930e36656e67675`; that
Windows-exported baseline contains CRLF bytes which differ from canonical Git
blobs and the captured board files. This was an exact-base rejection, not a reason
to accept arbitrary newline conversions. Use the archived v1 verifier only for
historical v1 evidence. The current verifier rejects v1 policy or archive pins.

`release-source-v2/` is an independent snapshot: all unchanged files come directly
from the canonical archive; the six frozen PS payloads and three excluded HOST
patches are overlaid with their original reviewed bytes, including their existing
line endings. `engineering/fz3b/source` was not edited. No file is generically
normalized and no verifier silently treats LF and CRLF as equivalent. The raw-Git
audit and overlay hashes are in `canonical-baseline-v2/raw-git-audit.json` under
the same continuation output directory.

No license, key, auth directory, runtime/output directory, model, BIT, loader,
driver, service unit or startup script can enter the six-member data tar. Existing
upstream R5/loader/service files are checked for unchanged bytes and excluded.
This file policy is not a semantic proof that arbitrary Python edits cannot touch
PL: reviewing the exact permitted patch bytes remains mandatory. Adding any new
payload or expanding privileges requires a reviewed tool-policy revision, never
an `include`, `ignore`, or bypass option.

## API And CLI

```python
prepare_plan(source_root, base_archive) -> dict
build_bundle(source_root, base_archive, output_dir) -> dict
verify_bundle(manifest_path, bundle_path, base_archive,
              expected_manifest_sha256) -> dict
```

`prepare_plan` writes nothing. `build_bundle` writes a new directory containing
`manifest.json`, `data.tar` and `deployment-plan.json`; an existing output
directory is refused. `plan` CLI writes only the deployment plan. Use separate
fresh directories for plan and build. Incomplete local output after an I/O failure
is not an accepted package and is not automatically deleted or overwritten.

```powershell
python -I -B engineering/fz3b/tools/prepare_deployment.py plan `
  --source-root output/hardware/2026-10-16-continuation/release-source-v2 `
  --base-archive output/hardware/2026-10-16-continuation/canonical-baseline-v2/upstream-application-gitcanonical.tar `
  --output-dir output/hardware/2026-10-16-continuation/ps-plan-v2-REVIEW-ID

python -I -B engineering/fz3b/tools/prepare_deployment.py build `
  --source-root output/hardware/2026-10-16-continuation/release-source-v2 `
  --base-archive output/hardware/2026-10-16-continuation/canonical-baseline-v2/upstream-application-gitcanonical.tar `
  --output-dir output/hardware/2026-10-16-continuation/ps-bundle-v2-REVIEW-ID

python -I -B engineering/fz3b/tools/prepare_deployment.py verify `
  --manifest output/hardware/2026-10-16-continuation/ps-bundle-v2-REVIEW-ID/manifest.json `
  --bundle output/hardware/2026-10-16-continuation/ps-bundle-v2-REVIEW-ID/data.tar `
  --base-archive output/hardware/2026-10-16-continuation/canonical-baseline-v2/upstream-application-gitcanonical.tar `
  --expected-manifest-sha256 APPROVED_LOWERCASE_SHA256

python -I -B tests/test_deployment_bundle.py
```

Review and retain the manifest digest separately from the transfer. A digest read
from an untrusted adjacent manifest is not authentication. The manifest binds the
pinned base archive, exact base/new file hashes, source-snapshot digest, tar digest,
target paths and roles. The verifier checks this exact schema and member set
without extracting files. Only the canonical generated plain USTAR regular-file representation is admitted;
duplicates, path escapes, links, extended headers, trailing hidden data and
uncontrolled metadata are refused. Tar files are deterministic with mode `0644`,
uid/gid zero, empty owner names and zero timestamps. These are archive metadata,
not a claim about Windows ACL enforcement. Limits are 512 KiB per source/payload
file, 1 MiB aggregate payload, 2 MiB tar/base archive and 64 KiB manifest.
The pinned upstream Git input alone may contain its exact first global PAX
commit-comment header. That exception never applies to a deployment payload tar.

## Mandatory Future Deployment Gates

Every generated plan has `deployment_authorized: false` and unverified gates.
Editing a plan or its gate labels cannot create authorization; the verifier does
not trust a plan as target-state evidence and always returns authorization false.
No local verify result marks deployed base hashes, root SSH authentication,
tunnels, hardware identity or remote validation as passed. An imported license
and a known SSH username do not satisfy those gates.

A future, separately approved deployer must first bind the exact installed PS
root and independently check all existing base hashes; added targets must be
absent. It must reject links at every target path component, confirm application
quiescence without invoking loaders/PL, and create hash-verified backups and a
tested rollback path before any write. Stage on the target filesystem and perform
same-directory atomic replacement per file; multiple files are not one atomic
transaction. Never extract this archive over a live deployment with `extractall`
or equivalent uncontrolled commands.

Changing this application's old public control/video **TCP** bindings to loopback is a **separate explicit
configuration step**, allowed only after authenticated SSH and all required
tunnels have been independently confirmed. There is no default ignore flag. Do
not copy the example onto current board configuration, run `run.sh`, restart
loader-dependent services, or program PL as part of a software safety patch.
UDP endpoints are outside this patch/deployment scope and must remain unchanged.
The plan's broad `public_udp_tcp_shutdown_authorized: false` field is a denial,
not a proposed UDP action or evidence that a UDP transition is required.

After a separately authorized activation, independently verify loopback bindings,
correlated status, malformed/oversized/unauthorized negative cases, and unchanged
PL/driver state. Any failure requires verified backup restoration and removal of
only the exact newly added files. Failed or unconfirmed rollback remains
failed/unknown and must not release the deployment lock. This tool performs none
of those remote steps and cannot certify their outcome.
