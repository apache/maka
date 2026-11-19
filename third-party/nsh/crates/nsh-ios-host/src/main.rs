//! The development host with `nsh/base` (all of `nsh/base`).

fn main() {
    // Runs any app's JS: every part of `nsh/base` it may import.
    #[cfg(target_os = "ios")]
    nsh_platform_ios::set_ui_sets(vec![nsh_base::registry()]);
    nsh_ios_host::main();
}
