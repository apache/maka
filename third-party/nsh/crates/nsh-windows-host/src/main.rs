//! The development host with `nsh/base` (all of `nsh/base`).

fn main() -> std::process::ExitCode {
    // Runs any app's JS: every part of `nsh/base` it may import.
    #[cfg(windows)]
    nsh_platform_windows::set_ui_sets(vec![nsh_base::registry()]);
    nsh_windows_host::main()
}
