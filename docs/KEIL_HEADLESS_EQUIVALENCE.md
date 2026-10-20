# IDE-Free Arm Compiler Build Equivalence

Date: 2026-10-15. Applied the Keil skill and inspected this project's uvprojx,
recorded build commands, linker response file, scatter file and installed tool
versions. No hardware was accessed. No UV4 process or GUI was started for this
experiment. Original GestureScreen inputs/artifacts and the main service were
not modified.

## Answer and Scope

**The IDE can be omitted while retaining the same Arm Compiler toolchain. This
was tested here and produced a byte-identical HEX.** It still uses the installed,
license-managed Arm Compiler 6.24 tools and runtime libraries; it does not prove
that removing every Keil/Arm component, changing licenses, or replacing the
compiler with GCC would give the same result.

The measured fixture is the current GestureScreen T2 overlay source with its
build ID fixed to 32 zero bytes. It is not the older original delivery and is
not a random-ID image from an installed T2 run. Actual service builds deliberately
inject a fresh random build ID, so two such builds must first freeze the same ID
before byte equivalence can meaningfully be tested.

| Route | Assessment |
| --- | --- |
| Same Arm Compiler/assembler/linker/fromelf and inputs, without UV4 | Full independent-copy experiment passed below. |
| Make/CMake/Ninja or another wrapper driving those same commands | Feasible orchestration approach; no such production integration was implemented or accepted here. |
| Different Arm Compiler version, libraries, flags or assembler mode | New comparison required; current result does not extend to it. |
| Arm GNU GCC/binutils/newlib | Requires a project/toolchain port and separate functional validation; no GCC embedded build or byte-equivalence result is claimed. |
| Native MinGW GCC used for host firmware tests | Executes hardware-mocked host tests; it is not the ARM embedded toolchain. |

## Completed Experiment

Evidence directory:
`output/hardware/compiler-equivalence/armclang-20261015T114631887553Z/`.

The experimental script `output/hardware/compiler-equivalence/headless-replay.py`
copied 543 project inputs into a fresh source tree, recorded 43 external CMSIS
include files, and left its Objects directory empty. It replayed all **120
translation units** (119 C files plus startup assembly) with the recorded actual
Arm Compiler arguments, then invoked armlink and fromelf directly. All 122
direct process invocations exited zero. No prebuilt project object was reused;
the existing vendor Cube.AI runtime library was intentionally retained as an
input, as in the reference build.

| Comparison | Result |
| --- | --- |
| Reference and direct-CLI HEX file SHA-256 | Both `f6cab499efda17ed8e38444a6c00954997800b12cf035b6e126b066cd515a3fd` |
| Defined Flash bytes | 584,848 in each image; every record checksum/length and EOF checked |
| Missing / added addresses / differing bytes | 0 / 0 / 0 |
| Whole HEX text file | Byte-identical, stronger than address/value equality |
| All AXF SHF_ALLOC section contents, types, flags, addresses and sizes | Identical |
| Global/weak ELF symbols, entry and selected diagnostic/build-ID symbols | Identical |
| Whole AXF file | Different; this is explicitly not a whole-file equivalence claim |
| Original copied-input sources and reference artifacts after experiment | Hashes unchanged |

Reference AXF SHA-256:
`7d16f7205c817242ce0eb8696ca4f275ecffe7f5d45a33b2e34841c253348fba`.
Direct-CLI AXF SHA-256:
`e590f81a9cb1b3fda73b642f2f6d40d4668cb1b2f99dc4ebbed0b4f6589fd9d6`.
The only section-content differences found were nonallocated `.debug_info`,
`.debug_str` and `.comment`, which contain debug/build metadata including paths
and command descriptions. The map files also have different file hashes, even
though the compared symbol/layout values match. Evidence:
`comparison.json`, `nonalloc-differences.json`, `execution.json`, per-command
`logs/`, and copied `reference/` artifacts. The comparison checks file identity
separately from load-byte and layout equivalence.

The first preparation attempt encountered the precompiled `.lib` record, then
the first dependency-only copy compiled startup assembly but stopped on missing
`mpu_armv7.h`. The IDE `.dep`/`-MMD` list was insufficient as a complete header
copy manifest. The final preparation copies complete declared include roots,
not just headers named in dependency records. Failed attempt directories are
retained; no failure was hidden by reusing their objects.

## Tool and Parameter Binding

Tool directory: `D:/STSoft/Keil5/ARM/ARMCLANG/bin`. Local version output reports
Arm Compiler for Embedded 6.24 under MDK Plus 5.43: armclang `[5f371800]`,
armasm `[5f371400]`, armlink/fromelf `[5f371500]`. Direct compilation and linking
worked with the current installed licensing environment; this is not a license
portability or redistribution test.

| Executable | SHA-256 |
| --- | --- |
| `armclang.exe` | `ad5afaace02844fad6631ebe77d5a995a72f79555ebfa52ce969e735a4d46f91` |
| `armasm.exe` | `3b2c9a997453fbd5f88be730fe5eb553c1066982bbfe24bbe3436c02a4678895` |
| `armlink.exe` | `f63cf864edbf904e7db98647038ec8e75894a216c7fabc179277874ea6050f08` |
| `fromelf.exe` | `7a7d5998fed3490fb455a0c416336a1ccf02609012312efe309b4a1795039f51` |

