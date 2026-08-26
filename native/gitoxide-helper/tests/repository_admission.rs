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

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const HELPER: &str = env!("CARGO_BIN_EXE_maka-gitoxide-helper");
const MAX_REPOSITORY_METADATA_BYTES: usize = 1024 * 1024;
const MAX_REPOSITORY_PACK_DIRECTORY_ENTRIES: usize = 1024;
static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn inspects_a_sha1_repository_without_invoking_system_git() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let expected_commit = fixture.git_output(["rev-parse", "HEAD"]);
    let expected_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

    let output = invoke_helper(&fixture.root);

    assert!(
        output.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "repository_inspected",
            "objectFormat": "sha1",
            "headCommitOid": expected_commit,
            "headTreeOid": expected_tree,
        })
    );
}

#[test]
fn inspects_and_imports_a_bounded_packed_sha1_repository() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fixture.git(["gc", "--quiet"]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let expected_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

    let inspection = invoke_helper(&fixture.root);
    assert!(
        inspection.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&inspection.stderr)
    );
    let inspected: serde_json::Value = serde_json::from_slice(&inspection.stdout).unwrap();
    assert_eq!(inspected["headTreeOid"], expected_tree);

    let destination = fixture.root.join("packed-source-destination.git");
    let import = invoke_import(&fixture.root, &source_head, &destination);
    assert!(
        import.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&import.stderr)
    );
    let imported: serde_json::Value = serde_json::from_slice(&import.stdout).unwrap();
    assert_eq!(imported["baselineTreeOid"], expected_tree);
}

#[test]
fn rejects_oversized_repository_metadata_before_opening_or_importing() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("oversized-metadata.git");
    let config_path = fixture.root.join(".git").join("config");
    let mut config = fs::OpenOptions::new()
        .append(true)
        .open(config_path)
        .unwrap();
    config.write_all(b"\n#").unwrap();
    config
        .write_all(&vec![b'x'; MAX_REPOSITORY_METADATA_BYTES])
        .unwrap();
    drop(config);

    let inspection = invoke_helper(&fixture.root);
    assert_helper_error(&inspection, "repository_metadata_limit_exceeded");

    let import = invoke_import(&fixture.root, &source_head, &destination);
    assert_helper_error(&import, "repository_metadata_limit_exceeded");
    assert!(!destination.exists());
}

#[test]
fn rejects_nested_alternate_object_databases_before_opening_or_importing() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let first_alternate = fixture.root.join("alternate-one");
    let second_alternate = fixture.root.join("alternate-two");
    for alternate in [&first_alternate, &second_alternate] {
        fs::create_dir_all(alternate.join("info")).unwrap();
        fs::create_dir_all(alternate.join("pack")).unwrap();
    }
    fs::write(
        first_alternate.join("info/alternates"),
        format!("{}\n", second_alternate.display()),
    )
    .unwrap();
    fs::write(
        fixture.root.join(".git/objects/info/alternates"),
        format!("{}\n", first_alternate.display()),
    )
    .unwrap();

    let inspection = invoke_helper(&fixture.root);
    assert_helper_error(&inspection, "repository_alternates_unsupported");

    let destination = fixture.root.join("alternates-destination.git");
    let import = invoke_import(&fixture.root, &source_head, &destination);
    assert_helper_error(&import, "repository_alternates_unsupported");
    assert!(!destination.exists());
}

#[test]
fn rejects_excessive_primary_pack_directory_entries_before_opening_or_importing() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let pack_directory = fixture.root.join(".git/objects/pack");
    for index in 0..=MAX_REPOSITORY_PACK_DIRECTORY_ENTRIES {
        fs::write(
            pack_directory.join(format!("untrusted-{index:04}.entry")),
            b"",
        )
        .unwrap();
    }

    let inspection = invoke_helper(&fixture.root);
    assert_helper_error(&inspection, "repository_metadata_limit_exceeded");

    let destination = fixture.root.join("pack-entries-destination.git");
    let import = invoke_import(&fixture.root, &source_head, &destination);
    assert_helper_error(&import, "repository_metadata_limit_exceeded");
    assert!(!destination.exists());
}

