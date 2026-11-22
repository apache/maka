//! The development host with `nsh/base` (all of `nsh/base`).

fn main() -> std::process::ExitCode {
    // Runs any app's JS: every part of `nsh/base` it may import.
    #[cfg(target_os = "macos")]
    nsh_platform_macos::set_ui_sets(vec![nsh_base::registry()]);
    nsh_macos_host::main()
}
