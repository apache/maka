#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use crate::acl_ledger::{LEDGER_VERSION, Ledger, LedgerRoot, recover_stale, write_ledger};

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

    fn ledger(roots: Vec<LedgerRoot>) -> Ledger {
        Ledger {
            version: LEDGER_VERSION,
            request_id: "test-request".to_owned(),
            app_container_sid: APP_SID.to_owned(),
            roots,
        }
    }

    #[test]
    fn recovers_old_format_ledger_without_backup_path() {
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

        recover_stale(&fixture.ledger_dir).expect("recover old-format ledger");

        assert!(!sid_listed(&fixture.target, APP_SID));
        assert!(!sid_listed(&fixture.target.join("child"), APP_SID));
        assert!(!ledger_path.exists());
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
            &ledger(vec![LedgerRoot {
                path: fixture.target_str(),
                recursive: true,
                backup_path: Some(backup.to_string_lossy().into_owned()),
            }]),
        )
        .expect("write ledger");

        recover_stale(&fixture.ledger_dir).expect("recover ledger with backup");

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
            &ledger(vec![LedgerRoot {
                path: missing.to_string_lossy().into_owned(),
                recursive: true,
                backup_path: None,
            }]),
        )
        .expect("write ledger");

        recover_stale(&fixture.ledger_dir).expect("recover ledger with missing root");

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
            &ledger(vec![LedgerRoot {
                path: fixture.target_str(),
                recursive: true,
                backup_path: None,
            }]),
        )
        .expect("write valid ledger");

        recover_stale(&fixture.ledger_dir).expect("recovery continues past corrupt ledger");

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

        recover_stale(&fixture.ledger_dir).expect("recovery quarantines future version");

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

        recover_stale(&fixture.ledger_dir).expect("recovery quarantines unknown fields");

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
                    recursive: true,
                    backup_path: None,
                }],
            },
        )
        .expect("write stuck ledger");

        recover_stale(&fixture.ledger_dir).expect("recovery continues past stuck ledger");

        assert!(!ledger_path.exists());
        assert!(fixture.ledger_path("stuck.json.quarantined").exists());
    }

    #[test]
    fn new_ledgers_serialize_without_backup_path() {
        let value = serde_json::to_value(ledger(vec![LedgerRoot {
            path: "C:\\workspace".to_owned(),
            recursive: true,
            backup_path: None,
        }]))
        .expect("serialize ledger");
        let root = &value["roots"][0];
        assert!(root.get("backupPath").is_none());
        assert_eq!(root["path"], "C:\\workspace");
        assert_eq!(root["recursive"], true);
    }
}
