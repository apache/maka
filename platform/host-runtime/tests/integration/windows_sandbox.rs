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

#![cfg(windows)]

use maka_host_runtime::sandbox::windows::{Installation, Status, WriteAccess, WriteRule};
use maka_sandbox::{
    Network,
    filesystem::{Access, Rule, Scope},
    windows::{WriteCapability, WriteToken},
};
use std::{
    io,
    os::windows::io::{AsHandle, AsRawHandle},
};
use windows_sys::Win32::Security::{ImpersonateLoggedOnUser, RevertToSelf};

#[test]
#[ignore = "requires administrator; creates and removes local sandbox accounts and WFP rules"]
fn interrupted_setup_and_removal_recover_without_replacing_accounts_or_live_leases() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_owned();
    let fixture = Cleanup(Installation::new(&root), Some(directory));
    assert_eq!(fixture.0.status().unwrap(), Status::NotConfigured);
    let setup = fixture.0.begin_setup().unwrap();
    assert_eq!(fixture.0.status().unwrap(), Status::Busy);
    let configured = setup.request().apply().unwrap();
    let expected = serde_json::to_value(&configured).unwrap();
    // The helper committed its OS effects but the Host lost the response.
    drop(setup);
    assert_eq!(fixture.0.status().unwrap(), Status::SetupRequired);
    let setup = fixture.0.begin_setup().unwrap();
    let recovered = setup.request().apply().unwrap();
    assert_eq!(serde_json::to_value(&recovered).unwrap(), expected);
    setup.finish(recovered).unwrap();
    assert_eq!(fixture.0.status().unwrap(), Status::Ready);

    // A private intent is writable by its owner, not a privileged attestation.
    // Replacing its owner must never authorize this user's elevation helper to
    // operate on another user's accounts or network namespace.
    let intent_path = root.join("windows-sandbox/installation.json");
    let original = std::fs::read(&intent_path).unwrap();
    let mut forged: serde_json::Value = serde_json::from_slice(&original).unwrap();
    forged["owner"] = "S-1-5-19".into();
    std::fs::write(&intent_path, serde_json::to_vec(&forged).unwrap()).unwrap();
    let setup_denied =
        matches!(fixture.0.begin_setup(), Err(e) if e.kind() == io::ErrorKind::PermissionDenied);
    let removal_denied =
        matches!(fixture.0.begin_removal(), Err(e) if e.kind() == io::ErrorKind::PermissionDenied);
    std::fs::write(&intent_path, original).unwrap();
    assert!(setup_denied && removal_denied);
    assert!(!root.join("windows-sandbox/removing").exists());

    // A deleted account must be repairable, including a lost reply after its
    // replacement was created but before the new SID snapshot reached disk.
    let account = {
        let execution = fixture.0.execution(Network::Denied, &[], &[]).unwrap();
        fixture.0.settle(execution.id).unwrap();
        execution.account
    };
    let previous_sid = account.sid().to_owned();
    account.remove().unwrap();
    assert_eq!(fixture.0.status().unwrap(), Status::SetupRequired);
    let setup = fixture.0.begin_setup().unwrap();
    let replacement = setup.request().apply().unwrap();
    let expected = serde_json::to_value(&replacement).unwrap();
    assert!(
        !expected["offlineSids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|sid| sid.as_str() == Some(previous_sid.as_str()))
    );
    drop(setup);
    let setup = fixture.0.begin_setup().unwrap();
    let recovered = setup.request().apply().unwrap();
    assert_eq!(serde_json::to_value(&recovered).unwrap(), expected);
    setup.finish(recovered).unwrap();
    assert_eq!(fixture.0.status().unwrap(), Status::Ready);

    verify_read_surface_isolation(&fixture.0, &root);
    verify_write_surface_reuse(&fixture.0, &root);

    let offline = fixture.0.execution(Network::Denied, &[], &[]).unwrap();
    let work = root.join("work");
    std::fs::create_dir(&work).unwrap();
    let online = fixture
        .0
        .execution(
            Network::Allowed,
            &[],
            &[WriteRule {
                path: work.clone(),
                scope: Scope::Subtree,
                access: WriteAccess::Allowed,
            }],
        )
        .unwrap();
    let token = WriteToken::current(&[WriteCapability::new(online.capability)]).unwrap();
    {
        let _identity = Impersonation::new(&token);
        std::fs::write(work.join("file"), "before recovery").unwrap();
    }
    let offline_intent = root.join(format!("windows-sandbox/execution-{}.json", offline.id));
    let online_intent = root.join(format!("windows-sandbox/execution-{}.json", online.id));
    assert!(offline_intent.is_file());
    assert!(online_intent.is_file());
    assert_ne!(offline.account.sid(), online.account.sid());
    assert!(offline.password.as_wide().len() > 32);
    assert!(matches!(fixture.0.begin_removal(), Err(e) if e.kind() == io::ErrorKind::WouldBlock));
    assert!(matches!(fixture.0.begin_setup(), Err(e) if e.kind() == io::ErrorKind::WouldBlock));
    // Normal settlement removes only this execution; a lost settlement reply
    // leaves the other identity for exclusive restart/removal recovery.
    fixture.0.settle(offline.id).unwrap();
    fixture.0.settle(offline.id).unwrap();
    assert!(!offline_intent.exists());
    assert!(online_intent.exists());
    drop((offline, online));

    // Reopening the installation after a lost execution settlement uses the
    // pinned object identity even when its name has since been replaced.
    let moved = root.join("moved");
    std::fs::rename(&work, &moved).unwrap();
    std::fs::create_dir(&work).unwrap();
    drop(fixture.0.begin_setup().unwrap());
    assert!(!online_intent.exists());
    {
        let _identity = Impersonation::new(&token);
        assert_eq!(
            std::fs::write(moved.join("file"), "escaped")
                .unwrap_err()
                .raw_os_error(),
            Some(5)
        );
    }
    assert_eq!(
        std::fs::read_to_string(moved.join("file")).unwrap(),
        "before recovery"
    );

    let removal = fixture.0.begin_removal().unwrap();
    assert!(fixture.0.execution(Network::Denied, &[], &[]).is_err());
    removal.request().unwrap().apply().unwrap();
    // The same lost-response boundary must also be safe during uninstall.
    drop(removal);
    assert_eq!(fixture.0.status().unwrap(), Status::Removing);
    let removal = fixture.0.begin_removal().unwrap();
    let receipt = removal.request().unwrap().apply().unwrap();
    removal.finish(Some(receipt)).unwrap();
    assert_eq!(fixture.0.status().unwrap(), Status::NotConfigured);
    assert!(!online_intent.exists());
    assert!(!root.join("windows-sandbox/installation.json").exists());
    assert!(!root.join("windows-sandbox/ready.json").exists());
    assert!(root.join("windows-sandbox/lifecycle.lock").is_file());

    // Cleanup after an already committed uninstall is also idempotent.
    let removal = fixture.0.begin_removal().unwrap();
    assert!(removal.request().is_none());
    removal.finish(None).unwrap();
}

