# Hardware Firmware Review

Date: 2026-10-15, Asia/Shanghai. Scope: offline firmware review and tests only. This reviewer did not enumerate or open hardware ports, connect a probe, reset, halt, write target memory, or flash firmware. Hardware ownership remains with the main controller.

## Source and Build

Repository: `output/hardware/2026-10-15/GestureScreen`, HEAD `c8ae2c906b3d8845b5d5b757099a43332bd6b985` (reported by the main controller). Initial clone checkout returned exit 1 because the 660 MB LFS demo video `demo/GestureScreen-demo-HQ.mp4` failed to download. The video is not a build dependency. No restore/reset was performed. All 121 explicit uvprojx file references and all 27 C include directories exist; their individual file hashes are recorded in `Build/artifact-audit.json`.

Applied skill: `C:/Users/ruyangge/.codex/skills/keil/SKILL.md`. No nested AGENTS.md was found in the firmware checkout. The only target is `GestureScreen`, device `STM32F429IGTx`, AC6 `6.24`, pack `Keil.STM32F4xx_DFP.3.1.1`. The matching pack is installed at `D:/STSoft/Keil5/ARM/PACK/Keil/STM32F4xx_DFP/3.1.1`.

Reviewed `Tools/build.ps1`: it invokes UV4 with `-b` or `-r`, target selection, and a log path, checks process exit and `0 Error(s)`, and uses a hidden window. There are no download/debug flags. The uvprojx has empty before-build hooks and an enabled but empty second after-build hook. The uvprojx also has `UpdateFlashBeforeDebugging=1`; opening a debug session can therefore flash and is outside this review.

Executed existing `Tools/build.ps1 -UV4 D:/STSoft/Keil5/UV4/UV4.exe`. Result: **0 errors, 0 warnings**, compiler-reported build time 16 seconds. Log: `output/hardware/2026-10-15/GestureScreen/Build/keil-build.log`. The checkout had no objects, so this incremental invocation compiled all translation units. No clean/rebuild/download was needed. All generated objects, logs, temporary files and test data stayed below `output/hardware`; TEMP/TMP were set to `GestureScreen/Build/audit-temp`, and Python bytecode generation was disabled.

Build dependencies are already present: Keil UV4 and licensed ARMCLANG/armasm/armlink 6.24, device pack 3.1.1, copied STM32F4 HAL/CMSIS, FreeRTOS with `portable/GCC/ARM_CM4F` and CMSIS-RTOS2, USB Device CDC, LwIP, generated Cube.AI network/model, and `Middlewares/ST/AI/Lib/NetworkRuntime1201_CM4_Keil.lib`. CubeMX and a separately installed CubeF4 SDK are not needed for this build; regeneration would need the matching SDK. No global software was installed.

## Frozen Artifacts

All hashes are SHA-256. Original `firmware` files were unchanged after the build.

| File | SHA-256 |
| --- | --- |
| `firmware/GestureScreen.hex` | `2a654ebc9243906abf8466266a79af1c5233e05d978654d0dcfa2ae3cbb9327f` |
| `firmware/GestureScreen.axf` | `bdc9ccc2e146f41243b00b66cd271dcfcfee46b42df33dae48a80693c1fc35bc` |
| `firmware/GestureScreen.map` | `ba54d856dfba7468f397ac83e3c7fc26ea3fc6032a2891fae99dbc2caf1c589a` |
| `MDK-ARM/Objects/GestureScreen.hex` | `2a654ebc9243906abf8466266a79af1c5233e05d978654d0dcfa2ae3cbb9327f` |
| `MDK-ARM/Objects/GestureScreen.axf` | `d95b2430772c4b90e018af4001f99128db476589eb974f9c8b53ab5e56cd5d19` |
| `MDK-ARM/Listings/GestureScreen.map` | `2b24659afeadaf668678331b277061d26ea29d63a56ee6656ab3027c58b6d00c` |
| `MDK-ARM/GestureScreen.uvprojx` | `32d523fa960ae727a05fdc9610c8ace2f6e8d1cd00a0417323a7cddb49aa2035` |
| `MDK-ARM/GestureScreen.sct` | `b6f5114372eb823fdc06c8f4511faf656db9bd2015805cae42e437b51e787b1e` |
| `Tools/build.ps1` | `3ad2c64f19c9036c8aec46efb7d1b6edf03219cd6cf17c6dda28e4666a28280c` |
| `NetworkRuntime1201_CM4_Keil.lib` | `0c1dbf2686641e83b9720448497db843b2b79a4111574d5467a7453fc3f9d52a` |

