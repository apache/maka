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

    use crate::acl_ledger::readiness_mutex_name;
    use crate::protocol::{LaunchRequest, NetworkMode, RESERVED_READINESS_REQUEST_ID};
    use crate::windows_launcher::{
        appcontainer_profile_name, appcontainer_readiness_profile_name, environment_block,
        readiness_probe_command_line,
    };

    fn valid_launch_request(request_id: &str) -> LaunchRequest {
        LaunchRequest {
            version: 1,
            request_id: request_id.to_owned(),
            executable: "C:\\Windows\\System32\\cmd.exe".to_owned(),
            arguments: Vec::new(),
            cwd: "C:\\Windows\\System32".to_owned(),
            read_roots: Vec::new(),
            write_roots: Vec::new(),
            exact_read_roots: Vec::new(),
            exact_write_roots: Vec::new(),
            network: NetworkMode::Restricted,
            environment: BTreeMap::new(),
            timeout_ms: None,
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn block_strings(block: &[u16]) -> Vec<String> {
        block
            .split(|value| *value == 0)
            .filter(|chunk| !chunk.is_empty())
            .map(|chunk| String::from_utf16(chunk).expect("utf16 environment entry"))
            .collect()
    }

    #[test]
    fn builds_a_sorted_double_terminated_environment_block() {
        // Providing every substrate name keeps the block fully deterministic:
        // nothing is filled in from the test host's environment.
        let mut environment = BTreeMap::new();
        environment.insert("B".to_owned(), "2".to_owned());
        environment.insert("A".to_owned(), "1".to_owned());
        environment.insert("SystemRoot".to_owned(), "C:\\Windows".to_owned());
        environment.insert("SystemDrive".to_owned(), "C:".to_owned());
        environment.insert(
            "LOCALAPPDATA".to_owned(),
            "C:\\Users\\u\\AppData\\Local".to_owned(),
        );
        let mut expected = Vec::new();
        for entry in [
            "A=1",
            "B=2",
            "LOCALAPPDATA=C:\\Users\\u\\AppData\\Local",
            "SystemDrive=C:",
            "SystemRoot=C:\\Windows",
        ] {
            expected.extend(wide(entry));
            expected.push(0);
        }
        expected.push(0);
        assert_eq!(environment_block(&environment), expected);
    }

    #[test]
    fn empty_allowlist_fills_substrate_variables_but_stays_explicit() {
        // A null environment pointer would make CreateProcess inherit the
        // broker's ambient environment, bypassing the allowlist boundary.
        // AppContainer creation itself needs LOCALAPPDATA (else CreateProcessW
        // fails with os error 203), so those substrate paths are filled from
        // the broker; nothing else may leak in.
        let block = environment_block(&BTreeMap::new());
        let entries = block_strings(&block);
        assert!(
            entries
                .iter()
                .any(|entry| entry.to_ascii_uppercase().starts_with("LOCALAPPDATA=")),
            "expected LOCALAPPDATA in {entries:?}"
        );
        for entry in &entries {
            let name = entry.split('=').next().unwrap_or_default();
            assert!(
                ["SystemRoot", "SystemDrive", "LOCALAPPDATA"]
                    .iter()
                    .any(|substrate| substrate.eq_ignore_ascii_case(name)),
                "unexpected non-substrate entry {entry:?}"
            );
        }
        assert_eq!(&block[block.len() - 2..], &[0, 0]);
    }

    #[test]
    fn manifest_provided_substrate_values_win_case_insensitively() {
        let mut environment = BTreeMap::new();
        environment.insert("localappdata".to_owned(), "D:\\CustomLocal".to_owned());
        let entries = block_strings(&environment_block(&environment));
        assert!(entries.contains(&"localappdata=D:\\CustomLocal".to_owned()));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.to_ascii_uppercase().starts_with("LOCALAPPDATA="))
                .count(),
            1,
            "manifest value must not be duplicated by broker injection: {entries:?}"
        );
    }

    #[test]
    fn appcontainer_profile_identity_is_unique_and_bounded_per_request() {
        let first = appcontainer_profile_name("request-one");
        let second = appcontainer_profile_name("request-two");
        assert_ne!(first, second);
        let rendered = String::from_utf16(&first[..first.len() - 1]).expect("profile name");
        assert!(rendered.starts_with("maka.sandbox."));
        assert_eq!(rendered.len(), "maka.sandbox.".len() + 32);
    }

    #[test]
    fn readiness_profile_name_is_fixed_and_self_reconciling() {
        // The readiness profile uses one stable name so a profile leaked by an
        // externally-killed probe is reclaimed by the next probe rather than
        // accumulating under a unique per-invocation name.
        let first = appcontainer_readiness_profile_name();
        let second = appcontainer_readiness_profile_name();
        assert_eq!(first, second);
        let rendered = String::from_utf16(&first[..first.len() - 1]).expect("readiness name");
        assert!(rendered.starts_with("maka.readiness."));
        assert_eq!(rendered.len(), "maka.readiness.".len() + 32);
    }

    #[test]
    fn readiness_namespace_is_disjoint_from_production() {
        // Structural separation, not just a different hash input: the readiness
        // profile lives under `maka.readiness.` while every production profile
        // lives under `maka.sandbox.`, so the two lifecycles can never resolve to
        // the same registration even if `validate` were bypassed. Feeding the
        // reserved id through the production deriver must still land in the
        // production namespace, disjoint from the readiness one.
        let readiness = appcontainer_readiness_profile_name();
        let production_reserved = appcontainer_profile_name(RESERVED_READINESS_REQUEST_ID);
        assert_ne!(readiness, production_reserved);
        let readiness_str = String::from_utf16(&readiness[..readiness.len() - 1]).expect("name");
        let production_str =
            String::from_utf16(&production_reserved[..production_reserved.len() - 1])
                .expect("name");
        assert!(readiness_str.starts_with("maka.readiness."));
        assert!(production_str.starts_with("maka.sandbox."));
    }

    #[test]
    fn validate_rejects_reserved_readiness_request_id() {
        // A production launch may never carry the readiness identity: otherwise
        // it would resolve to a profile the readiness probe deletes and recreates.
        let reserved = valid_launch_request(RESERVED_READINESS_REQUEST_ID);
        let error = reserved
            .validate()
            .expect_err("reserved id must be rejected");
        assert!(
            error.contains(RESERVED_READINESS_REQUEST_ID) && error.contains("reserved"),
            "unexpected error: {error}"
        );
        // The same request with an ordinary id is otherwise valid, proving the id
        // is the sole reason for rejection.
        assert!(valid_launch_request("request-one").validate().is_ok());
    }

    #[test]
    fn readiness_lease_name_is_scoped_and_distinct() {
        // The readiness lease is a machine-wide (`Global\`) named mutex scoped by
        // the owning user's SID, and carries a distinct object name from the ACL
        // ledger mutex so the two never contend.
        let sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
        let name = readiness_mutex_name(sid);
        assert!(name.starts_with(r"Global\Maka.WindowsSandbox.ReadinessProfile."));
        assert!(name.ends_with(sid));
        assert!(!name.contains("AclLedger"));
    }

    #[test]
    fn readiness_command_line_disables_autorun_before_exit() {
        // `/d` must precede `/c` so cmd.exe skips the machine-constant
        // `Command Processor\AutoRun` value. Without it, a host whose AutoRun
        // exits non-zero (or blocks) would make the readiness probe fail closed
        // on every startup, disabling the sandbox regardless of the boundary.
        let line = readiness_probe_command_line("C:\\Windows\\System32\\cmd.exe");
        assert_eq!(line, "\"C:\\Windows\\System32\\cmd.exe\" /d /c exit 0");
        let d = line.find("/d").expect("/d present");
        let c = line.find("/c").expect("/c present");
        assert!(d < c, "/d must come before /c: {line}");
    }
}
