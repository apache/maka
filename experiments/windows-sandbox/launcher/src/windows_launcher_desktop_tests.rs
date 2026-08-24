/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Coverage for the private-desktop *placement* (RFC §6.3): the security
//! descriptor handed to `CreateDesktopExW`, the child-side attestation that
//! rejects everything but the launcher-owned desktop, and a real-OS check that
//! the supported launch concurrency fits the bounded desktop-heap budget.
//! These attest initial `lpDesktop` placement plus the desktop security
//! descriptor, not escape-proof confinement (§6.5).

use std::ffi::c_void;
use std::ptr::null_mut;

use windows_sys::Win32::Security::FreeSid;
use windows_sys::Win32::Security::Isolation::DeriveAppContainerSidFromAppContainerName;

use crate::desktop_is_private_placement;
use crate::windows_launcher::{create_confined_desktop, desktop_sddl};

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
fn desktop_sddl_pins_a_low_integrity_no_write_up_label() {
    let sddl = desktop_sddl(OWNER_SID, APP_SID);
    // Without an explicit label the desktop inherits the creator's Medium
    // integrity, and MIC — evaluated before the DACL — would make the Low-IL
    // AppContainer child's granted create-window/write rights unusable.
    assert!(
        sddl.ends_with("S:(ML;;NW;;;LW)"),
        "desktop must carry a Low no-write-up mandatory label: {sddl}"
    );
}

#[test]
fn ten_confined_desktops_can_be_held_live() {
    // Real-OS budget check for `CONFINED_DESKTOP_HEAP_KB` (RFC §6.3): the
    // repository supports ten-way launch concurrency, so ten private desktops
    // must be able to exist *simultaneously* without exhausting the system
    // desktop heap. The default 3,072 KiB per-desktop allocation would put ten
    // live desktops at ~30 MiB of the documented 48 MiB limit; the bounded
    // 512 KiB budget keeps them at ~5 MiB. Children are not launched — the
    // desktops themselves own the heap allocation this bounds.
    let mut sid: *mut c_void = null_mut();
    let name: Vec<u16> = "maka-desktop-heap-test"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let derived =
        unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) } == 0;
    assert!(derived, "derive test AppContainer SID");
    let desktops: Vec<_> = (0..10)
        .map(|index| {
            unsafe { create_confined_desktop(sid) }
                .unwrap_or_else(|error| panic!("desktop {index} must fit the heap budget: {error}"))
        })
        .collect();
    assert_eq!(desktops.len(), 10);
    // Ten *distinct* objects, not ten handles to a reopened one:
    // `CreateDesktopExW` opens an existing desktop on a name collision (and
    // then silently ignores the supplied DACL and heap size), so the CSPRNG
    // nonce must have produced ten different names while all handles are held
    // live simultaneously.
    let names: std::collections::HashSet<String> = desktops
        .iter()
        .map(|desktop| desktop.name_string())
        .collect();
    assert_eq!(names.len(), 10, "desktop names must be unique: {names:?}");
    for name in &names {
        assert!(
            desktop_is_private_placement(name),
            "every created desktop must pass the placement attestation: {name}"
        );
    }
    // Drop order releases all ten handles; the kernel reclaims the desktops.
    drop(desktops);
    unsafe { FreeSid(sid) };
}
