# T2 Firmware Implementation

Date: 2026-10-15. Scope: firmware protocol implementation, trusted build overlay, native host tests and Keil offline builds. This worker performed no probe/serial enumeration or connection, target memory access, reset, halt or flashing. Physical T2 remains with the main controller.

## Delivered Files

Four production files were changed/added under `output/hardware/2026-10-15/GestureScreen` and mirrored byte-for-byte into `engineering/templates/gesturescreen-v1`:

| Relative path | Purpose | SHA-256 |
| --- | --- | --- |
| `App/Inc/forgedesk_build_id.h` | Default all-zero build ID; trusted wrapper replaces the macro before compilation | `4745a11c91a4e094bd263af2a727dd5c716339334a918780ba64d947df86a14f` |
| `BSP/Src/gs_usb_capture.c` | Single-slot query queue and serialized response through the existing CDC TX owner | `49489071d8b4b6ad9e3d282bdb6415853f391698b6d18b6ae52785cd03a72048` |
| `Modules/UsbCapture/Inc/gs_usb_protocol.h` | Fixed sizes, flag values, status type and encode/decode interfaces | `3de485dfc775b464b875b88e3d0a3379fd1ca51d495eff618440a02719582b14` |
| `Modules/UsbCapture/Src/gs_usb_protocol.c` | FDQ1 CRC validation and explicit little-endian FDR1 encoding | `de3701cbf944822869ef28aee2286ad0a919fc331e86d84ffd559b0ea3401622` |

The overlay contains only those four production files plus `overlay-manifest.json`; it does not copy the entire project. Manifest SHA-256: `d69f4e175352d29669d262d92f3da77a3c877d3f0673681d685d4bc667cf04f7`. Format is `schema_version: 1`, `files: [{path, sha256, bytes}]`, plus `injection`, `protocol`, `scheduling`, and `project_constraints`. File hashes describe trusted overlay bytes before per-build ID injection. The final snapshot must separately hash the injected header. All four overlay files, manifest hashes/lengths, and checkout copies were verified equal.

No `.uvprojx` or scatter-file edits and no new production translation units are needed. The existing `../App/Inc` include path resolves `forgedesk_build_id.h`. The original `firmware/` delivery files remain unchanged. Existing project SHA-256 remains `32d523fa960ae727a05fdc9610c8ace2f6e8d1cd00a0417323a7cddb49aa2035`.

Test files: extended `Tests/test_usb_firmware.c`; added `Tests/usb_mocks/{stm32f4xx_hal.h,gs_memory_map.h,usb_device.h,usbd_cdc.h,usbd_cdc_if.h}`, `Tests/check_forgedesk_wire.py`, `Tests/check_forgedesk_axf.py`, and `Tools/test_forgedesk.ps1`. The mocks were absent from the source checkout despite the existing host script referencing them; the new mocks expose only the required hardware calls and host memory buffers.

## Frozen Wire Contract

The existing GSCT and GSFR formats are unchanged. New 24-byte request: ASCII `FDQ1` at 0, raw 16-byte nonce at 4, little-endian CRC32 at 20 over bytes `[0,20)`. CRC uses the existing IEEE/zlib polynomial and initialization/final XOR.

New response is exactly 100 bytes:

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `FDR1` |
| 4 | 16 | Raw request nonce |
| 20 | 32 | Compiled build ID bytes |
| 52 | 12 | HAL UID words 0, 1, 2, uint32 little-endian |
| 64 | 4 | Flags |
| 68 | 4 | Camera frames |
| 72 | 4 | Camera errors |
| 76 | 4 | Camera timeouts |
| 80 | 4 | Display errors |
| 84 | 4 | SYSCLK Hz |
| 88 | 4 | PLL48 Hz |
| 92 | 4 | Uptime milliseconds |
| 96 | 4 | CRC32 of bytes `[0,96)`, little-endian |

Flags: bit 0 SDRAM ready; bit 1 camera ready; bit 2 external flash profile match; bit 3 USB configured; bit 4 `fault_kind == 0`; remaining bits zero. Status reads use existing firmware diagnostics and HAL UID getters. These are individually sampled running values, not a transactionally coherent multiword diagnostic snapshot.

`gs_usb_decode_identity_query()` checks magic/CRC before copying nonce. `gs_usb_identity_response()` takes an explicit compiled build-ID pointer and status object; the request has no build-ID field. `gs_usb_capture.c` owns a `static const uint8_t forgedesk_build_id[32] = FORGEDESK_BUILD_ID_BYTES`. There is no request-to-build-ID copy. The trusted service writes 32 fresh random bytes into the header for each actual build; both checkout and overlay are left at the all-zero default. Verification must reject an all-zero build ID, including when the expected ID was incorrectly configured as zero. The independent test verifier exercises that failure condition.

## Queue and TX Ownership

The existing receive ring and 24-byte sliding parser recognize both control/query records, so fragmentation, coalescing, noise and bad CRC recover through the original bounded parser. One query slot holds its nonce; the slot remains occupied throughout an asynchronous reply transfer. Additional requests while occupied are consumed and dropped, without changing the saved nonce or TX buffer. The host retries after timeout; no unbounded queue is allocated.

Only the existing StorageTask sender calls `CDC_Transmit_HS`. A pending identity response waits until the active GSFR frame is complete, then takes priority before selecting the next READY frame. It can send even when capture is disabled or controls have expired. It never inserts FDR1 into an active GSFR payload. `tx_busy` blocks all staging-buffer writes; BUSY/FAIL retains the pending query for retry. CDC completion releases the buffer; a subsequent StorageTask step frees the query slot. A request arriving before that completion has been consumed may be dropped and must be retried.

