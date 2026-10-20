# Hardware Runtime

## Scope

The application owns a portable Windows x64 CPython runtime at `vendor/hardware/python/python.exe`. It does not use the builder's Python/venv or change PATH, registry, global packages, drivers or user-site configuration. Hardware worker source is supplied separately as `engineering/hardware-worker.py`; this preparation script does not execute it or authorize hardware actions.

Pinned direct dependencies are pyOCD `0.44.1` and pyserial `3.5`. All 27 resolved distributions, exact wheel URLs and SHA-256 hashes are recorded in `vendor/hardware/manifest.json`; `python/requirements.lock` additionally uses pip's `--require-hashes` format. Subsequent preparation uses the manifest's complete lock, not fresh transitive version resolution.

## Sources And Integrity

- Python: [official Python 3.13.16 release](https://www.python.org/downloads/release/python-31316/), [Windows embeddable x64 ZIP](https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip).
- Official ZIP SHA-256: `97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297`. Preparation rejects a different download/cache digest.
- `python.exe` Authenticode is checked with Windows `Get-AuthenticodeSignature`; preparation requires `Valid` and a Python Software Foundation signer. The observed certificate subject, issuer and thumbprint are retained in the manifest. Sigstore/GPG were **not verified**; `supplyChain.sigstoreVerified` is explicitly false.
- Packages come from `https://pypi.org/simple`, with wheel download hosts restricted to `files.pythonhosted.org`. Only binary wheels compatible with CPython 3.13 Windows x64 are accepted; no source builds or package setup scripts run.
- Python `LICENSE.txt` and wheel distribution metadata/licenses are retained. The pyserial 3.5 wheel omits its complete license, so its [upstream v3.5 BSD license](https://raw.githubusercontent.com/pyserial/pyserial/v3.5/LICENSE.txt) is included separately, pinned to SHA-256 `f91cb9813de6a5b142b8f7f2dede630b5134160aedaeaf55f4d6a7e2593ca3f3`.

The manifest's `files` entries use paths relative to `vendor/hardware`, with `path`, `bytes` and SHA-256 for every runtime file. Verification requires the exact file set (including licenses, metadata and lock), rejects symbolic links and checks content/size. The manifest itself is outside its own inventory; product packaging/trust policy must protect and pin it separately. These hashes detect mismatches against a trusted manifest, not malicious replacement of both files and manifest by the same user.

## Isolation And Invocation

Workers must use the absolute packaged executable with fixed arguments `-I -B`, followed by the trusted worker path and validated input. `python313._pth` contains exactly:

```text
python313.zip
.
Lib/site-packages
```

There is no `import site`: user-site packages, registry/environment Python search paths, arbitrary `.pth` execution and the current working directory are not added. The runtime includes its own standard library ZIP and native extension/DLL files. pip-generated console launchers are removed because they embed the builder interpreter path; the application invokes `python.exe` directly. The runtime is not an OS sandbox, device allowlist or substitute for worker-side approval/identity validation. Available pyOCD plugin metadata does not authorize use of those probes/transports.

## Preparation And Pure Verification

Run from the project with an existing trusted pip-capable Python, used only to install target wheels:

```powershell
node scripts/prepare-hardware-runtime.mjs --bootstrap-python C:/Users/ruyangge/.codex/mcp/serial/.venv/Scripts/python.exe
node scripts/prepare-hardware-runtime.mjs --verify
```

Preparation refuses to overwrite an existing runtime. To reproduce from the committed manifest, use a clean checkout/runtime directory and the same command; the manifest supplies all package versions/hashes. Keep an existing runtime intact until its replacement has passed verification. Downloads, pip reports/logs and pure-check receipts stay under `output/hardware/tooling`, not global directories. The script neither reads credentials nor emits environment values.

The one-time `--prune-console-launchers` migration first verifies the complete existing inventory, validates fixed launcher directories remain inside this runtime and removes only recognized generated files (no recursive deletion). It refuses unknown files or links and records the prior manifest digest and removed paths. Normal preparation performs the same launcher filtering, including pip's `Lib/site-packages/bin` location; verification rejects packaged files in any of the four launcher directories.

The pure check imports `pyocd`, `serial`, `hid`, `usb`, `libusb_package`, `cmsis_pack_manager` and `pyocd.core.session.Session`; reads pyOCD entry-point metadata; checks exact Python/direct-package versions, isolated/no-user-site/no-site flags and that every Python search path/imported module is inside this runtime. It does not call probe discovery, `list_ports`, connect/reset/flash routines or a serial constructor. Evidence is `output/hardware/tooling/verify.json`.

Successful imports/metadata and file verification prove preparation and basic runtime compatibility only. They do not prove hardware access, worker workflow success, driver readiness, firmware safety or second-user installed acceptance. No hardware action is part of this preparation task.

## Observed Preparation

On `2026-10-15`, the final locked runtime contains 1,021 files, 27 distributions and 31 retained license files. Manifest SHA-256 is `71736b44808ffae3fdc703bfcf57059cb2c646251557f97a1cc4470f153d02b2`; the Python executable SHA-256 is `31fe10b4ed82a2f960af0ef9931f46a4b84ff286f8b6ffd9dee098cf4f10f17f`. Authenticode reported `Valid`, signer `Python Software Foundation`, certificate thumbprint `E875769F82782E3C919984CF747D21B943E0AEBE`. A final review found 17 generated scripts in pip's `Lib/site-packages/bin` location had survived the initial filtering; the migration removed them, refreshed the manifest and passed full inventory/import verification. The initial `consoleLaunchersRemoved` assertion was not accurate and must not be used as proof of that earlier layout.

An independent project-owned copy passed imports from a path containing spaces with an empty process PATH and intentionally invalid `PYTHONHOME`, `PYTHONPATH` and `PYTHONUSERBASE`. Its receipt is `output/hardware/tooling/portable-check.json`, recorded at `2026-10-15T10:21:42.583Z`. On a separate selftest copy, content tampering, an unexpected file and a renamed/missing expected file each failed verification; restoring the copy passed (`output/hardware/tooling/integrity-selftest.json`, `2026-10-15T10:22:19.326Z`). Those historical receipts bind the initial manifest `a24b5081f25e684834eab8ddcfef45f43484a28c4819d71f7673a2e39d1a6eac`, not the later cleanup manifest. No production runtime file was modified for those negative tests; the current `verify.json` binds the final inventory.
