#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::windows_launcher::{appcontainer_profile_name, environment_block};

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
}
