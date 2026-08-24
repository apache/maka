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
    collections::HashSet,
    fs,
    io::{self, Read},
    path::PathBuf,
    process::ExitCode,
};

use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_IMPORT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_FILES: u64 = 200_000;
const MANAGED_TREE_POLICY_V1: ManagedTreePolicy = ManagedTreePolicy {
    max_depth: 64,
    max_tree_visits: 250_000,
    max_entries: 400_000,
    max_total_path_bytes: 256 * 1024 * 1024,
    max_component_bytes: 255,
    max_relative_path_bytes: 4096,
    max_files: MAX_IMPORT_FILES,
    max_file_bytes: MAX_IMPORT_FILE_BYTES,
    max_bytes: MAX_IMPORT_BYTES,
};

#[derive(Deserialize)]
#[serde(
    deny_unknown_fields,
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Request {
    InspectRepository {
        protocol_version: u8,
        repository_path: PathBuf,
    },
    ImportSourceHead {
        protocol_version: u8,
        source_repository_path: PathBuf,
        expected_source_head_commit_oid: String,
        destination_repository_path: PathBuf,
        baseline_ref: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Response<'a> {
    #[serde(rename_all = "camelCase")]
    RepositoryInspected {
        protocol_version: u8,
        object_format: &'static str,
        head_commit_oid: String,
        head_tree_oid: String,
    },
    #[serde(rename_all = "camelCase")]
    RepositoryRejected {
        protocol_version: u8,
        reason: &'static str,
        object_format: String,
        supported_object_formats: [&'static str; 1],
    },
    #[serde(rename_all = "camelCase")]
    SourceImported {
        protocol_version: u8,
        object_format: &'static str,
        source_head_commit_oid: String,
        source_tree_oid: String,
        baseline_commit_oid: String,
        baseline_tree_oid: String,
        baseline_ref: String,
        files_imported: u64,
        bytes_imported: u64,
    },
    #[serde(rename_all = "camelCase")]
    HelperError {
        protocol_version: u8,
        reason: &'a str,
    },
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(reason) => {
            write_response(&Response::HelperError {
                protocol_version: PROTOCOL_VERSION,
                reason,
            });
            ExitCode::from(1)
        }
    }
}

fn run() -> Result<ExitCode, &'static str> {
    let request = read_request()?;
    match request {
        Request::InspectRepository {
            protocol_version,
            repository_path,
        } => {
            assert_protocol_version(protocol_version)?;
            inspect_repository(repository_path)
        }
        Request::ImportSourceHead {
            protocol_version,
            source_repository_path,
            expected_source_head_commit_oid,
            destination_repository_path,
            baseline_ref,
        } => {
            assert_protocol_version(protocol_version)?;
            import_source_head(
                source_repository_path,
                expected_source_head_commit_oid,
                destination_repository_path,
                baseline_ref,
            )
        }
    }
}

fn assert_protocol_version(protocol_version: u8) -> Result<(), &'static str> {
    if protocol_version != PROTOCOL_VERSION {
        return Err("unsupported_protocol_version");
    }
    Ok(())
}

fn inspect_repository(repository_path: PathBuf) -> Result<ExitCode, &'static str> {
    let repository = match gix::open::Options::isolated()
        .strict_config(true)
        .open(repository_path)
    {
        Ok(repository) => repository.to_thread_local(),
        Err(gix::open::Error::Config(gix::config::Error::ConfigTypedString(error)))
            if error.key.as_slice() == b"extensions.objectFormat" =>
        {
            let object_format = error
                .value
                .as_ref()
                .map(|value| String::from_utf8_lossy(value.as_slice()).into_owned())
                .unwrap_or_else(|| "unknown".to_owned());
            return Ok(reject_unsupported_object_format(object_format));
        }
        Err(gix::open::Error::Config(gix::config::Error::UnsupportedObjectFormat { name })) => {
            let object_format = String::from_utf8_lossy(name.as_slice()).into_owned();
            return Ok(reject_unsupported_object_format(object_format));
        }
        Err(_) => return Err("repository_open_failed"),
    };

    match repository.object_hash() {
        gix::hash::Kind::Sha1 => {
            let head = repository
                .head_commit()
                .map_err(|_| "head_commit_unavailable")?;
            let head_commit_oid = head.id().detach().to_string();
            let head_tree_oid = head
                .tree_id()
                .map_err(|_| "head_tree_unavailable")?
                .detach()
                .to_string();
            write_response(&Response::RepositoryInspected {
                protocol_version: PROTOCOL_VERSION,
                object_format: "sha1",
                head_commit_oid,
                head_tree_oid,
            });
            Ok(ExitCode::SUCCESS)
        }
        gix::hash::Kind::Sha256 => Ok(reject_unsupported_object_format("sha256".to_owned())),
        _ => Ok(reject_unsupported_object_format("unknown".to_owned())),
    }
}