The reviewed project remains `GestureScreen`, STM32F429IGTx; uvprojx SHA-256
is `32d523fa960ae727a05fdc9610c8ace2f6e8d1cd00a0417323a7cddb49aa2035`.
The actual recorded commands are retained in `plan.json`, sourced from
`MDK-ARM/Objects/GestureScreen_GestureScreen.dep` (SHA-256
`5045da88b9fc46e3da9c4f7cb48e237f1c97e491977b2dfb63ceb1eed0390f7f`)
and `GestureScreen.lnp` (SHA-256
`662b579e5371ff2aeadb70801cd672e4eb9147450f75278e22cff103503b5335`).
Do not derive only approximate flags from IDE display labels:

- All C commands use `--target=arm-arm-none-eabi -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard`, `-c`, `-funsigned-char -fshort-enums -fshort-wchar`, `-gdwarf-4`, `-O3`, `-ffunction-sections`, and the recorded warning options. The recorded command begins with `-std=c11` and later adds `-std=c99`; their order is retained.
- Preserve all include roots/order and definitions, including `USE_HAL_DRIVER`, `STM32F429xx`, `GS_STATIC_USE_CUBEAI=1`, `_RTE_` and `__UVISION_VERSION=543`. Those compatibility macros remain part of compilation even when no IDE runs.
- Startup uses the armclang driver with `-masm=auto` and legacy armasm forwarding, including the recorded `--pd` definitions and A1950W suppression. Switching to another assembler is a separate change.
- Actual RTE includes select installed `ARM/CMSIS/6.2.0` (CORE 6.1.1), plus the project-local CMSIS headers and RTE header. The uvprojx contains older RTE package metadata; actual command/header selection must be captured. Device support pack is `Keil.STM32F4xx_DFP.3.1.1`.
- Keep the exact object/library order in `.lnp`, `--cpu=Cortex-M4.fp.sp`, `--strict`, the same scatter file and Arm runtime library selection. The vendor input is `NetworkRuntime1201_CM4_Keil.lib`, SHA-256 `0c1dbf2686641e83b9720448497db843b2b79a4111574d5467a7453fc3f9d52a`.
- Linker scatter constraints remain Flash `0x08000000/0x100000`, SRAM `0x20000000/0x30000`, and CCM AI arena `0x10000000/0x10000 UNINIT`; SDRAM is runtime-initialized. Preserve startup memory semantics, not only total sizes.
- Link using `armlink --via Objects/GestureScreen.lnp`; convert using `fromelf --i32combined --output Objects/GestureScreen.hex Objects/GestureScreen.axf`, in the independent `source/MDK-ARM` working directory. The actual resolved command records and process exit values are saved.

## Reproduction

The script is a narrowly scoped experiment, not a general uvprojx-to-build-system
converter. It uses the current reviewed `.dep`/`.lnp` pair and the installed tool
paths. It does not execute IDE hooks, run UV4, flash, or touch the main service.
Preparation creates a new timestamped directory; execution refuses to reuse a
directory containing project object files.

```powershell
$py = 'C:\Users\ruyangge\.codex\mcp\serial\.venv\Scripts\python.exe'
$replay = 'E:\AiProject\agent-design\ForgeDesk-codex\output\hardware\compiler-equivalence\headless-replay.py'
& $py -B $replay prepare
# Inspect the newly created plan.json, then use its directory:
& $py -B $replay execute '<new prepared run directory>'
```

Run only against frozen inputs/reference outputs from the same build revision
and build ID. Review the emitted raw options and parsed argv before execution.
All generated files, compiler temp files and logs stay under
`output/hardware/compiler-equivalence`; original input hashes are checked after
the completed experiment. The current tool installation, libraries and pack
content remain dependencies of reproduction. Moving the compiler binaries to
another machine or changing its runtime libraries needs its own version/hash
and license check.

## Why GCC Is a Different Project

This source uses an ARMASM startup (`AREA`, `EXPORT`, `IMPORT __main` and Arm
runtime startup/heap hooks), an armlink scatter file, Arm library selection and
the vendor's Keil-named Cube.AI runtime. A GNU route needs the appropriate GNU
startup/linker script/runtime initialization, compatible approved AI runtime,
ABI/FPU flags, library/retarget support and corresponding memory/init checks.
The existing FreeRTOS `portable/GCC/ARM_CM4F` directory alone does not make the
entire firmware a GNU build.

Compiler code generation, runtime libraries, link placement and optimization
can change instructions, symbols, timing and size. A GNU migration should be
judged first by successful link, memory/vector/startup safety, protocol/host
tests, model/peripheral behavior and newly authorized physical validation.
It must use its own AXF/ELF layouts and evidence. No embedded GCC build, GNU AI
runtime qualification, functional equivalence or byte-identical GCC output was
tested here, so none is promised.

The current ForgeDesk production service still pins and invokes UV4 `-b`.
The successful direct-compiler replay proves an IDE-free build is feasible;
it does not silently change that service contract or complete an installed
headless-toolchain acceptance. Product adoption would require a reviewed fixed
CLI build profile, bound command/library/pack inputs, evidence/tests, and its own
installed workflow validation.
