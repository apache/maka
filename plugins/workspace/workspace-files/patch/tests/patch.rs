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

use apply_patch::{PatchOperation, apply_update, parse_create, parse_patch, parse_update};

fn update(source: &str, diff: &str) -> String {
    apply_update(source, &parse_update(diff).unwrap()).unwrap()
}

#[test]
fn exact_context_and_multiple_chunks() {
    assert_eq!(
        update("a\nb\nc\nd\n", "@@\n a\n-b\n+B\n@@ c\n-d\n+D"),
        "a\nB\nc\nD\n"
    );
    assert_eq!(update("foo\nbar\n", " foo\n-bar\n+baz"), "foo\nbaz\n");
}

#[test]
fn fuzzy_matching_preserves_original_context() {
    assert_eq!(
        update(
            "  heading  \nvalue – old\n",
            "@@\n heading\n-value - old\n+new"
        ),
        "  heading  \nnew\n"
    );
    assert_eq!(update("value\t \n", "@@\n-value\n+new"), "new\n");
    assert_eq!(update("“quoted”\n", "@@\n-\"quoted\"\n+new"), "new\n");
}

#[test]
fn preserves_mixed_endings_and_terminates_last_line() {
    assert_eq!(update("a\r\nb\nc\r", "@@\n a\n-b\n+B\n c"), "a\r\nB\r\nc\r");
    assert_eq!(update("a\r\nb", "@@\n a\n-b\n+B"), "a\r\nB\r\n");
    assert_eq!(update("a", "@@\n a\n+b"), "a\nb\n");
    assert_eq!(update("", "@@\n+new"), "new\n");
}

#[test]
fn eof_targets_final_occurrence_and_rejects_backtracking() {
    assert_eq!(
        update("x\ny\nx\n", "@@\n-x\n+z\n*** End of File"),
        "x\ny\nz\n"
    );
    assert!(
        apply_update(
            "x\ny\n",
            &parse_update("@@\n-y\n+Y\n@@\n-x\n+X\n*** End of File").unwrap()
        )
        .is_err()
    );
    assert_eq!(update("a\nb\n", "@@\n-b\n+z\n "), "a\nz\n");
}

#[test]
fn additions_and_removals_do_not_shift_later_chunks() {
    assert_eq!(
        update("a\nb\nc\n", "@@\n+tail\n@@\n a\n-b\n-c\n+B"),
        "a\nB\ntail\n"
    );
    assert_eq!(update("a\n", "@@\n-a"), "");
}

#[test]
fn paths_are_data_and_operations_retain_source_order() {
    let operations = parse_patch("*** Begin Patch\n*** Add File: ../outside\n+hello\n*** Delete File: /absolute\n*** End Patch").unwrap();
    assert!(
        matches!(&operations[0], PatchOperation::Add{path, content} if path.to_str()==Some("../outside") && content=="hello\n")
    );
    assert!(
        matches!(&operations[1], PatchOperation::Delete{path} if path.to_str()==Some("/absolute"))
    );
    assert!(
        parse_patch("*** Begin Patch\n*** Delete File: x\n*** Delete File: ./x\n*** End Patch")
            .is_ok()
    );
    assert!(
        parse_patch("*** Begin Patch\n*** Delete File: x\n*** Add File: x\n+x\n*** End Patch")
            .is_ok()
    );
}

#[test]
fn malformed_move_empty_and_injected_operations_fail() {
    for patch in [
        "",
        "*** Begin Patch\n*** End Patch",
        "*** Begin Patch\n*** Add File: x\n*** End Patch",
        "*** Begin Patch\n*** Update File: x\n@@\n*** End Patch",
        "*** Begin Patch\n*** Add File: x\ntext\n*** End Patch",
        "*** Begin Patch\n*** Update File: x\n*** Move to: y\n@@\n+x\n*** End Patch",
        "*** Begin Patch\n*** Delete File: \n*** End Patch",
        "*** Begin Patch\n*** Delete File: x\0y\n*** End Patch",
        "*** Begin Patch\n*** Environment ID: remote\n*** Delete File: x\n*** End Patch",
    ] {
        assert!(parse_patch(patch).is_err(), "{patch:?}");
    }
    assert!(parse_update("@@\n+x\n*** Delete File: secret").is_err());
    assert!(parse_create("+x\n*** Delete File: secret").is_err());
}

#[test]
fn creates_and_crlf_envelopes() {
    assert_eq!(parse_create("+a\n+b").unwrap(), "a\nb");
    assert_eq!(parse_create("+a\n+b\n").unwrap(), "a\nb");
    assert_eq!(parse_create("+a\n+").unwrap(), "a\n");
    assert_eq!(parse_create("+").unwrap(), "");
    assert!(parse_create("+a\n\n").is_err());
    assert_eq!(parse_create("+a\r\n+b\r\n").unwrap(), "a\nb");
    assert_eq!(
        parse_patch("*** Begin Patch\r\n*** Add File: x\r\n+a\r\n*** End Patch\r\n").unwrap(),
        vec![PatchOperation::Add {
            path: "x".into(),
            content: "a\n".into()
        }]
    );
}