The delivered and locally built HEX files are byte-identical. A standard-library Intel HEX parser checked every record checksum, record length, EOF, address bounds, and duplicate address; there are 36,478 records, no repeated data addresses, and a contiguous 583,464-byte image. This image is byte-identical to the PT_LOAD file payload in both the original and rebuilt ELF32 ARM AXFs. All SHF_ALLOC section content/address/size/type values also match between AXFs. AXF/map file hashes differ, so those whole files must not be described as byte-identical; load contents and layout are identical. Detailed machine-readable evidence: `Build/artifact-audit.json`; original fromelf output: `Build/original-axf-info.txt`.

Compiler/tool binary hashes:

| Installed tool | SHA-256 |
| --- | --- |
| `D:/STSoft/Keil5/UV4/UV4.exe` | `428baf13d15e6760af1618def9c9815c97f0321cc5e459ec7adc4dde41c42f89` |
| `ARM/ARMCLANG/bin/armclang.exe` | `ad5afaace02844fad6631ebe77d5a995a72f79555ebfa52ce969e735a4d46f91` |
| `ARM/ARMCLANG/bin/armlink.exe` | `f63cf864edbf904e7db98647038ec8e75894a216c7fabc179277874ea6050f08` |
| `ARM/ARMCLANG/bin/armasm.exe` | `3b2c9a997453fbd5f88be730fe5eb553c1066982bbfe24bbe3436c02a4678895` |

## Memory Layout

Addresses below come from the original AXF/map, with the same values confirmed in the local build. Limits in this table are exclusive.

| Region | Start | End | Notes |
| --- | --- | --- | --- |
| Actual HEX / ELF flash payload | `0x08000000` | `0x0808E728` | 583,464 bytes |
| ER_IROM1 execution | `0x08000000` | `0x0808E0DC` | 581,852 bytes |
| RW_IRAM1 execution | `0x20000000` | `0x2001A9A8` | 108,968 bytes, max 192 KiB |
| RW_CCM_AI | `0x10000000` | `0x1000E500` | 58,624 bytes, UNINIT, CPU only |
| Reserved internal flash | `0x08000000` | `0x08100000` | 1 MiB configured |
| Reserved internal SRAM | `0x20000000` | `0x20030000` | 192 KiB |
| Reserved CCM | `0x10000000` | `0x10010000` | 64 KiB |
| Runtime SDRAM physical | `0xD0000000` | `0xD0800000` | 8 MiB, source configuration, not linker allocation |
| USB frame buffer 0 | `0xD0380000` | `0xD03A5800` | 153,600 bytes |
| USB frame buffer 1 | `0xD03A5800` | `0xD03CB000` | 153,600 bytes |

Initial stack pointer is `0x2001A9A8`, reset vector is `0x080002CD` (Thumb), ELF entry is `0x080001AD`. Total ROM size in linker summary is 583,460 bytes, and RW+ZI is 167,592 bytes; HEX has four additional alignment bytes. CCM is SHT_NOBITS/UNINIT, no PT_LOAD targets it, and the startup region table has no descriptor targeting CCM. SDRAM is explicitly initialized at runtime and is absent from startup ZI; no offline check proves actual SDRAM wiring or operation.

Original AXF symbols for main-controller read-only diagnostics:

| Symbol | Address | Size |
| --- | --- | --- |
| `g_gs_board_diag` | `0x20002CFC` | 80 |
| `g_gs_debug_diag` | `0x20002DA8` | 72 |
| `g_gs_timing_trace` | `0x20003070` | 3,252 |
| `g_gs_usb_diag` | `0x20003D24` | 64 |
| `g_gs_debug_action` | `0x20000008` | 4, do not write during read-only sampling |