The original explicit STOP/expiry/cookie behavior can abort an image frame. That behavior is preserved: if a frame is aborted, any already submitted CDC chunk still finishes unchanged before FDR1 is staged. Hosts must retain existing truncated-frame resynchronization. A normal query by itself never aborts a frame. While a frame is active, query latency can include its existing 3000 ms timeout; the host must permit an adequate retry/time budget.

USB link reset invalidates pending/in-flight query bookkeeping and discards pre-reset RX bytes along with existing frame cleanup. The disabled-interrupt submit section also compares connection generations, covering a reset occurring while response data is being prepared. An old-generation response cannot then be submitted to a newly configured connection. A test deliberately triggers reset from the UID mock during response preparation to check this boundary.

## Validation

Applied the Keil skill already read for this task. Used existing Keil UV4/ARMCLANG 6.24 and discovered existing native GCC 9.5.0 at `D:/vitis/2026.1/tps/mingw/10.0.0/win64.o/nt/bin/gcc.exe`. No software was installed. Generated files/cache/temp stayed under the hardware output tree; no physical ports were used.

- Actual production C sender was compiled and executed twice with `-std=c11 -Wall -Wextra -Werror -UNDEBUG`: default zero ID and command-line injected bytes `00..1F`. Both passed all existing GSCT/GSFR tests and new FDQ1/FDR1 tests.
- New coverage includes binary nonce/CRC and fixed offsets, flags/counters/clocks, disabled capture, fragmented/coalesced records, queue-full first-request retention, retry, TX buffer immutability, BUSY/FAIL, disconnected backpressure, header/body/CRC-slice arrival, intact complete-frame CRC, pending next frame, STOP during a queued response, reset of pending/in-flight/pre-reset RX, reset during response preparation, and malformed-stream resynchronization.
- Independent Python checks parse C-emitted bytes by the frozen specification, compare all 11 uint32 status values, reject the all-zero build, reject every single-byte mutation across all 100 response bytes, reject wrong nonce/build ID even with a recomputed valid CRC, and validate unchanged GSFR image CRCs.
- Both default and nonzero-header Keil builds passed with **0 errors, 0 warnings** on the final production implementation. After testing, the owned header was restored to zero and the default image rebuilt. ELF symbol/PT_LOAD parsing confirms the exact compiled 32 bytes at the `forgedesk_build_id` symbol in each image; the final test-symbol address is `0x0801DDBC`.
- Existing Python USB regression: 18 tests passed. Existing source/CubeMX/IRQ/Keil/memory-ownership verifier passed.

Reproduction entry point for native tests: `Tools/test_forgedesk.ps1 -CC <existing-native-gcc.exe> -Python <existing-python.exe>`. Logs and C-emitted binary fixtures are in `output/hardware/2026-10-15/GestureScreen/Build/forgedesk-tests/`, including `default-run.log`, `bound-run.log`, `wire-check.log`, `keil-default-build.log`, `keil-injected-build.log`, `compiled-build-id-check.json`, `legacy-usb-python.log` and `source-verify.log`.

Final Keil default test image: Code 109,580; RO data 473,656; RW data 4,572; ZI 163,044 bytes. Total ROM summary 584,844 bytes; RW+ZI 167,616 bytes. SRAM region size `0x1A9C0` remains below `0x30000`; CCM arena stays `0xE500` UNINIT. New image layouts differ from the baseline, so the earlier baseline diagnostic-layout JSON must not be reused against this T2 image without extracting its matching AXF.

## Artifact Boundaries

These are test artifacts only; the service must build its own random-ID snapshot before T2 flashing/verification:

| Artifact | SHA-256 |
| --- | --- |
| Default-zero `MDK-ARM/Objects/GestureScreen.hex` | `f6cab499efda17ed8e38444a6c00954997800b12cf035b6e126b066cd515a3fd` |
| Default-zero `MDK-ARM/Objects/GestureScreen.axf` | `7d16f7205c817242ce0eb8696ca4f275ecffe7f5d45a33b2e34841c253348fba` |
| Final `MDK-ARM/Listings/GestureScreen.map` | `c9d9f3c002eeb8901103bb1585952bc0bb0ef51fe4fa0cdb1d77f01f57d48d44` |
| Nonzero test `Build/forgedesk-tests/injected-test.hex` | `758e5330f3da6844f85cbe30ed38fbba633a02240b0268b18a447c04524a83ff` |
| Nonzero test `Build/forgedesk-tests/injected-test.axf` | `a9d139094bb04312ed781152d0e5d6ef39e0f5aabfbe0a44d6048f6c85faf910` |

Unchanged original delivery: HEX `2a654ebc9243906abf8466266a79af1c5233e05d978654d0dcfa2ae3cbb9327f`, AXF `bdc9ccc2e146f41243b00b66cd271dcfcfee46b42df33dae48a80693c1fc35bc`, map `ba54d856dfba7468f397ac83e3c7fc26ea3fc6032a2891fae99dbc2caf1c589a`.

Remaining physical validation belongs to the main controller: installed application authorization, trusted snapshot with fresh injected build ID, target download/readback, and fresh FDQ1 challenge verification against that exact build ID and expected chip UID. This worker does not claim those steps were executed for the new firmware.
