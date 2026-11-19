//! The development host with `nsh/base` (all of `nsh/base`).

fn main() -> std::process::ExitCode {
    // Runs any app's JS: every part of `nsh/base` it may import.
    #[cfg(target_os = "linux")]
    nsh_platform_linux::set_ui_sets(vec![nsh_base::registry()]);
    nsh_linux_host::main()
}