These RAM addresses are usable only after confirming the running image matches this build. A matching MCU part number alone does not establish firmware identity.

## USB Identity and Sampling

`BSP/Inc/gs_capture_config.h` enables USB and disables Ethernet. The USB HS controller uses its embedded full-speed PHY, PB14/PB15. Source USB descriptors specify VID/PID `0483:5740`, product `GestureScreen USB Capture`, manufacturer `STMicroelectronics`; serial descriptor derives from chip UID. The host receiver explicitly rejects fireDAP `1fc9:5601`. The probe's virtual COM port is not the camera CDC stream; source documentation names board connector J38 USB MINI for capture.

There is no independent PING/identity-query/firmware-version command or dedicated cryptographic nonce echo. Existing 24-byte little-endian control packets are `GSCT`, enabled, interval_ms, epoch, cookie, CRC32 of the first 20 bytes. Intervals must be 200..5000 ms; controls expire after 1500 ms. The cookie is retained internally to exclude old slots but is not echoed in frames. A random 32-bit epoch can serve as a freshness challenge, but provides no cryptographic authentication.

Existing 48-byte `GSFR` version-1 headers carry fixed dimensions 320x240, RGB565 pixel-format 1, payload length 153,600, frame ID, capture time, echoed epoch, payload CRC32, and three HAL UID words. Thus unmodified firmware can sample and identify a board when its dedicated CDC connection and camera/SDRAM are working. A receiver should match the selected CDC endpoint, compare all 96 UID bits to the independently observed chip UID, require the current unpredictable epoch, validate the entire payload CRC, observe changing frame ID/timestamps, and then send disabled control. USB descriptors/CRC alone do not establish running firmware identity or freshness. This reviewer did not perform that physical sampling.

## Validation and Remaining Limits

| Check | Result | Evidence under firmware checkout |
| --- | --- | --- |
| Keil offline full first build | PASS, 0 errors, 0 warnings | `Build/keil-build.log` |
| HEX checksums, addresses, vectors, ELF load-byte equality | PASS | `Build/artifact-audit.json` |
| USB synthetic regression | PASS, 18 tests | `Build/usb-synthetic-test.log` |
| Trace decoding regression | PASS, 11 tests | `Build/timing-decode-tests.log` |
| `Tools/verify.py` source/configuration checks | PASS | `Build/source-verify.log` |
| Unmodified `Tools/verify.py --with-build` | FAIL: hardcoded `Objects/GestureScreen.map`; actual map is in `Listings` | `Build/source-with-build-verify.log` |
| Same build verifier with only a process-local Path.read_text redirection to actual map | PASS, all original assertions | `Build/source-with-build-map-adapted.log` |
| Native C host test `test_usb_firmware` | BLOCKED: no default MSVC vcvars64.bat; no MSVC install found in checked Program Files/STSoft locations | `Build/host-test-attempt.log` |
| Physical flash/readback, USB sampling, camera, LCD, timing | NOT PERFORMED by this reviewer | Main-controller responsibility |

Test scripts and their invoked helpers were reviewed before execution. USB tests use synthetic frames, injected mock serial factories and loopback HTTP only; the fireDAP test mocks enumeration and verifies it never opens a port. Trace tests use in-memory fixtures. Python was the already installed `C:/Users/ruyangge/.codex/mcp/serial/.venv/Scripts/python.exe`.

Provenance limitation: `firmware/manifest.json` matches all three delivered binary/map files, but most historical validation attachments and screenshots it references are absent. Of its 20 source entries, two match raw bytes, ten more match after CRLF-to-LF normalization, and eight still differ: `App/Src/gs_app.c`, `Modules/Gesture/Src/gs_gesture.c`, `Modules/Ui/Inc/gs_ui_render.h`, `Modules/Ui/Src/gs_ui_render.c`, `Tests/test_end_to_end.c`, `Tests/test_gesture_ui.c`, `Tools/test_host.ps1`, `Tools/verify.py`. Evidence: `Build/manifest-line-endings.json`. The manifest's historical claims are not treated as current verification. Current build reproduces the delivered HEX exactly despite those stale source entries.

