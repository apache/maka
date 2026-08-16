#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::windows_launcher::environment_block;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn builds_a_sorted_double_terminated_environment_block() {
        let mut environment = BTreeMap::new();
        environment.insert("B".to_owned(), "2".to_owned());
        environment.insert("A".to_owned(), "1".to_owned());
        let mut expected = wide("A=1");
        expected.push(0);
        expected.extend(wide("B=2"));
        expected.push(0);
        expected.push(0);
        assert_eq!(environment_block(&environment), expected);
    }

    #[test]
    fn empty_allowlist_still_produces_an_explicit_empty_block() {
        // A null environment pointer would make CreateProcess inherit the
        // broker's ambient environment, bypassing the allowlist boundary, so
        // an empty map must still yield a valid (empty) block: a lone empty
        // string terminator plus the block terminator.
        assert_eq!(environment_block(&BTreeMap::new()), vec![0, 0]);
    }
}
