#ifndef GS_USB_PROTOCOL_H
#define GS_USB_PROTOCOL_H
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#define GS_USB_HEADER_BYTES 48U
#define GS_USB_CONTROL_BYTES 24U
#define GS_USB_ID_QUERY_BYTES 24U
#define GS_USB_ID_RESPONSE_BYTES 100U
#define GS_USB_ID_NONCE_BYTES 16U
#define GS_USB_ID_BUILD_BYTES 32U
#define GS_USB_FRAME_BYTES 153600U
#define GS_USB_CRC32_INITIAL UINT32_MAX
typedef struct { uint32_t enabled, interval_ms, epoch, cookie; } gs_usb_control_t;
enum {
    GS_USB_ID_SDRAM_READY = 1U << 0,
    GS_USB_ID_CAMERA_READY = 1U << 1,
    GS_USB_ID_FLASH_MATCH = 1U << 2,
    GS_USB_ID_CONFIGURED = 1U << 3,
    GS_USB_ID_FAULT_FREE = 1U << 4
};
typedef struct {
    uint32_t uid[3], flags, camera_frames, camera_errors, camera_timeouts;
    uint32_t display_errors, sysclk_hz, pll48_hz, uptime_ms;
} gs_usb_identity_status_t;
uint32_t gs_usb_crc32_update(uint32_t state, const void *data, size_t bytes);
uint32_t gs_usb_crc32_finish(uint32_t state);
uint32_t gs_usb_crc32(const void *data, size_t bytes);
bool gs_usb_decode_control(const uint8_t *data, gs_usb_control_t *control);
bool gs_usb_decode_identity_query(const uint8_t *data,
                                  uint8_t nonce[GS_USB_ID_NONCE_BYTES]);
void gs_usb_identity_response(uint8_t *data,
                              const uint8_t nonce[GS_USB_ID_NONCE_BYTES],
                              const uint8_t build_id[GS_USB_ID_BUILD_BYTES],
                              const gs_usb_identity_status_t *status);
void gs_usb_frame_header(uint8_t *data, uint32_t frame_id, uint32_t capture_ms,
                         uint32_t epoch, uint32_t crc, const uint32_t uid[3]);
#endif