#[test]
fn rejects_oversized_bare_repository_metadata_when_an_invalid_dot_git_child_exists() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let bare_repository = fixture.root.join("source.git");
    let clone = Command::new("git")
        .args(["clone", "--quiet", "--bare"])
        .arg(&fixture.root)
        .arg(&bare_repository)
        .output()
        .unwrap();
    assert!(
        clone.status.success(),
        "bare fixture clone failed: {}",
        String::from_utf8_lossy(&clone.stderr)
    );
    fs::create_dir(bare_repository.join(".git")).unwrap();
    let mut config = fs::OpenOptions::new()
        .append(true)
        .open(bare_repository.join("config"))
        .unwrap();
    config.write_all(b"\n#").unwrap();
    config
        .write_all(&vec![b'x'; MAX_REPOSITORY_METADATA_BYTES])
        .unwrap();
    drop(config);

    let inspection = invoke_helper(&bare_repository);

    assert_helper_error(&inspection, "repository_metadata_limit_exceeded");
}

#[test]
fn does_not_count_worktree_user_data_as_bare_repository_metadata() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let user_refs = fixture.root.join("refs");
    fs::create_dir(&user_refs).unwrap();
    fs::write(
        user_refs.join("application-data.txt"),
        vec![b'x'; MAX_REPOSITORY_METADATA_BYTES + 1],
    )
    .unwrap();

    let inspection = invoke_helper(&fixture.root);

    assert!(
        inspection.status.success(),
        "helper failed: stdout={} stderr={}",
        String::from_utf8_lossy(&inspection.stdout),
        String::from_utf8_lossy(&inspection.stderr)
    );
}

#[test]
fn rejects_sha256_before_returning_repository_identity() {
    let fixture = RepositoryFixture::sha256_unborn();

    let output = invoke_helper(&fixture.root);

    assert_eq!(output.status.code(), Some(2));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "repository_rejected",
            "reason": "unsupported_object_format",
            "objectFormat": "sha256",
            "supportedObjectFormats": ["sha1"],
        })
    );
}

#[test]
fn rejects_an_unknown_object_format_during_repository_open() {
    let fixture = RepositoryFixture::unknown_object_format();

    let output = invoke_helper(&fixture.root);

    assert_eq!(output.status.code(), Some(2));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        serde_json::json!({
            "protocolVersion": 1,
            "kind": "repository_rejected",
            "reason": "unsupported_object_format",
            "objectFormat": "unknown",
            "supportedObjectFormats": ["sha1"],
        })
    );
}

#[test]
fn observes_raw_head_identity_instead_of_replacement_ref_semantics() {
    let (fixture, expected_commit, expected_tree) = RepositoryFixture::sha1_with_replacement_ref();

    let output = invoke_helper(&fixture.root);

    assert!(output.status.success());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["headCommitOid"], expected_commit);
    assert_eq!(response["headTreeOid"], expected_tree);
}

#[test]
fn rejects_a_head_commit_whose_storage_key_does_not_match_its_bytes() {
    let (fixture, claimed_head) = RepositoryFixture::sha1_with_mismatched_head_storage();

    let inspection = invoke_helper(&fixture.root);

    assert_helper_error(&inspection, "head_commit_identity_mismatch");

    let destination = fixture.root.join("mismatched-head.git");
    let import = invoke_import(&fixture.root, &claimed_head, &destination);

    assert_helper_error(&import, "source_head_commit_identity_mismatch");
    assert!(!destination.exists());
}

#[test]
fn rejects_a_source_tree_whose_storage_key_does_not_match_its_bytes() {
    let (fixture, claimed_head) = RepositoryFixture::sha1_with_mismatched_tree_storage();
    let destination = fixture.root.join("mismatched-tree.git");

    let import = invoke_import(&fixture.root, &claimed_head, &destination);

    assert_helper_error(&import, "source_tree_identity_mismatch");
    assert!(!destination.exists());
}

#[test]
fn rejects_a_source_blob_whose_storage_key_does_not_match_its_bytes() {
    let (fixture, claimed_head) = RepositoryFixture::sha1_with_mismatched_blob_storage();
    let destination = fixture.root.join("mismatched-blob.git");

    let import = invoke_import(&fixture.root, &claimed_head, &destination);

    assert_helper_error(&import, "source_blob_identity_mismatch");
    assert!(!destination.exists());
}