fn verify_write_surface_reuse(installation: &Installation, root: &std::path::Path) {
    let work = root.join("cached-write");
    let protected = work.join("protected");
    std::fs::create_dir_all(&protected).unwrap();
    let rules = [
        WriteRule {
            path: work.clone(),
            scope: Scope::Subtree,
            access: WriteAccess::Preserve,
        },
        WriteRule {
            path: protected.clone(),
            scope: Scope::Subtree,
            access: WriteAccess::Denied,
        },
    ];
    let first = installation
        .execution(Network::Denied, &[], &rules)
        .unwrap();
    let peer = installation
        .execution(Network::Denied, &[], &rules)
        .unwrap();
    assert_eq!(first.capability, peer.capability);
    assert_eq!(first.account.sid(), peer.account.sid());
    assert_ne!(first.id, peer.id);
    let readonly = installation.execution(Network::Denied, &[], &[]).unwrap();
    assert_ne!(first.account.sid(), readonly.account.sid());
    assert_ne!(first.capability, readonly.capability);
    let capability = first.capability;
    let token = WriteToken::current(&[WriteCapability::new(capability)]).unwrap();
    for execution in [first, peer, readonly] {
        installation.settle(execution.id).unwrap();
        drop(execution);
    }
    // Recreated protected leaves must not force propagation over an unchanged
    // writable tree, or leave the replacement writable through the cached SID.
    std::fs::remove_dir(&protected).unwrap();
    std::fs::create_dir(&protected).unwrap();
    let refreshed = installation
        .execution(Network::Denied, &[], &rules)
        .unwrap();
    assert_eq!(refreshed.capability, capability);
    {
        let _identity = Impersonation::new(&token);
        std::fs::write(work.join("allowed"), "cached").unwrap();
        assert_eq!(
            std::fs::write(protected.join("denied"), "escape")
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    installation.settle(refreshed.id).unwrap();
    drop(refreshed);
    // Identical path strings are insufficient when a writable native object
    // changes. Retire the old SID and revoke its ACL on the moved directory.
    let moved = root.join("retired-write");
    std::fs::rename(&work, &moved).unwrap();
    std::fs::create_dir_all(&protected).unwrap();
    let replacement = installation
        .execution(Network::Denied, &[], &rules)
        .unwrap();
    assert_ne!(replacement.capability, capability);
    {
        let _identity = Impersonation::new(&token);
        assert_eq!(
            std::fs::write(moved.join("allowed"), "escape")
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            std::fs::write(work.join("allowed"), "escape")
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    installation.settle(replacement.id).unwrap();
    let replacement_token =
        WriteToken::current(&[WriteCapability::new(replacement.capability)]).unwrap();
    let name = format!("account-{}", replacement.account.name());
    drop(replacement);
    // A refresh can crash between retiring its old record and publishing the
    // new one. The refresh journal must be sufficient for exclusive recovery.
    let state = root.join("windows-sandbox");
    std::fs::remove_file(state.join(format!("{name}.ready"))).unwrap();
    std::fs::rename(
        state.join(format!("{name}.json")),
        state.join(format!("{name}.refresh")),
    )
    .unwrap();
    drop(installation.begin_setup().unwrap());
    let _identity = Impersonation::new(&replacement_token);
    assert_eq!(
        std::fs::write(work.join("allowed"), "escape")
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
}

struct Impersonation;
impl Impersonation {
    fn new(token: &impl AsHandle) -> Self {
        assert_ne!(
            unsafe { ImpersonateLoggedOnUser(token.as_handle().as_raw_handle()) },
            0
        );
        Self
    }
}

fn verify_read_surface_isolation(installation: &Installation, root: &std::path::Path) {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Security::{
        LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, LogonUserW,
    };
    let work = root.join("read-scopes");
    std::fs::create_dir(&work).unwrap();
    let scopes: Vec<_> = (0..9)
        .map(|index| {
            let path = work.join(index.to_string());
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("secret"), index.to_string()).unwrap();
            vec![
                Rule::subtree(&work, Access::Deny),
                Rule::subtree(path, Access::Read),
            ]
        })
        .collect();
    // Shared default reads must not bypass any account's explicit read surface.
    let configured: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("windows-sandbox/ready.json")).unwrap())
            .unwrap();
    let (_, shared_root) = maka_sandbox::windows::acl::Target::capture(&work).unwrap();
    maka_sandbox::windows::acl::set(
        &shared_root,
        configured["readGroupSid"].as_str().unwrap(),
        Scope::Subtree,
        Some(maka_sandbox::windows::acl::Permission::Read),
    )
    .unwrap();
    let executions: Vec<_> = scopes[..8]
        .iter()
        .map(|rules| installation.execution(Network::Denied, rules, &[]).unwrap())
        .collect();
    let peer = installation
        .execution(Network::Denied, &scopes[0], &[])
        .unwrap();
    assert_eq!(peer.account.sid(), executions[0].account.sid());
    assert!(
        matches!(installation.execution(Network::Denied, &scopes[8], &[]), Err(error) if error.kind() == io::ErrorKind::WouldBlock)
    );
    for (index, execution) in executions.iter().enumerate() {
        let name: Vec<_> = execution
            .account
            .name()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let domain = [b'.' as u16, 0];
        let mut token = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                LogonUserW(
                    name.as_ptr(),
                    domain.as_ptr(),
                    execution.password.as_wide().as_ptr(),
                    LOGON32_LOGON_INTERACTIVE,
                    LOGON32_PROVIDER_DEFAULT,
                    &mut token,
                )
            },
            0
        );
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let _identity = Impersonation::new(&token);
        assert_eq!(
            std::fs::read_to_string(work.join(index.to_string()).join("secret")).unwrap(),
            index.to_string()
        );
        assert_eq!(
            std::fs::read(work.join(((index + 1) % 8).to_string()).join("secret"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    drop(peer);
    drop(executions);
    let reused = installation
        .execution(Network::Denied, &scopes[8], &[])
        .unwrap();
    drop(reused);
    // Exclusive recovery revokes the cached account surface as well as writes.
    drop(installation.begin_setup().unwrap());
}
impl Drop for Impersonation {
    fn drop(&mut self) {
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

struct Cleanup(Installation, Option<tempfile::TempDir>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let result = (|| -> io::Result<()> {
            let removal = self.0.begin_removal()?;
            let receipt = removal
                .request()
                .map(|request| request.apply())
                .transpose()?;
            removal.finish(receipt)
        })();
        if let Err(error) = result {
            let path = self.1.take().expect("fixture owns its root").keep();
            eprintln!(
                "Windows sandbox cleanup failed: {error}; recovery intent retained at {}",
                path.display()
            );
        }
    }
}
