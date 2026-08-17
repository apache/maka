//! Pure-function coverage for the private-desktop *placement* (RFC §6.3):
//! the DACL string handed to `CreateDesktopW` and the child-side attestation
//! that rejects the interactive desktop. These attest initial `lpDesktop`
//! placement plus the desktop DACL, not escape-proof confinement (§6.5). They
//! never touch the window station, so they run on any host.

use crate::windows_launcher::desktop_sddl;
use crate::{desktop_is_private_placement, json_string};

const APP_SID: &str =
    "S-1-15-2-1234567890-1234567890-1234567890-1234567890-1234567890-1234567890-1234567890";
const OWNER_SID: &str = "S-1-5-21-11111111-22222222-33333333-1001";

#[test]
fn desktop_dacl_grants_owner_and_system_full_control() {
    let sddl = desktop_sddl(OWNER_SID, APP_SID);
    // Protected DACL: no inherited ACEs bleed onto the private desktop.
    assert!(sddl.starts_with("D:P"), "DACL must be protected: {sddl}");
    assert!(
        sddl.contains(&format!("(A;;GA;;;{OWNER_SID})")),
        "owner keeps full control for cleanup: {sddl}"
    );
    assert!(
        sddl.contains("(A;;GA;;;SY)"),
        "Local System keeps full control: {sddl}"
    );
}

#[test]
fn desktop_dacl_denies_interactive_control_to_the_effective_user_sid() {
    let sddl = desktop_sddl(OWNER_SID, APP_SID);
    // The AppContainer child's token carries the launching-user SID as an
    // effective SID, so the owner GA allow would otherwise name the child as a
    // grantee of SWITCHDESKTOP(0x100) | HOOKCONTROL(0x8) | JOURNALRECORD(0x10)
    // | JOURNALPLAYBACK(0x20) = 0x138. A deny ACE strips those bits in the
    // DACL itself instead of relying on lowbox access-check intersection.
    let deny = sddl
        .find(&format!("(D;;0x138;;;{OWNER_SID})"))
        .expect("deny ACE for interactive-control rights must be present");
    // Deny ACEs must precede allow ACEs to be effective in canonical order.
    let first_allow = sddl.find("(A;;").expect("allow ACEs present");
    assert!(
        deny < first_allow,
        "deny ACE must precede every allow ACE: {sddl}"
    );
}

#[test]
fn desktop_dacl_grants_app_container_only_minimal_rights() {
    let sddl = desktop_sddl(OWNER_SID, APP_SID);
    // READOBJECTS(0x1) | CREATEWINDOW(0x2) | CREATEMENU(0x4) | ENUMERATE(0x40)
    // | WRITEOBJECTS(0x80) = 0xc7. Never SWITCHDESKTOP(0x100), HOOKCONTROL(0x8),
    // or JOURNAL*(0x10/0x20).
    assert!(
        sddl.contains(&format!("(A;;0xc7;;;{APP_SID})")),
        "AppContainer SID gets exactly the minimal non-interactive mask: {sddl}"
    );
    assert!(
        !sddl.contains(&format!("GA;;;{APP_SID}")),
        "AppContainer SID must never get generic-all on the desktop: {sddl}"
    );
}

#[test]
fn private_placement_requires_the_launcher_owned_desktop_prefix() {
    assert!(desktop_is_private_placement(
        "maka-sandbox-desktop.4321.1699999999999999999"
    ));
    // Desktop names are case-insensitive on Windows.
    assert!(desktop_is_private_placement("MAKA-SANDBOX-DESKTOP.1.2"));
    assert!(!desktop_is_private_placement("Default"));
    assert!(!desktop_is_private_placement("default"));
    assert!(!desktop_is_private_placement(""));
    // Not-Default is not enough: a child that lands on any other pre-existing
    // desktop was not placed on the launcher's per-launch private desktop.
    assert!(!desktop_is_private_placement("Winlogon"));
    assert!(!desktop_is_private_placement("Screen-saver"));
    // The bare prefix with no pid/nonce suffix is not a launcher-created name.
    assert!(!desktop_is_private_placement("maka-sandbox-desktop."));
}

#[test]
fn desktop_name_is_json_escaped() {
    assert_eq!(
        json_string("maka-sandbox-desktop.1.2"),
        "\"maka-sandbox-desktop.1.2\""
    );
    assert_eq!(json_string("a\"b\\c"), "\"a\\\"b\\\\c\"");
}