#[test]
fn rejects_noncanonical_tree_entry_modes_before_claiming_the_destination() {
    for mode in ["100600", "100664", "100700", "100777", "040000", "0100644"] {
        let (fixture, source_head) = RepositoryFixture::sha1_with_raw_tree(&[RawTreeEntry {
            mode,
            name: "entry",
            object_kind: if mode.ends_with("40000") {
                RawObjectKind::Tree
            } else {
                RawObjectKind::Blob
            },
        }]);
        let destination = fixture.root.join(format!("noncanonical-{mode}.git"));

        let import = invoke_import(&fixture.root, &source_head, &destination);

        assert_helper_error(&import, "source_tree_noncanonical_mode");
        assert!(!destination.exists());
    }
}

#[test]
fn rejects_unsorted_tree_entries_before_claiming_the_destination() {
    let (fixture, source_head) = RepositoryFixture::sha1_with_raw_tree(&[
        RawTreeEntry {
            mode: "100644",
            name: "z-last",
            object_kind: RawObjectKind::Blob,
        },
        RawTreeEntry {
            mode: "100644",
            name: "a-first",
            object_kind: RawObjectKind::Blob,
        },
    ]);
    let destination = fixture.root.join("unsorted-tree.git");

    let import = invoke_import(&fixture.root, &source_head, &destination);

    assert_helper_error(&import, "source_tree_not_sorted");
    assert!(!destination.exists());
}

#[test]
fn rejects_full_unicode_casefold_collisions_before_claiming_the_destination() {
    let (fixture, source_head) = RepositoryFixture::sha1_with_raw_tree(&[
        RawTreeEntry {
            mode: "100644",
            name: "STRASSE.txt",
            object_kind: RawObjectKind::Blob,
        },
        RawTreeEntry {
            mode: "100644",
            name: "Straße.txt",
            object_kind: RawObjectKind::Blob,
        },
    ]);
    let destination = fixture.root.join("unicode-casefold-collision.git");

    let import = invoke_import(&fixture.root, &source_head, &destination);

    assert_helper_error(&import, "source_path_collision");
    assert!(!destination.exists());
}

#[test]
fn rejects_protected_names_using_the_policy_v2_unicode_fold() {
    let (fixture, source_head) = RepositoryFixture::sha1_with_raw_tree(&[RawTreeEntry {
        mode: "100644",
        name: ".gitattributeſ",
        object_kind: RawObjectKind::Blob,
    }]);
    let destination = fixture.root.join("unicode-protected-name.git");

    let import = invoke_import(&fixture.root, &source_head, &destination);

    assert_helper_error(&import, "unsupported_source_path");
    assert!(!destination.exists());
}

#[test]
fn rejects_a_nonportable_raw_git_path_before_claiming_the_destination() {
    let (fixture, source_head) = RepositoryFixture::sha1_with_raw_tree(&[RawTreeEntry {
        mode: "100644",
        name: "com¹.txt",
        object_kind: RawObjectKind::Blob,
    }]);
    let destination = fixture.root.join("nonportable-path.git");

    let import = invoke_import(&fixture.root, &source_head, &destination);

    assert_helper_error(&import, "unsupported_source_path");
    assert!(!destination.exists());
}

