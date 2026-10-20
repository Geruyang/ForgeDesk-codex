# SQLite Long-Path Regression

## Actual Failure

Second-user run `snapshot-1791981176577` used the actual standard SID ending 1006, desktop session 2, installed ForgeDesk 0.2.0 and Node 24.21.0. Public login was true and the engine was ready. The model changed only `numbers.mjs`, but both build operations failed in `sandbox_probe`, before arithmetic verification. The output filesystem write succeeded while `outputSqlite.opened` and `sqliteOutputWriteAllowed` were false with `ERR_SQLITE_ERROR`. This is not a passing repair or evidence of the original arithmetic defect.

The actual output directory length was 216 characters; adding the unique SQLite probe filename produced a 273-character path. The application closed normally. Original evidence remains under `output/second-user/S-1-5-21-1196670755-766692816-2897134863-1006/evidence/snapshot/snapshot-1791981176577/evidence.json`.

## Independent Reproduction

Completed six-case report: `output/runner-diagnostics/sqlite-long-path/run-V9ySXF/results.json`. It uses fresh primary-user fixtures, not second-user private data. With the same physical 273-character file:

- Ordinary absolute paths failed to open both directly and inside the fixed native sandbox.
- Windows namespaced paths opened and completed CREATE TABLE in the permitted output, both directly and in the sandbox.
- A namespaced protected-input path opened and wrote directly; after cleanup, the sandbox denied opening/creation at that same path, with no database or sidecar residue. Therefore the negative control is not merely a path-length failure.

An earlier broader diagnostic matrix also observed journal creation failure near the legacy path boundary, but stopped at a separate Node process-spawn failure for a 263-character working directory. That matrix is not claimed complete. The fix below does not claim support for arbitrarily long process working directories.

## Fix And Scope

ForgeDesk 0.2.1 converts the path passed to DatabaseSync to the Windows namespaced representation on Windows, for both input and output probes. It does not change the physical target, directory structure, marker name, sandbox policy, ACLs, permissions, host-side residue checks, or positive/negative acceptance criteria. Non-Windows behavior remains unchanged. It does not use a junction, copied credential, alternate user, global Git trust exception or shorter replacement data directory.

The smoke harness additionally distinguishes an original arithmetic-verifier failure from a sandbox/permission/infrastructure failure and reports failed-operation diagnostics. Regression results and packaging state are recorded in `QA.md` and `PROJECT_STATE.md`. Actual SID 1006 reacceptance is required after upgrading; the 0.2.0 primary pass cannot establish a 0.2.1 pass.

Reference: SQLite documents distinct Windows VFS path behavior at <https://sqlite.org/vfs.html>. The diagnosis and chosen repair are grounded in the local direct/native-sandbox comparisons above, not inferred solely from documentation.
