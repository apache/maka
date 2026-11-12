// `os_log_with_type` for `unified_log.rs`. It is a macro that lays the format
// string and its metadata out at compile time (in the image's `__oslogstring`
// section), so Rust calls it through this function.
//
// The message is one of the app's own log lines: it is logged public, as the
// unified log would show a dynamic string as `<private>` otherwise.
//
// The name leaves out the `nsh_` prefix: the iOS SDK exports `_nsh_*`, its C
// ABI (`crates/xtask/src/ios.rs`), and this function is internal.

#include <os/log.h>
#include <stdint.h>

__attribute__((visibility("hidden"))) void platform_apple_os_log(os_log_t log, uint8_t type,
                                                                  const char *message) {
    os_log_with_type(log, (os_log_type_t)type, "%{public}s", message);
}