#[test]
fn imports_an_exact_source_head_into_a_fresh_managed_repository() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::create_dir_all(fixture.root.join("docs")).unwrap();
    fs::write(fixture.root.join("docs/guide.txt"), b"nested guide\n").unwrap();
    fixture.git(["add", "docs/guide.txt"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "source import fixture",
    ]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let source_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);
    let destination = fixture.root.join("managed.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert!(
        output.status.success(),
        "helper failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "source_imported");
    assert_eq!(response["sourceHeadCommitOid"], source_head);
    assert_eq!(response["sourceTreeOid"], source_tree);
    assert_eq!(response["baselineTreeOid"], source_tree);
    assert_eq!(response["managedTreePolicyVersion"], 2);
    assert_eq!(response["filesImported"], 2);
    assert_eq!(response["bytesImported"], 29);
    let baseline_commit = response["baselineCommitOid"].as_str().unwrap();
    assert_ne!(baseline_commit, source_head);
    assert_eq!(
        git_bare_output(&destination, ["rev-parse", "refs/maka/baseline"]),
        baseline_commit
    );
    assert_eq!(
        git_bare_output(
            &destination,
            ["rev-parse", &format!("{baseline_commit}^{{tree}}")]
        ),
        source_tree
    );
    assert!(!git_bare_succeeds(
        &destination,
        ["cat-file", "-e", source_head.as_str()]
    ));
    assert!(!destination.join("objects/info/alternates").exists());

    let second_destination = fixture.root.join("managed-second.git");
    let second_output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": second_destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));
    assert!(
        second_output.status.success(),
        "second helper import failed: stdout={} stderr={}",
        String::from_utf8_lossy(&second_output.stdout),
        String::from_utf8_lossy(&second_output.stderr)
    );
    let second_response: serde_json::Value = serde_json::from_slice(&second_output.stdout).unwrap();
    assert_eq!(second_response["baselineCommitOid"], baseline_commit);
    let baseline_commit_text = git_bare_output(&destination, ["cat-file", "-p", baseline_commit]);
    assert_eq!(
        baseline_commit_text
            .lines()
            .filter(|line| line.starts_with("parent "))
            .count(),
        0
    );
    assert!(
        baseline_commit_text
            .contains("author Maka Workspace Service <workspace@maka.invalid> 946684800 +0000")
    );
    assert!(
        baseline_commit_text
            .contains("committer Maka Workspace Service <workspace@maka.invalid> 946684800 +0000")
    );
    assert!(baseline_commit_text.ends_with("maka managed workspace baseline v2"));

    let retry = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));
    assert_helper_error(&retry, "import_destination_not_fresh");
}

#[test]
fn imports_maka_attributes_under_managed_tree_policy_v2() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::write(
        fixture.root.join(".gitattributes"),
        b"* text=auto eol=lf\n/.claude export-ignore\n/.maka-shots export-ignore\n/maka-proposal-zh-review.txt export-ignore\n",
    )
    .unwrap();
    fixture.git(["add", ".gitattributes"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "attributes fixture",
    ]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let source_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);
    let destination = fixture.root.join("managed-attributes-v2.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert!(
        output.status.success(),
        "helper failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "source_imported");
    assert_eq!(response["sourceTreeOid"], source_tree);
    assert_eq!(response["baselineTreeOid"], source_tree);
    assert_eq!(response["managedTreePolicyVersion"], 2);
}

#[test]
fn rejects_external_filter_attributes_before_claiming_the_destination() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::write(fixture.root.join(".gitattributes"), b"*.bin filter=lfs\n").unwrap();
    fixture.git(["add", ".gitattributes"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "unsupported attributes fixture",
    ]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("unsupported-attributes.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "unsupported_source_attributes");
    assert!(!destination.exists());
}

#[test]
fn rejects_bracket_glob_attributes_before_claiming_the_destination() {
    assert_attributes_import_rejected(
        b"/[ab].txt export-ignore\n/file[0-9].txt export-ignore\n",
        "bracket-glob-attributes.git",
    );
}

#[test]
fn rejects_non_git_blank_characters_before_claiming_the_destination() {
    for (attributes, destination_name) in [
        (
            "\u{00a0}* text=auto eol=lf\n".as_bytes(),
            "nbsp-attributes.git",
        ),
        (b"\x0b* text=auto eol=lf\n".as_slice(), "vt-attributes.git"),
        (b"\x0c* text=auto eol=lf\n".as_slice(), "ff-attributes.git"),
    ] {
        assert_attributes_import_rejected(attributes, destination_name);
    }
}

#[test]
fn rejects_a_git_ignored_2048_byte_attribute_line_before_claiming_the_destination() {
    let attributes = format!("/{} export-ignore", "a".repeat(2033));
    assert_eq!(attributes.len(), 2048);
    assert_attributes_import_rejected(attributes.as_bytes(), "overlong-attribute-line.git");
}

#[test]
fn rejects_oversized_attributes_before_claiming_the_destination() {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::write(
        fixture.root.join(".gitattributes"),
        vec![b'#'; 64 * 1024 + 1],
    )
    .unwrap();
    fixture.git(["add", ".gitattributes"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "oversized attributes fixture",
    ]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("oversized-attributes.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "source_attributes_limit_exceeded");
    assert!(!destination.exists());
}

fn assert_attributes_import_rejected(attributes: &[u8], destination_name: &str) {
    let fixture = RepositoryFixture::sha1_with_commit();
    fs::write(fixture.root.join(".gitattributes"), attributes).unwrap();
    fixture.git(["add", ".gitattributes"]);
    fixture.git([
        "-c",
        "user.name=Maka Test",
        "-c",
        "user.email=maka@example.invalid",
        "commit",
        "-m",
        "unsupported attributes grammar fixture",
    ]);
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join(destination_name);

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "unsupported_source_attributes");
    assert!(!destination.exists());
}

#[test]
fn rejects_a_foreign_bare_destination_without_modifying_it() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("foreign.git");
    let initialized = Command::new("git")
        .args(["init", "--bare"])
        .arg(&destination)
        .output()
        .unwrap();
    assert!(initialized.status.success());
    let sentinel = destination.join("hooks/foreign-owner");
    fs::write(&sentinel, b"preserve me\n").unwrap();

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/accepted",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "import_destination_not_fresh");
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve me\n");
    assert!(!git_bare_succeeds(
        &destination,
        ["show-ref", "--verify", "refs/maka/accepted"]
    ));
}

#[test]
fn rejects_a_foreign_non_bare_destination_without_modifying_it() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("foreign-worktree");
    fs::create_dir(&destination).unwrap();
    let sentinel = destination.join("user-data.txt");
    fs::write(&sentinel, b"preserve non-bare content\n").unwrap();

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/accepted",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "import_destination_not_fresh");
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve non-bare content\n");
}

