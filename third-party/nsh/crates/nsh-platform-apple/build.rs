//! Compiles `src/os_log.c` for Apple targets: `os_log_with_type` is a C
//! macro, which `unified_log.rs` calls through that function. Off Apple
//! platforms the crate is empty (Mac Catalyst's target OS is `ios`).

fn main() {
    println!("cargo:rerun-if-changed=src/os_log.c");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "macos" || os == "ios" {
        cc::Build::new()
            .file("src/os_log.c")
            // Mac Catalyst's flags carry the iOSSupport library path, which
            // compiling alone leaves unused.
            .flag("-Wno-unused-command-line-argument")
            .compile("nsh_platform_apple_os_log");
    }
}