fn open_repository(repository_path: PathBuf) -> Result<gix::Repository, &'static str> {
    Ok(gix::open::Options::isolated()
        .strict_config(true)
        .open(repository_path)
        .map_err(|_| "repository_open_failed")?
        .to_thread_local())
}

fn import_source_head(
    source_repository_path: PathBuf,
    expected_source_head_commit_oid: String,
    destination_repository_path: PathBuf,
    baseline_ref: String,
) -> Result<ExitCode, &'static str> {
    use gix::bstr::ByteSlice;

    if !baseline_ref.starts_with("refs/maka/") {
        return Err("baseline_ref_outside_maka_namespace");
    }
    let source = open_repository(source_repository_path)?;
    if source.object_hash() != gix::hash::Kind::Sha1 {
        return Err("unsupported_object_format");
    }
    let expected_source_head =
        gix::hash::ObjectId::from_hex(expected_source_head_commit_oid.as_bytes())
            .map_err(|_| "invalid_source_head_commit_oid")?;
    if expected_source_head.kind() != gix::hash::Kind::Sha1 {
        return Err("invalid_source_head_commit_oid");
    }
    let source_head = source
        .head_commit()
        .map_err(|_| "source_head_commit_unavailable")?;
    if source_head.id().detach() != expected_source_head {
        return Err("source_head_commit_mismatch");
    }
    let source_tree = source_head
        .tree_id()
        .map_err(|_| "source_head_tree_unavailable")?
        .detach();

    match fs::symlink_metadata(&destination_repository_path) {
        Ok(_) => return Err("import_destination_not_fresh"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("import_destination_unreadable"),
    }
    let destination = gix::init_bare(&destination_repository_path)
        .map_err(|_| "import_destination_create_failed")?;
    if destination.object_hash() != gix::hash::Kind::Sha1 {
        return Err("import_destination_object_format_mismatch");
    }

    fs::remove_dir_all(destination_repository_path.join("hooks"))
        .map_err(|_| "import_hooks_cleanup_failed")?;
    fs::create_dir(destination_repository_path.join("hooks"))
        .map_err(|_| "import_hooks_cleanup_failed")?;

    let mut stats = ManagedTreeStats::default();
    copy_source_tree(
        &source,
        &destination,
        source_tree,
        "",
        0,
        MANAGED_TREE_POLICY_V1,
        &mut stats,
    )?;

    let signature = gix::actor::SignatureRef {
        name: b"Maka Workspace Service".as_bstr(),
        email: b"workspace@maka.invalid".as_bstr(),
        time: "946684800 +0000",
    };
    let baseline_commit = destination
        .new_commit_as(
            signature,
            signature,
            "maka managed workspace baseline v1",
            source_tree,
            std::iter::empty::<gix::hash::ObjectId>(),
        )
        .map_err(|_| "baseline_commit_write_failed")?
        .id()
        .detach();
    destination
        .reference(
            baseline_ref.as_str(),
            baseline_commit,
            gix::refs::transaction::PreviousValue::MustNotExist,
            "maka managed workspace baseline",
        )
        .map_err(|_| "baseline_publish_failed")?;

    write_response(&Response::SourceImported {
        protocol_version: PROTOCOL_VERSION,
        object_format: "sha1",
        source_head_commit_oid: expected_source_head.to_string(),
        source_tree_oid: source_tree.to_string(),
        baseline_commit_oid: baseline_commit.to_string(),
        baseline_tree_oid: source_tree.to_string(),
        baseline_ref,
        files_imported: stats.files,
        bytes_imported: stats.bytes,
    });
    Ok(ExitCode::SUCCESS)
}