#[test]
fn rejects_the_source_repository_as_its_own_destination_without_modifying_it() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let sentinel = fixture.root.join("hooks/user-data");
    fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
    fs::write(&sentinel, b"preserve source bytes\n").unwrap();

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": fixture.root,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "import_destination_not_fresh");
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve source bytes\n");
}

#[test]
fn rejects_the_retired_managed_tree_policy_v1_before_creating_the_destination() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("unsupported-policy.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 1,
    }));

    assert_helper_error(&output, "unsupported_managed_tree_policy");
    assert!(!destination.exists());
}

#[test]
fn rejects_an_invalid_baseline_ref_before_creating_the_destination() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("invalid-ref.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/a..b",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "invalid_baseline_ref");
    assert!(!destination.exists());
}

#[test]
fn exactly_one_process_claims_a_fresh_import_destination() {
    let first_source = RepositoryFixture::sha1_with_commit();
    let second_source = RepositoryFixture::sha1_with_commit_content(b"second source\n");
    let first_head = first_source.git_output(["rev-parse", "HEAD"]);
    let second_head = second_source.git_output(["rev-parse", "HEAD"]);
    let first_blob = first_source.git_output(["rev-parse", "HEAD:hello.txt"]);
    let second_blob = second_source.git_output(["rev-parse", "HEAD:hello.txt"]);
    let destination = first_source.root.join("contended.git");

    let first_request = serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": first_source.root,
        "expectedSourceHeadCommitOid": first_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    });
    let second_request = serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": second_source.root,
        "expectedSourceHeadCommitOid": second_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    });

    let first = spawn_request(first_request);
    let second = spawn_request(second_request);
    let first_output = first.wait_with_output().unwrap();
    let second_output = second.wait_with_output().unwrap();
    let outputs = [first_output, second_output];
    assert_eq!(
        outputs
            .iter()
            .filter(|output| output.status.success())
            .count(),
        1
    );
    assert_eq!(
        outputs
            .iter()
            .filter(|output| {
                serde_json::from_slice::<serde_json::Value>(&output.stdout)
                    .is_ok_and(|response| response["reason"] == "import_destination_not_fresh")
            })
            .count(),
        1
    );

    let imported = outputs
        .iter()
        .find(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<serde_json::Value>(&output.stdout).ok())
        .unwrap();
    let winner_is_first = imported["sourceHeadCommitOid"] == first_head;
    let winner_blob = if winner_is_first {
        first_blob.as_str()
    } else {
        second_blob.as_str()
    };
    let loser_blob = if winner_is_first {
        second_blob.as_str()
    } else {
        first_blob.as_str()
    };
    assert!(git_bare_succeeds(
        &destination,
        ["cat-file", "-e", winner_blob]
    ));
    assert!(!git_bare_succeeds(
        &destination,
        ["cat-file", "-e", loser_blob]
    ));
}

