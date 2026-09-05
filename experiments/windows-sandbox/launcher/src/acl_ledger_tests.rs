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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use sha2::{Digest, Sha256};

    use crate::acl_ledger::{
        LEDGER_VERSION, LaunchFailure, Ledger, LedgerRoot, collect_roots, recover_stale,
        with_acl_grants, write_ledger,
    };
    use crate::protocol::{LaunchRequest, NetworkMode};

    // Synthetic AppContainer-shaped SIDs so the tests never touch the real
    // per-app profile. icacls accepts arbitrary `*SID` principals and renders
    // unresolvable SIDs verbatim in its output, which keeps assertions
    // locale-independent.
    const APP_SID: &str =
        "S-1-15-2-1111111111-1222222222-1333333333-1444444444-1555555555-1666666666-1777777777";
    const MARKER_SID: &str =
        "S-1-15-2-1777777777-1666666666-1555555555-1444444444-1333333333-1222222222-1111111111";

    struct Fixture {
        ledger_dir: PathBuf,
        target: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "maka-acl-ledger-tests-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&base);
            let ledger_dir = base.join("ledgers");
            let target = base.join("target");
            fs::create_dir_all(&ledger_dir).expect("create ledger dir");
            fs::create_dir_all(target.join("child")).expect("create target tree");
            fs::write(target.join("child").join("file.txt"), "payload").expect("seed file");
            Self { ledger_dir, target }
        }

        fn target_str(&self) -> String {
            self.target.to_string_lossy().into_owned()
        }

        fn ledger_path(&self, file_name: &str) -> PathBuf {
            self.ledger_dir.join(file_name)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(base) = self.ledger_dir.parent() {
                let _ = fs::remove_dir_all(base);
            }
        }
    }

    fn icacls(args: &[&str]) -> String {
        let output = Command::new("icacls.exe")
            .args(args)
            .output()
            .expect("run icacls");
        assert!(
            output.status.success(),
            "icacls {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn grant_recursive(path: &Path, sid: &str) {
        let grant = format!("*{sid}:(OI)(CI)RX");
        icacls(&[
            path.to_str().expect("path"),
            "/grant",
            &grant,
            "/L",
            "/Q",
            "/T",
        ]);
    }

    fn sid_listed(path: &Path, sid: &str) -> bool {
        icacls(&[path.to_str().expect("path")]).contains(sid)
    }

    fn user_sid() -> String {
        crate::windows_launcher::current_user_sid_string().expect("current user SID")
    }

    fn ledger(request_id: &str, roots: Vec<LedgerRoot>) -> Ledger {
        Ledger {
            version: LEDGER_VERSION,
            request_id: request_id.to_owned(),
            app_container_sid: APP_SID.to_owned(),
            roots,
        }
    }

    #[test]
    fn quarantines_legacy_stable_identity_ledgers_without_interpreting_them() {
        let fixture = Fixture::new("old-format");
        grant_recursive(&fixture.target, APP_SID);
        assert!(sid_listed(&fixture.target, APP_SID));
        let ledger_path = fixture.ledger_path("old.json");
        fs::write(
            &ledger_path,
            serde_json::json!({
                "version": 1,
                "requestId": "stale-old",
                "appContainerSid": APP_SID,
                "roots": [{ "path": fixture.target_str(), "recursive": true }],
            })
            .to_string(),
        )
        .expect("write old-format ledger");

        recover_stale(&fixture.ledger_dir, &user_sid()).expect("quarantine old-format ledger");

        assert!(sid_listed(&fixture.target, APP_SID));
        assert!(sid_listed(&fixture.target.join("child"), APP_SID));
        assert!(!ledger_path.exists());
        assert!(fixture.ledger_path("old.json.quarantined").exists());
    }

    #[test]
    fn recovery_preserves_unrelated_aces_and_drops_obsolete_backups() {
        let fixture = Fixture::new("preserve");
        grant_recursive(&fixture.target, MARKER_SID);
        grant_recursive(&fixture.target, APP_SID);
        let backup = fixture.ledger_path("obsolete.acl");
        fs::write(&backup, "obsolete backup contents").expect("seed backup");
        let ledger_path = fixture.ledger_path("with-backup.json");
        write_ledger(
            &ledger_path,
            &ledger(
                "preserve",
                vec![LedgerRoot {
                    path: fixture.target_str(),
                    read: true,
                    write: false,
                    read_recursive: true,
                    write_recursive: false,
                    backup_path: Some(backup.to_string_lossy().into_owned()),
                }],
            ),
        )
        .expect("write ledger");

        recover_stale(&fixture.ledger_dir, &user_sid()).expect("recover ledger with backup");

        assert!(!sid_listed(&fixture.target, APP_SID));
        assert!(sid_listed(&fixture.target, MARKER_SID));
        assert!(sid_listed(&fixture.target.join("child"), MARKER_SID));
        assert!(!backup.exists());
        assert!(!ledger_path.exists());
    }

    #[test]
    fn recovery_skips_missing_roots() {
        let fixture = Fixture::new("missing-root");
        let missing = fixture.target.join("does-not-exist");
        let ledger_path = fixture.ledger_path("missing-root.json");
        write_ledger(
            &ledger_path,
            &ledger(
                "missing-root",
                vec![LedgerRoot {
                    path: missing.to_string_lossy().into_owned(),
                    read: true,
                    write: false,
                    read_recursive: true,
                    write_recursive: false,
                    backup_path: None,
                }],
            ),
        )
        .expect("write ledger");

        recover_stale(&fixture.ledger_dir, &user_sid()).expect("recover ledger with missing root");

        assert!(!ledger_path.exists());
    }

    #[test]
    fn corrupt_ledger_is_quarantined_and_siblings_still_recover() {
        let fixture = Fixture::new("corrupt");
        grant_recursive(&fixture.target, APP_SID);
        let corrupt = fixture.ledger_path("corrupt.json");
        fs::write(&corrupt, "{ not json").expect("write corrupt ledger");
        let valid = fixture.ledger_path("valid.json");
        write_ledger(
            &valid,
            &ledger(
                "corrupt-valid",
                vec![LedgerRoot {
                    path: fixture.target_str(),
                    read: true,
                    write: false,
                    read_recursive: true,
                    write_recursive: false,
                    backup_path: None,
                }],
            ),
        )
        .expect("write valid ledger");

        recover_stale(&fixture.ledger_dir, &user_sid())
            .expect("recovery continues past corrupt ledger");

        assert!(!corrupt.exists());
        assert!(fixture.ledger_path("corrupt.json.quarantined").exists());
        assert!(!sid_listed(&fixture.target, APP_SID));
        assert!(!valid.exists());
    }

    #[test]
    fn unsupported_version_is_quarantined_without_acl_changes() {
        let fixture = Fixture::new("version");
        grant_recursive(&fixture.target, APP_SID);
        let ledger_path = fixture.ledger_path("future.json");
        fs::write(
            &ledger_path,
            serde_json::json!({
                "version": 99,
                "requestId": "future",
                "appContainerSid": APP_SID,
                "roots": [{ "path": fixture.target_str(), "recursive": true }],
            })
            .to_string(),
        )
        .expect("write future-version ledger");

        recover_stale(&fixture.ledger_dir, &user_sid())
            .expect("recovery quarantines future version");

        assert!(!ledger_path.exists());
        assert!(fixture.ledger_path("future.json.quarantined").exists());
        // An unknown version must not be interpreted: grants stay until a
        // build that understands the format recovers them.
        assert!(sid_listed(&fixture.target, APP_SID));
    }

    #[test]
    fn unknown_fields_are_rejected_and_quarantined() {
        let fixture = Fixture::new("unknown-field");
        let ledger_path = fixture.ledger_path("extra.json");
        fs::write(
            &ledger_path,
            serde_json::json!({
                "version": 1,
                "requestId": "extra",
                "appContainerSid": APP_SID,
                "surprise": true,
                "roots": [],
            })
            .to_string(),
        )
        .expect("write ledger with unknown field");

        recover_stale(&fixture.ledger_dir, &user_sid())
            .expect("recovery quarantines unknown fields");

        assert!(!ledger_path.exists());
        assert!(fixture.ledger_path("extra.json.quarantined").exists());
    }

    #[test]
    fn unrecoverable_ledger_is_quarantined_instead_of_blocking_recovery() {
        let fixture = Fixture::new("unrecoverable");
        let ledger_path = fixture.ledger_path("stuck.json");
        // An invalid SID makes icacls /remove fail exactly like a root whose
        // grants cannot be removed; recovery must quarantine and move on.
        write_ledger(
            &ledger_path,
            &Ledger {
                version: LEDGER_VERSION,
                request_id: "stuck".to_owned(),
                app_container_sid: "not-a-sid".to_owned(),
                roots: vec![LedgerRoot {
                    path: fixture.target_str(),
                    read: true,
                    write: false,
                    read_recursive: true,
                    write_recursive: false,
                    backup_path: None,
                }],
            },
        )
        .expect("write stuck ledger");

        recover_stale(&fixture.ledger_dir, &user_sid())
            .expect("recovery continues past stuck ledger");

        assert!(!ledger_path.exists());
        assert!(fixture.ledger_path("stuck.json.quarantined").exists());
    }

    fn launch_request(
        read_roots: Vec<String>,
        exact_read_roots: Vec<String>,
        write_roots: Vec<String>,
        exact_write_roots: Vec<String>,
    ) -> LaunchRequest {
        LaunchRequest {
            version: 1,
            request_id: "hard-link-admission".to_owned(),
            executable: "C:\\Windows\\System32\\cmd.exe".to_owned(),
            arguments: Vec::new(),
            cwd: "C:\\".to_owned(),
            read_roots,
            write_roots,
            exact_read_roots,
            exact_write_roots,
            network: NetworkMode::Restricted,
            environment: BTreeMap::new(),
            timeout_ms: None,
        }
    }

    #[test]
    fn multi_link_file_root_fails_closed() {
        let fixture = Fixture::new("hardlink-root");
        let original = fixture.target.join("child").join("file.txt");
        let alias = fixture.target.join("alias.txt");
        fs::hard_link(&original, &alias).expect("create hard link");
        let root = original.to_string_lossy().into_owned();
        let request = launch_request(vec![root.clone()], vec![root], Vec::new(), Vec::new());

        let error = collect_roots(&request).expect_err("multi-link file root must fail closed");

        assert!(error.contains("multi-link"), "unexpected error: {error}");
    }

    #[test]
    fn multi_link_file_inside_recursive_root_fails_closed() {
        let fixture = Fixture::new("hardlink-tree");
        // The alias inside the granted tree shares its file object with a
        // name outside it; an (OI)(CI) grant would follow that object out.
        let outside = fixture
            .target
            .parent()
            .expect("fixture base")
            .join("outside.txt");
        fs::write(&outside, "outside payload").expect("seed outside file");
        fs::hard_link(&outside, fixture.target.join("child").join("linked.txt"))
            .expect("create hard link into tree");
        let request = launch_request(
            vec![fixture.target_str()],
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );

        let error = collect_roots(&request).expect_err("multi-link file in tree must fail closed");

        assert!(error.contains("multi-link"), "unexpected error: {error}");
    }

    #[test]
    fn single_link_tree_admits_and_multi_link_below_exact_root_is_out_of_scope() {
        let fixture = Fixture::new("hardlink-exact");
        let roots = collect_roots(&launch_request(
            vec![fixture.target_str()],
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ))
        .expect("single-link tree admits");
        assert_eq!(roots.len(), 1);
        assert!(roots[0].read_recursive);

        // An exact grant mutates only the directory object itself; entries
        // below it receive no ACE, so aliases deeper in the tree stay out of
        // admission scope exactly like reparse points already do.
        let outside = fixture
            .target
            .parent()
            .expect("fixture base")
            .join("exact-outside.txt");
        fs::write(&outside, "outside payload").expect("seed outside file");
        fs::hard_link(&outside, fixture.target.join("child").join("linked.txt"))
            .expect("create hard link into tree");
        let roots = collect_roots(&launch_request(
            vec![fixture.target_str()],
            vec![fixture.target_str()],
            Vec::new(),
            Vec::new(),
        ))
        .expect("exact root skips tree scan");
        assert_eq!(roots.len(), 1);
        assert!(!roots[0].read_recursive);
    }

    fn shared_ledger_dir() -> PathBuf {
        std::env::temp_dir().join("maka-sandbox-acl-ledgers")
    }

    fn remove_recursive_grant(path: &Path, sid: &str) {
        let principal = format!("*{sid}");
        icacls(&[
            path.to_str().expect("path"),
            "/remove",
            &principal,
            "/L",
            "/Q",
            "/T",
        ]);
    }

    #[test]
    fn unsettled_launch_preserves_grants_and_quarantines_the_ledger() {
        let fixture = Fixture::new("unsettled-launch");
        let root = fixture.target_str();
        let mut request = launch_request(vec![root], Vec::new(), Vec::new(), Vec::new());
        request.request_id = format!("unsettled-injection-{}", std::process::id());
        let ledger_name = format!("{:x}.json", Sha256::digest(request.request_id.as_bytes()));
        let ledger_path = shared_ledger_dir().join(&ledger_name);
        let quarantined = shared_ledger_dir().join(format!("{ledger_name}.quarantined"));

        let result = with_acl_grants(&request, APP_SID, || -> Result<(), LaunchFailure> {
            assert!(
                sid_listed(&fixture.target, APP_SID),
                "grant must be live while the child runs"
            );
            Err(LaunchFailure::Unsettled(
                "injected settlement failure".to_owned(),
            ))
        });

        let message = match result {
            Err(LaunchFailure::Unsettled(message)) => message,
            other => panic!("expected an unsettled failure, got {other:?}"),
        };
        assert!(message.contains("injected settlement failure"), "{message}");
        assert!(message.contains("preserved"), "{message}");
        // Processes may still hold the launch identity: the grant must stay
        // and the ledger must survive as a quarantined recovery record.
        assert!(sid_listed(&fixture.target, APP_SID));
        assert!(!ledger_path.exists());
        assert!(quarantined.exists());

        let _ = fs::remove_file(&quarantined);
        remove_recursive_grant(&fixture.target, APP_SID);
    }

    #[test]
    fn settled_launch_failure_still_releases_grants_and_ledger() {
        let fixture = Fixture::new("settled-launch");
        let root = fixture.target_str();
        let mut request = launch_request(vec![root], Vec::new(), Vec::new(), Vec::new());
        request.request_id = format!("settled-injection-{}", std::process::id());
        let ledger_name = format!("{:x}.json", Sha256::digest(request.request_id.as_bytes()));

        let result = with_acl_grants(&request, APP_SID, || -> Result<(), LaunchFailure> {
            Err(LaunchFailure::Settled(
                "injected settled failure".to_owned(),
            ))
        });

        match result {
            Err(LaunchFailure::Settled(message)) => {
                assert!(message.contains("injected settled failure"), "{message}");
            }
            other => panic!("expected a settled failure, got {other:?}"),
        }
        // A proven-empty Job enters normal cleanup: no grant, no ledger.
        assert!(!sid_listed(&fixture.target, APP_SID));
        assert!(!shared_ledger_dir().join(&ledger_name).exists());
        assert!(
            !shared_ledger_dir()
                .join(format!("{ledger_name}.quarantined"))
                .exists()
        );
    }

    #[test]
    fn lock_names_are_machine_wide_and_scoped_to_the_owning_user() {
        // The ledger directory, icacls grants and AppContainer profiles are
        // shared across sessions; a `Local\` lock would let a concurrent
        // console/RDP session mistake a live lease for a stale one.
        let sid = user_sid();
        let mutex_name = crate::acl_ledger::acl_mutex_name(&sid);
        let lease_name = crate::acl_ledger::ledger_lease_name(&sid, "request");
        for name in [&mutex_name, &lease_name] {
            assert!(name.starts_with(r"Global\Maka.WindowsSandbox."), "{name}");
            assert!(name.contains(&sid), "{name}");
        }
        assert!(lease_name.contains(".AclLease."), "{lease_name}");
        // Distinct request ids must never share a lease object.
        assert_ne!(
            lease_name,
            crate::acl_ledger::ledger_lease_name(&sid, "request-2")
        );
    }

    #[test]
    fn new_ledgers_serialize_without_backup_path() {
        let value = serde_json::to_value(ledger(
            "serialization",
            vec![LedgerRoot {
                path: "C:\\workspace".to_owned(),
                read: true,
                write: true,
                read_recursive: false,
                write_recursive: true,
                backup_path: None,
            }],
        ))
        .expect("serialize ledger");
        let root = &value["roots"][0];
        assert!(root.get("backupPath").is_none());
        assert_eq!(root["path"], "C:\\workspace");
        assert_eq!(root["read"], true);
        assert_eq!(root["write"], true);
        assert_eq!(root["readRecursive"], false);
        assert_eq!(root["writeRecursive"], true);
    }

    #[test]
    fn lock_sddl_pins_an_elevation_independent_owner() {
        // Without an explicit `O:` clause the object owner comes from the
        // creating token's *default* owner — the user SID for a standard token
        // but BUILTIN\Administrators for an elevated one — so the same user's
        // elevated and non-elevated processes would create locks with different
        // owners and each reject the other's legitimate lock. Pinning the owner
        // keeps the lock identity stable across elevation states.
        let sid = "S-1-5-21-11111111-22222222-33333333-1001";
        let sddl = crate::acl_ledger::lock_sddl(sid).expect("lock SDDL");
        assert!(
            sddl.starts_with(&format!("O:{sid}D:P")),
            "owner must be pinned before the protected DACL: {sddl}"
        );
        assert!(
            sddl.contains("(A;;GA;;;SY)"),
            "SYSTEM retains access: {sddl}"
        );
        assert!(
            sddl.contains(&format!("(A;;GA;;;{sid})")),
            "the owning user retains access: {sddl}"
        );
    }
}
