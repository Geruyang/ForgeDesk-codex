# Background Keil Compilation

The production-default GestureScreen build uses the pinned `D:/STSoft/Keil5/UV4/UV4.exe`, original ARM compiler/linker, reviewed UVPROJX and target, copied snapshot, output paths and 180-second deadline. Background invocation is part of the formal installed workflow, not an opt-in alternative compiler experiment. No alternate compiler, project/tool hash, global setting, registry value or hardware authorization is changed.

The invocation is now:

```text
UV4.exe -b <snapshot/MDK-ARM/GestureScreen.uvprojx> -j0 -t GestureScreen -o <operation/keil-build.log>
```

Keil's [official Command Line reference](https://www.keil.com/support/man/docs/uv4/uv4_commandline.asp) documents `-j0` as hiding the GUI and suppressing messages for batch testing. The local Keil skill's `references/compiler-notes.md` and `scripts/keil_build.py` use the same flag. The installed local manual is `D:/STSoft/Keil5/UV4/uv4.chm`; an attempted hidden `hh.exe -decompile` returned exit 0 but produced no extracted topics, so it is not claimed as a successfully inspected local manual page.

`packages/engineering-runner/processes.ts` already uses `shell:false` and `windowsHide:true`; the unchanged native process host also sets `STARTF_USESHOWWINDOW`, `SW_HIDE` and `CREATE_NO_WINDOW`. Those startup flags alone do not prove an application will never show its own GUI. The additional UV4-supported `-j0` is the application-level suppression, while the original Job Object supervision, timeout and process-exit checks remain intact.

The `-o` build log remains the success/error source, with process output retained separately. Existing error/warning exit-code handling and source/artifact/hash checks are unchanged. This keeps the original compilation chain rather than claiming an untested alternate compiler produces equivalent output. Separate builds intentionally receive different random build IDs, so byte-identical HEX/AXF files are not promised.

Pure command tests and mocked-service tests verify arguments, path handling and unchanged build evidence rules. The initial source-change checks did not execute UV4 or access hardware. Subsequent coordinating installed runs did execute the original pinned Keil toolchain successfully:

| Installed version / run | Actual build evidence |
| --- | --- |
| 0.3.2 / `t2-1792065173815-dafb60` | Build operation `c20d6ff1-59ad-4f6d-80f5-dbc2c8a8853b`, process exit `0`, log SHA-256 `f8b1f4fecb37c5c556951829ce725940121b67064ab1586357545623eb8b0f4f`; all ten fixed-target T2 controls passed |
| 0.3.3 / `t2-1792066168842-c9f6aa` | Build operation `b0957fcb-0a8e-4a3e-a69e-018ba04fbfa8`, process exit `0`, log SHA-256 `e26b789e71358a84e37dbad132e6ed377473c98d2a09136d95b7da1f5e72fd08`; the later inspect-start state rename failed before worker launch, so this version did not pass T2 |
| 0.3.4 / `t2-1792067819027-e68a72` | Build operation `224054fe-51ce-498e-900d-b82e6dc3c5ef`, process exit `0`, log SHA-256 `29e47a65a808352484982869d8218553da2be748530bb86d0be280a40d9a3ed1`; all ten fixed-target T2 controls passed, zero report failures/page errors |
| 0.3.4 / `t2-1792069554285-c061bf` | Formal background-flow revalidation; build operation `76fe7d52-66ac-4b0a-885b-ba4a9eebcaf1`, process exit `0`, log SHA-256 `6bb8336b69338a5109e6f5323ca62cef95aca214ef6b94291421cce7aca5f687`; all ten controls passed with zero failures/page errors |

The evidence files are `output/t2/<run>/evidence.json`. These installed builds validate compilation through the configured background invocation. Foreground-window identity and focus were not sampled continuously across these builds, so they do not establish comprehensive no-focus-steal or no-window behavior on all desktops. Startup flags and the documented `-j0` intent remain distinct from measured focus behavior. The 0.3.3 stranded application's exact forced cleanup is recorded separately in `output/t2/t2-1792066168842-c9f6aa/coordinator-cleanup.md`; it is not a normal-close pass. The distinct 0.3.4 installed run passed normal close/restart and the complete ten-control fixed-target plan. Final 0.3.4 regression was 286/286 with successful typecheck/package/install; see T2_INSTALLED_RESULT.md for exact artifacts and scope.

## Formal Background-Flow Revalidation

Run `t2-1792069554285-c061bf` revalidated installed 0.3.4 without changing the frozen runtime commit `a8973639413132e15a0acb8f171236a842c1bfd6` or installer/resource hashes. It completed at `2026-10-15T13:14:30.935Z`, passed all ten controls and the coordinator observed harness exit 0. This is the same user-driven fixed-target workflow (`realModel=false`, `secondUser=false`), with original visible native approval operated under explicit user delegation and no synthesized dialog result. The direct Arm Compiler/headless equivalence experiment did not replace this UV4 production route.

Read-only process metadata observation ran from `2026-10-15T13:07:25.1791581Z` to `2026-10-15T13:09:55.8328244Z`: 140 samples in a roughly 150-second bounded observation. Twenty-two samples contained the actual matching UV4 process, all the same PID `17804`, parent PID `30164`, executable `D:/STSoft/Keil5/UV4/UV4.exe`, with this run's project/log paths and `-b ... -j0 -t GestureScreen -o ...` command line. All 22 reported `mainWindowHandle=0` and an empty title. This is 22 observations of one process, not 22 separate UV4 instances.

The first/last actual-UV4 samples were `2026-10-15T13:09:28.1881553Z` / `2026-10-15T13:09:55.3190388Z`. The observer hit its bounded deadline before the succeeded build record was finalized at `2026-10-15T13:10:19.491Z`; it did not observe UV4 through exit. Build finalization includes post-process hashing and is not a UV4 exit timestamp. Four separate, sparse window-list snapshots filtered to UV4/uVision also returned no matching window. The first three preceded UV4 creation; the last (`13:10:10.918Z`) lies outside the confirmed-alive sample interval, so its build-operation timing does not prove UV4 was still alive. Those snapshots have no foreground PID and are not exhaustive hidden-window enumeration.

Consequently this supports use of the formal `-j0` invocation and absence of a reported main window at the sampled instants. It does **not** prove all-build/all-desktop invisibility, continuous focus preservation, every child/compiler window, or an OS-wide process-tree inventory/cleanup. Compilation/flash/readback/CDC success is established by the operation receipts, not by empty window lists.

Raw files under `output/t2/t2-1792069554285-c061bf/`:

| File | SHA-256 |
| --- | --- |
| `evidence.json` | `728c724034c3481f3c3be0d54fade98f21c2ec93b348d798c11adcf4a12ffd24` |
| `keil-background-observation.json` | `9c3ba5c450b3f54901d36900b6b2308c8a1fe997699515217754dceb0ba02c4b` |
| `keil-window-samples.json` | `91bc0b316f1eed6456d918d782cb8051fb219c4fa8183caa28e6806cb99228f0` |

The [IDE-free same-Arm-Compiler comparison](KEIL_HEADLESS_EQUIVALENCE.md) remains only an offline equivalence experiment using a fixed all-zero build ID. It is not the formal build path, a replacement compiler qualification or a flashed acceptance image.

Independent retained-artifact verification is recorded in `output/t2/t2-1792069554285-c061bf/independent-audit.md`, accepted within these same observation limits. That audit did not launch an application/compiler or access hardware; it is not another hardware run.