fn copy_source_tree(
    source: &gix::Repository,
    destination: &gix::Repository,
    tree_oid: gix::hash::ObjectId,
    prefix: &str,
    depth: u64,
    policy: ManagedTreePolicy,
    stats: &mut ManagedTreeStats,
) -> Result<(), &'static str> {
    stats.enter_tree(depth, policy)?;
    let tree = source
        .find_tree(tree_oid)
        .map_err(|_| "source_tree_unavailable")?;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| "source_tree_invalid")?;
        let component =
            std::str::from_utf8(entry.filename()).map_err(|_| "unsupported_source_path")?;
        if !is_supported_source_component(component)
            || component.len() as u64 > policy.max_component_bytes
        {
            return Err("unsupported_source_path");
        }
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        stats.observe_entry(&relative_path, policy)?;
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => {
                copy_source_tree(
                    source,
                    destination,
                    entry.object_id(),
                    &relative_path,
                    depth.checked_add(1).ok_or("source_tree_depth_exceeded")?,
                    policy,
                    stats,
                )?;
            }
            gix::objs::tree::EntryKind::Blob | gix::objs::tree::EntryKind::BlobExecutable => {
                let header = entry.id().header().map_err(|_| "source_blob_unavailable")?;
                if header.kind() != gix::objs::Kind::Blob {
                    return Err("source_blob_invalid");
                }
                stats.observe_blob(header.size(), policy)?;
                let blob = entry
                    .object()
                    .map_err(|_| "source_blob_unavailable")?
                    .try_into_blob()
                    .map_err(|_| "source_blob_invalid")?;
                let copied_blob = destination
                    .write_blob(&blob.data)
                    .map_err(|_| "source_blob_copy_failed")?
                    .detach();
                if copied_blob != entry.object_id() {
                    return Err("source_blob_identity_mismatch");
                }
            }
            _ => return Err("unsupported_source_entry_kind"),
        }
    }
    let copied_tree = destination
        .write_object(tree.decode().map_err(|_| "source_tree_invalid")?)
        .map_err(|_| "source_tree_copy_failed")?
        .detach();
    if copied_tree != tree_oid {
        return Err("source_tree_identity_mismatch");
    }
    Ok(())
}

fn is_supported_source_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.contains('/')
        && !component.contains('\\')
        && !component.contains('\0')
        && !component.eq_ignore_ascii_case(".git")
        && !component.eq_ignore_ascii_case(".gitattributes")
}

#[derive(Clone, Copy)]
struct ManagedTreePolicy {
    max_depth: u64,
    max_tree_visits: u64,
    max_entries: u64,
    max_total_path_bytes: u64,
    max_component_bytes: u64,
    max_relative_path_bytes: u64,
    max_files: u64,
    max_file_bytes: u64,
    max_bytes: u64,
}

#[derive(Default)]
struct ManagedTreeStats {
    tree_visits: u64,
    entries: u64,
    total_path_bytes: u64,
    files: u64,
    bytes: u64,
    folded_paths: HashSet<String>,
}