Minimal next step: main controller may bind its hardware evidence to the original HEX/AXF hashes above, verify flash content and the independent chip UID, and attempt one bounded full-frame USB capture only if the board CDC endpoint is present. If only fireDAP is connected, board USB capture requires the separate board USB data cable. No firmware change is needed to get UID, epoch and pixel CRC evidence. Separately, repair the map-path lookup before making `--with-build` a direct automation gate; native C host execution requires an existing MSVC toolchain or an explicitly provisioned local alternative.

## Follow-Up: DWARF Diagnostic Layout

At the main controller's request, generated `output/hardware/2026-10-15/diagnostic-layout.json`, SHA-256 `805d84b34b040acabf2e45dd872b6516a8e637497e2d791fb4a2973b9730d8b8`. It binds the exact original AXF/HEX hashes and records all three symbols, 54 fields, unsigned base types, sizes, offsets, absolute addresses and original DWARF DIE offsets. The schema uses a `symbols` object keyed by symbol name; each value contains integer `address`, `address_hex`, `size`, `type`, and a `fields` array. Fields have `name`, `type`, `base_type`, `offset`, `size`, integer `address`, and `address_hex`. All fields are unsigned 32-bit little-endian words.

Addresses were extracted from `DW_TAG_variable` / `DW_AT_location` / `DW_OP_addr` in the original AXF, then independently cross-checked with its ELF symbol table. Structure/member DIEs provide the type references, aggregate sizes, member offsets and primitive type size/encoding; those values were additionally cross-checked against `fromelf --fieldoffsets`. No address or offset was guessed from C declaration order. Exports: `GestureScreen/Build/diagnostic-dwarf.txt` and `GestureScreen/Build/diagnostic-fieldoffsets.inc`. Reproducible standard-library generator: `output/hardware/2026-10-15/extract-diagnostic-layout.py`. No hardware access occurs in that generator.

Main-controller evidence reported back to this reviewer: full 583,464-byte target flash comparison matched the delivered HEX; chip ID `0x419`, flash 1024 KiB, independently read UID `0037001b3133510432383236`. The controller subsequently reported 35 valid USB frames in 10 seconds with matching UID, challenge epoch, CRC, and advancing frame/time counters, followed by a successful disabled control and closed port. These are controller-reported physical results, distinct from this reviewer's offline checks.

The JSON includes 16 conditional `health_assertions` and broader `observation_rules`. For six running-target samples one second apart:

- Assert boot clock snapshots SYSCLK/HCLK/PCLK1/PCLK2/PLL48 are 168/168/42/84/48 MHz, and `fault_kind == 0`; these are firmware snapshots, not live frequency measurements.
- `sdram_ready == 1` records successful startup SDRAM commands, two full-address 8 MiB test passes and final zero fill. It does not provide a continuous integrity check. `board_profile`, expected HSE and expected capacity are firmware configuration evidence.
- `flash_jedec == 0xEF4018` and `flash_profile_match == 1` establish the observed SPI identity matches W25Q128; they do not validate its stored data.
- With camera installed and application running, advancing `camera_frames` establishes completed frames reached the application. Require `camera_errors` and `camera_timeouts` unchanged across the window to report no newly observed acquisition failures.
- `display_frames` advances only after LTDC address/token confirmation; a static reader screen can legitimately produce no new display frames. `lcd_ready` is assigned as a path marker and does not prove a visible image. Require no new `display_errors` and `display_stalled == 0` to report no firmware-observed display fault.
- After the controller sends disabled control, `capture_enabled == 0` and no new USB sent frames are expected. `configured` can remain 1 while USB is still enumerated; 0 is also legitimate if disconnected. Busy/drop/reset counters are session/workload events.
- `watchdog_started` is assigned before watchdog initialization and is not a watchdog operation test. Fault registers/SP/IPSR/PRIMASK are fault-time snapshots and are not live SCB/core register values when `fault_kind == 0`.

The live structures have no snapshot guard. Individual aligned 32-bit words are suitable for observation, but multiword reads are not transactionally coherent. Interpret deltas only within one boot, using modulo-2^32 arithmetic; a reset invalidates comparisons. This reviewer still performed no physical read, attach, halt, reset or write.