#[test]
fn rejects_an_oversized_commit_before_creating_the_destination() {
    let fixture = RepositoryFixture::sha1_with_oversized_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("oversized-commit.git");

    let output = invoke_import(&fixture.root, &source_head, &destination);

    assert_helper_error(&output, "commit_object_limit_exceeded");
    assert!(!destination.exists());
}

#[test]
fn rejects_an_oversized_tree_before_creating_the_destination() {
    let fixture = RepositoryFixture::sha1_with_oversized_tree();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let destination = fixture.root.join("oversized-tree.git");

    let output = invoke_import(&fixture.root, &source_head, &destination);

    assert_helper_error(&output, "source_tree_object_limit_exceeded");
    assert!(!destination.exists());
}

#[test]
fn rejects_a_destination_below_an_aliased_parent() {
    let fixture = RepositoryFixture::sha1_with_commit();
    let source_head = fixture.git_output(["rev-parse", "HEAD"]);
    let owned_parent = fixture.root.join("owned-parent");
    let aliased_parent = fixture.root.join("aliased-parent");
    fs::create_dir(&owned_parent).unwrap();
    create_directory_alias(&owned_parent, &aliased_parent);
    let destination = aliased_parent.join("managed.git");

    let output = invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": fixture.root,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }));

    assert_helper_error(&output, "import_destination_parent_untrusted");
    assert!(!owned_parent.join("managed.git").exists());
}

fn invoke_helper(repository_path: &Path) -> Output {
    invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "inspect_repository",
        "repositoryPath": repository_path,
    }))
}

fn invoke_request(request: serde_json::Value) -> Output {
    spawn_request(request).wait_with_output().unwrap()
}

fn spawn_request(request: serde_json::Value) -> Child {
    let mut child = Command::new(HELPER)
        .env("PATH", "")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "extensions.objectFormat")
        .env("GIT_CONFIG_VALUE_0", "sha256")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&request).unwrap().as_bytes())
        .unwrap();
    child
}

fn invoke_import(source: &Path, source_head: &str, destination: &Path) -> Output {
    invoke_request(serde_json::json!({
        "protocolVersion": 1,
        "operation": "import_source_head",
        "sourceRepositoryPath": source,
        "expectedSourceHeadCommitOid": source_head,
        "destinationRepositoryPath": destination,
        "baselineRef": "refs/maka/baseline",
        "managedTreePolicyVersion": 2,
    }))
}

fn assert_helper_error(output: &Output, expected_reason: &str) {
    assert_eq!(output.status.code(), Some(1));
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["kind"], "helper_error");
    assert_eq!(response["reason"], expected_reason);
}

#[cfg(unix)]
fn create_directory_alias(target: &Path, alias: &Path) {
    std::os::unix::fs::symlink(target, alias).unwrap();
}