impl ManagedTreeStats {
    fn enter_tree(
        &mut self,
        depth: u64,
        policy: ManagedTreePolicy,
    ) -> Result<(), &'static str> {
        if depth > policy.max_depth {
            return Err("source_tree_depth_exceeded");
        }
        self.tree_visits = self
            .tree_visits
            .checked_add(1)
            .filter(|visits| *visits <= policy.max_tree_visits)
            .ok_or("source_tree_visit_limit_exceeded")?;
        Ok(())
    }

    fn observe_entry(
        &mut self,
        relative_path: &str,
        policy: ManagedTreePolicy,
    ) -> Result<(), &'static str> {
        let path_bytes = relative_path.len() as u64;
        if path_bytes > policy.max_relative_path_bytes {
            return Err("source_path_length_exceeded");
        }
        self.entries = self
            .entries
            .checked_add(1)
            .filter(|entries| *entries <= policy.max_entries)
            .ok_or("source_tree_entry_limit_exceeded")?;
        self.total_path_bytes = self
            .total_path_bytes
            .checked_add(path_bytes)
            .filter(|bytes| *bytes <= policy.max_total_path_bytes)
            .ok_or("source_path_byte_limit_exceeded")?;
        let folded_path: String = relative_path.nfc().flat_map(char::to_lowercase).collect();
        if !self.folded_paths.insert(folded_path) {
            return Err("source_path_collision");
        }
        Ok(())
    }

    fn observe_blob(
        &mut self,
        size: u64,
        policy: ManagedTreePolicy,
    ) -> Result<(), &'static str> {
        if size > policy.max_file_bytes {
            return Err("source_file_limit_exceeded");
        }
        self.files = self
            .files
            .checked_add(1)
            .filter(|files| *files <= policy.max_files)
            .ok_or("source_file_limit_exceeded")?;
        self.bytes = self
            .bytes
            .checked_add(size)
            .filter(|bytes| *bytes <= policy.max_bytes)
            .ok_or("source_byte_limit_exceeded")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_policy() -> ManagedTreePolicy {
        ManagedTreePolicy {
            max_depth: 1,
            max_tree_visits: 2,
            max_entries: 2,
            max_total_path_bytes: 5,
            max_component_bytes: 3,
            max_relative_path_bytes: 4,
            max_files: 1,
            max_file_bytes: 3,
            max_bytes: 3,
        }
    }

    #[test]
    fn managed_tree_budget_bounds_depth_visits_and_entries() {
        let policy = tiny_policy();
        let mut stats = ManagedTreeStats::default();
        assert_eq!(stats.enter_tree(0, policy), Ok(()));
        assert_eq!(stats.enter_tree(1, policy), Ok(()));
        assert_eq!(
            stats.enter_tree(1, policy),
            Err("source_tree_visit_limit_exceeded")
        );

        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.enter_tree(2, policy),
            Err("source_tree_depth_exceeded")
        );
        assert_eq!(stats.observe_entry("a", policy), Ok(()));
        assert_eq!(stats.observe_entry("bb", policy), Ok(()));
        assert_eq!(
            stats.observe_entry("c", policy),
            Err("source_tree_entry_limit_exceeded")
        );
    }

    #[test]
    fn managed_tree_budget_bounds_paths_and_blob_bytes() {
        let policy = tiny_policy();
        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.observe_entry("abcde", policy),
            Err("source_path_length_exceeded")
        );
        assert_eq!(stats.observe_entry("abc", policy), Ok(()));
        assert_eq!(
            stats.observe_entry("def", policy),
            Err("source_path_byte_limit_exceeded")
        );

        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.observe_blob(4, policy),
            Err("source_file_limit_exceeded")
        );
        assert_eq!(stats.observe_blob(3, policy), Ok(()));
        assert_eq!(
            stats.observe_blob(1, policy),
            Err("source_file_limit_exceeded")
        );
    }
}

fn reject_unsupported_object_format(object_format: String) -> ExitCode {
    write_response(&Response::RepositoryRejected {
        protocol_version: PROTOCOL_VERSION,
        reason: "unsupported_object_format",
        object_format,
        supported_object_formats: ["sha1"],
    });
    ExitCode::from(2)
}

fn read_request() -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "request_read_failed")?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err("request_too_large");
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_request")
}

fn write_response(response: &Response<'_>) {
    let encoded = serde_json::to_string(response).expect("closed response shape must serialize");
    println!("{encoded}");
}
