# Third-Party Notices

This document records the GestureScreen source incorporated into ForgeDesk's
fixed-target firmware overlay. It supplements the original license texts;
it does not replace or relicense them. Other bundled components retain their
own notices in the application's packaged license directory.

## GestureScreen Firmware Overlay

- Upstream: [Geruyang/GestureScreen](https://github.com/Geruyang/GestureScreen).
- Reviewed source commit: `c8ae2c906b3d8845b5d5b757099a43332bd6b985`.
- Upstream license: MIT, `Copyright (c) 2026 Geruyang`.
- Full retained license: [GestureScreen-LICENSE.txt](third-party/GestureScreen-LICENSE.txt).
- Distributed source location: `engineering/templates/gesturescreen-v1/`.
- Notice reviewed/added: 2026-10-15.

The following existing upstream files are distributed in modified form:

| Relative path | ForgeDesk changes |
| --- | --- |
| `BSP/Src/gs_usb_capture.c` | Add a bounded FDQ1 request slot, FDR1 health/build-ID response, serialized CDC transmission and reset-generation checks while preserving GSCT/GSFR. |
| `Modules/UsbCapture/Inc/gs_usb_protocol.h` | Add fixed request/response sizes, flag values, identity status type and protocol interfaces. |
| `Modules/UsbCapture/Src/gs_usb_protocol.c` | Add FDQ1 magic/CRC validation and explicit little-endian FDR1 encoding. |

`App/Inc/forgedesk_build_id.h` is a new ForgeDesk integration file that defines
the default all-zero build-ID macro for trusted per-build replacement. It
does not change the upstream authorship of the three derived source files.
The upstream MIT copyright, permission notice and disclaimer are retained
in full alongside the overlay's distribution. Implementation/change details
are in [T2_FIRMWARE_IMPLEMENTATION.md](T2_FIRMWARE_IMPLEMENTATION.md).

The four overlay files were inspected for copyright, license, SPDX and
redistribution notices. None contains an additional per-file license or
third-party attribution declaration. The capture source includes external
HAL/USB/project headers, but this small overlay does not copy those libraries,
generated neural-network code, fonts or assets into its four files.

Upstream `THIRD_PARTY.md` explicitly excludes third-party components from its
root MIT grant. The complete GestureScreen project separately includes
STM32 HAL/CMSIS/FreeRTOS/lwIP/USB/Cube.AI components, an OFL font, and host-tool
dependencies under their own terms. This overlay notice is not a license
inventory for the complete project, compiled firmware, host tools or other
ForgeDesk dependencies. Any broader redistribution must retain the applicable
component notices and terms from that distribution scope.

## Packaging Handoff

The build pipeline should copy `docs/third-party/GestureScreen-LICENSE.txt`
unchanged into `dist/licenses/` so the MIT text accompanies the packaged
application and embedded overlay. This document records the source notice;
the release coordinator verifies the actual packaged copy and final resource
hashes. The license is deliberately outside the pinned firmware overlay:
no overlay file or `overlay-manifest.json` hash was changed for attribution.
