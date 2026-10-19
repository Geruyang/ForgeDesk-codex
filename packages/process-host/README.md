# Windows process host

Build with `powershell -NoProfile -File scripts/build-process-host.ps1` from the repository root. It produces `vendor/process-host/process-host.exe` and `manifest.json` with the SHA-256 digest.

Call `process-host.exe -- <absolute executable> [args...]` with `shell: false` and appropriate standard streams. The helper inherits its current directory and environment, so the caller must supply the trusted working directory and environment allowlist. It creates the target suspended, assigns it to a Windows Job Object with `KILL_ON_JOB_CLOSE`, then resumes it. A child or parent exit closes the job and terminates remaining descendants. Assignment failure prevents the target from running. This is for cancellable software processes only; never use it to stop an active flash or other hardware write.

The helper reports fixed errors without echoing command arguments. A return code of 64 means invalid invocation, 70 means host setup failure, and 125 means the parent exited first. Other exit codes come from the target process. Windows exit status is a 32-bit value and Node may present signed values differently.

The parent identity is queried through `NtQueryInformationProcess` and held as a process handle. This Windows-specific API must be retested on supported Windows builds. If assignment fails in a restrictive parent job or sandbox, the child is terminated while suspended and the caller receives an error.