#[cfg(windows)]
fn create_directory_alias(target: &Path, alias: &Path) {
    let output = Command::new("cmd")
        .args(["/d", "/s", "/c", "mklink", "/J"])
        .arg(alias)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn git_bare_output<const N: usize>(repository: &Path, args: [&str; N]) -> String {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn git_bare_succeeds<const N: usize>(repository: &Path, args: [&str; N]) -> bool {
    Command::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(args)
        .status()
        .unwrap()
        .success()
}

struct RepositoryFixture {
    root: PathBuf,
}

#[derive(Clone, Copy)]
enum RawObjectKind {
    Blob,
    Tree,
}

struct RawTreeEntry<'a> {
    mode: &'a str,
    name: &'a str,
    object_kind: RawObjectKind,
}

impl RepositoryFixture {
    fn sha1_with_commit() -> Self {
        Self::sha1_with_commit_content(b"hello from sha1\n")
    }

    fn sha1_with_commit_content(content: &[u8]) -> Self {
        let fixture = Self::init("sha1");
        fs::write(fixture.root.join("hello.txt"), content).unwrap();
        fixture.git(["add", "hello.txt"]);
        fixture.git([
            "-c",
            "user.name=Maka Test",
            "-c",
            "user.email=maka@example.invalid",
            "commit",
            "-m",
            "fixture",
        ]);
        fixture
    }

    fn sha1_with_raw_tree(entries: &[RawTreeEntry<'_>]) -> (Self, String) {
        let fixture = Self::init("sha1");
        let blob_oid = fixture.git_input_output(
            ["hash-object", "-t", "blob", "-w", "--stdin"],
            b"raw tree blob\n",
        );
        let tree_oid =
            fixture.git_input_output(["hash-object", "-t", "tree", "-w", "--stdin"], &[]);
        let mut raw_tree = Vec::new();
        for entry in entries {
            raw_tree.extend_from_slice(entry.mode.as_bytes());
            raw_tree.push(b' ');
            raw_tree.extend_from_slice(entry.name.as_bytes());
            raw_tree.push(0);
            let oid = match entry.object_kind {
                RawObjectKind::Blob => &blob_oid,
                RawObjectKind::Tree => &tree_oid,
            };
            raw_tree.extend_from_slice(&decode_hex_oid(oid));
        }
        let root_tree_oid = fixture.git_input_output(
            ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
            &raw_tree,
        );
        let commit = format!(
            "tree {root_tree_oid}\nauthor Maka Test <maka@example.invalid> 946684800 +0000\ncommitter Maka Test <maka@example.invalid> 946684800 +0000\n\nraw tree fixture\n"
        );
        let source_head = fixture.git_input_output(
            ["hash-object", "-t", "commit", "-w", "--stdin"],
            commit.as_bytes(),
        );
        fixture.git(["update-ref", "HEAD", &source_head]);
        (fixture, source_head)
    }

    fn sha1_with_oversized_commit() -> Self {
        let fixture = Self::init("sha1");
        let tree = fixture.git_input_output(["hash-object", "-t", "tree", "-w", "--stdin"], &[]);
        let mut commit = format!(
            "tree {tree}\nauthor Maka Test <maka@example.invalid> 946684800 +0000\ncommitter Maka Test <maka@example.invalid> 946684800 +0000\n\n"
        )
        .into_bytes();
        commit.resize(1024 * 1024 + 1, b'x');
        let commit_oid =
            fixture.git_input_output(["hash-object", "-t", "commit", "-w", "--stdin"], &commit);
        fixture.git(["update-ref", "HEAD", &commit_oid]);
        fixture
    }

    fn sha1_with_oversized_tree() -> Self {
        let fixture = Self::init("sha1");
        let invalid_tree = vec![0_u8; 8 * 1024 * 1024 + 1];
        let tree_oid = fixture.git_input_output(
            ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
            &invalid_tree,
        );
        let commit = format!(
            "tree {tree_oid}\nauthor Maka Test <maka@example.invalid> 946684800 +0000\ncommitter Maka Test <maka@example.invalid> 946684800 +0000\n\noversized tree\n"
        );
        let commit_oid = fixture.git_input_output(
            ["hash-object", "-t", "commit", "-w", "--stdin"],
            commit.as_bytes(),
        );
        fixture.git(["update-ref", "HEAD", &commit_oid]);
        fixture
    }

    fn sha256_unborn() -> Self {
        Self::init("sha256")
    }

    fn unknown_object_format() -> Self {
        let fixture = Self::init("sha1");
        fixture.git(["config", "core.repositoryFormatVersion", "1"]);
        fixture.git(["config", "extensions.objectFormat", "sha512"]);
        fixture
    }

    fn sha1_with_replacement_ref() -> (Self, String, String) {
        let fixture = Self::sha1_with_commit();
        let raw_commit = fixture.git_output(["rev-parse", "HEAD"]);
        let raw_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

        fs::write(fixture.root.join("hello.txt"), b"replacement content\n").unwrap();
        fixture.git(["add", "hello.txt"]);
        fixture.git([
            "-c",
            "user.name=Maka Test",
            "-c",
            "user.email=maka@example.invalid",
            "commit",
            "-m",
            "replacement",
        ]);
        let replacement_commit = fixture.git_output(["rev-parse", "HEAD"]);
        fixture.git(["replace", &raw_commit, &replacement_commit]);
        fixture.git(["checkout", "--detach", &raw_commit]);

        (fixture, raw_commit, raw_tree)
    }

    fn sha1_with_mismatched_head_storage() -> (Self, String) {
        let fixture = Self::sha1_with_commit_content(b"claimed content\n");
        let claimed_head = fixture.git_output(["rev-parse", "HEAD"]);

        fs::write(fixture.root.join("hello.txt"), b"replacement content\n").unwrap();
        fixture.git(["add", "hello.txt"]);
        fixture.git([
            "-c",
            "user.name=Maka Test",
            "-c",
            "user.email=maka@example.invalid",
            "commit",
            "-m",
            "replacement object bytes",
        ]);
        let replacement_head = fixture.git_output(["rev-parse", "HEAD"]);
        fixture.git(["update-ref", "HEAD", &claimed_head]);

        fixture.replace_loose_object(&claimed_head, &replacement_head);
        (fixture, claimed_head)
    }

    fn sha1_with_mismatched_tree_storage() -> (Self, String) {
        let fixture = Self::sha1_with_commit_content(b"claimed tree content\n");
        let claimed_head = fixture.git_output(["rev-parse", "HEAD"]);
        let claimed_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);

        fs::write(
            fixture.root.join("hello.txt"),
            b"replacement tree content\n",
        )
        .unwrap();
        fixture.git(["add", "hello.txt"]);
        fixture.git([
            "-c",
            "user.name=Maka Test",
            "-c",
            "user.email=maka@example.invalid",
            "commit",
            "-m",
            "replacement tree bytes",
        ]);
        let replacement_tree = fixture.git_output(["rev-parse", "HEAD^{tree}"]);
        fixture.git(["update-ref", "HEAD", &claimed_head]);

        fixture.replace_loose_object(&claimed_tree, &replacement_tree);
        (fixture, claimed_head)
    }

    fn sha1_with_mismatched_blob_storage() -> (Self, String) {
        let fixture = Self::sha1_with_commit_content(b"claimed blob content\n");
        let claimed_head = fixture.git_output(["rev-parse", "HEAD"]);
        let claimed_blob = fixture.git_output(["rev-parse", "HEAD:hello.txt"]);

        fs::write(
            fixture.root.join("hello.txt"),
            b"replacement blob content\n",
        )
        .unwrap();
        fixture.git(["add", "hello.txt"]);
        let replacement_blob = fixture.git_output(["rev-parse", ":hello.txt"]);
        fixture.git(["reset", "--hard", &claimed_head]);

        fixture.replace_loose_object(&claimed_blob, &replacement_blob);
        (fixture, claimed_head)
    }

    fn replace_loose_object(&self, target_oid: &str, replacement_oid: &str) {
        let target = self.loose_object_path(target_oid);
        fs::remove_file(&target).unwrap();
        fs::copy(self.loose_object_path(replacement_oid), target).unwrap();
    }

    fn loose_object_path(&self, oid: &str) -> PathBuf {
        self.root
            .join(".git/objects")
            .join(&oid[..2])
            .join(&oid[2..])
    }

    fn init(object_format: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "maka-gitoxide-helper-admission-{}-{nonce}-{}",
            std::process::id(),
            FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&root).unwrap();
        let root = canonicalize_fixture_root(root);
        let fixture = Self { root };
        fixture.git([
            "init",
            "--quiet",
            &format!("--object-format={object_format}"),
        ]);
        fixture
    }

    fn git<const N: usize>(&self, args: [&str; N]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output<const N: usize>(&self, args: [&str; N]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn git_input_output<const N: usize>(&self, args: [&str; N], input: &[u8]) -> String {
        let mut child = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "git fixture command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
}

fn decode_hex_oid(oid: &str) -> Vec<u8> {
    oid.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).unwrap();
            u8::from_str_radix(pair, 16).unwrap()
        })
        .collect()
}

#[cfg(unix)]
fn canonicalize_fixture_root(root: PathBuf) -> PathBuf {
    fs::canonicalize(root).unwrap()
}

#[cfg(windows)]
fn canonicalize_fixture_root(root: PathBuf) -> PathBuf {
    root
}

impl Drop for RepositoryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
