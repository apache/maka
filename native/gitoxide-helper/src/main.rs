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
    path::{Path, PathBuf},
    process::ExitCode,
};

use caseless::Caseless;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

const PROTOCOL_VERSION: u8 = 1;
const MANAGED_TREE_POLICY_VERSION: u8 = 2;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_REPOSITORY_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_REPOSITORY_METADATA_ENTRIES: u64 = 16_384;
const MAX_REPOSITORY_METADATA_DEPTH: u64 = 64;
const MAX_REPOSITORY_PACK_DIRECTORY_ENTRIES: u64 = 1024;
const MAX_GITOXIDE_OBJECT_STORE_SLOTS: u16 = 1024;
const MAX_IMPORT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ATTRIBUTES_FILE_BYTES: u64 = 64 * 1024;
const MAX_GIT_ATTRIBUTES_LINE_BYTES_V2: usize = 2048;
const MAX_IMPORT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_IMPORT_FILES: u64 = 200_000;
const MAX_COMMIT_OBJECT_BYTES: u64 = 1024 * 1024;
const MAX_SINGLE_TREE_OBJECT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_TREE_OBJECT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GITOXIDE_OBJECT_ALLOCATION_BYTES: &str = "gitoxide.objects.allocLimit=67108864";
const MANAGED_TREE_POLICY_V2: ManagedTreePolicy = ManagedTreePolicy {
    max_depth: 64,
    max_tree_visits: 250_000,
    max_entries: 400_000,
    max_total_path_bytes: 256 * 1024 * 1024,
    max_total_folded_path_bytes: 256 * 1024 * 1024,
    max_component_bytes: 255,
    max_relative_path_bytes: 4096,
    max_folded_relative_path_bytes: 4096,
    max_files: MAX_IMPORT_FILES,
    max_file_bytes: MAX_IMPORT_FILE_BYTES,
    max_bytes: MAX_IMPORT_BYTES,
    max_commit_object_bytes: MAX_COMMIT_OBJECT_BYTES,
    max_single_tree_object_bytes: MAX_SINGLE_TREE_OBJECT_BYTES,
    max_total_tree_object_bytes: MAX_TOTAL_TREE_OBJECT_BYTES,
};
const HELPER_ERROR_REASONS_V1: &[&str] = &[
    "internal_error_reason_invalid",
    "request_read_failed",
    "request_too_large",
    "invalid_request",
    "unsupported_protocol_version",
    "repository_metadata_limit_exceeded",
    "repository_alternates_unsupported",
    "repository_open_failed",
    "head_commit_unavailable",
    "head_commit_identity_mismatch",
    "head_tree_unavailable",
    "commit_object_limit_exceeded",
    "baseline_commit_write_failed",
    "baseline_publish_failed",
    "baseline_ref_outside_maka_namespace",
    "invalid_baseline_ref",
    "import_destination_create_failed",
    "import_destination_not_fresh",
    "import_destination_object_format_mismatch",
    "import_destination_parent_untrusted",
    "invalid_source_head_commit_oid",
    "source_blob_copy_failed",
    "source_blob_identity_mismatch",
    "source_blob_invalid",
    "source_blob_unavailable",
    "source_attributes_limit_exceeded",
    "source_byte_limit_exceeded",
    "source_file_limit_exceeded",
    "source_folded_path_byte_limit_exceeded",
    "source_folded_path_length_exceeded",
    "source_head_commit_mismatch",
    "source_head_commit_identity_mismatch",
    "source_head_commit_unavailable",
    "source_head_tree_unavailable",
    "source_path_collision",
    "source_path_byte_limit_exceeded",
    "source_path_length_exceeded",
    "source_tree_copy_failed",
    "source_tree_depth_exceeded",
    "source_tree_entry_limit_exceeded",
    "source_tree_identity_mismatch",
    "source_tree_invalid",
    "source_tree_object_byte_limit_exceeded",
    "source_tree_object_limit_exceeded",
    "source_tree_noncanonical_mode",
    "source_tree_not_sorted",
    "source_tree_observation_mismatch",
    "source_tree_unavailable",
    "source_tree_visit_limit_exceeded",
    "unsupported_source_entry_kind",
    "unsupported_source_attributes",
    "unsupported_source_path",
    "unsupported_object_format",
    "unsupported_managed_tree_policy",
];

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
        managed_tree_policy_version: u8,
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
        managed_tree_policy_version: u8,
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
            let reason = if HELPER_ERROR_REASONS_V1.contains(&reason) {
                reason
            } else {
                "internal_error_reason_invalid"
            };
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
            managed_tree_policy_version,
        } => {
            assert_protocol_version(protocol_version)?;
            import_source_head(
                source_repository_path,
                expected_source_head_commit_oid,
                destination_repository_path,
                baseline_ref,
                managed_tree_policy_version,
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
    let mut metadata_budget = admit_repository_metadata(&repository_path)?;
    let repository = match managed_open_options().open(repository_path) {
        Ok(repository) => repository.to_thread_local(),
        Err(gix::open::Error::Config(gix::config::Error::ConfigTypedString(error)))
            if error.key.as_slice() == b"extensions.objectFormat" =>
        {
            return Ok(reject_unsupported_object_format("unknown".to_owned()));
        }
        Err(gix::open::Error::Config(gix::config::Error::UnsupportedObjectFormat { .. })) => {
            return Ok(reject_unsupported_object_format("unknown".to_owned()));
        }
        Err(_) => return Err("repository_open_failed"),
    };
    metadata_budget.observe_opened_repository(&repository)?;

    match repository.object_hash() {
        gix::hash::Kind::Sha1 => {
            let head_id = repository
                .head_id()
                .map_err(|_| "head_commit_unavailable")?
                .detach();
            let head = load_verified_object(
                &repository,
                head_id,
                gix::objs::Kind::Commit,
                MAX_COMMIT_OBJECT_BYTES,
                "head_commit_unavailable",
                "head_commit_unavailable",
                "commit_object_limit_exceeded",
                "head_commit_identity_mismatch",
            )?
            .try_into_commit()
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
    let mut metadata_budget = admit_repository_metadata(&repository_path)?;
    let repository = managed_open_options()
        .open(repository_path)
        .map_err(|_| "repository_open_failed")?
        .to_thread_local();
    metadata_budget.observe_opened_repository(&repository)?;
    Ok(repository)
}

fn managed_open_options() -> gix::open::Options {
    gix::open::Options::isolated()
        .lossy_config(true)
        .strict_config(true)
        .object_store_slots(gix::odb::store::init::Slots::Given(
            MAX_GITOXIDE_OBJECT_STORE_SLOTS,
        ))
        .config_overrides([MAX_GITOXIDE_OBJECT_ALLOCATION_BYTES])
}

fn admit_repository_metadata(
    repository_path: &Path,
) -> Result<RepositoryMetadataBudget, &'static str> {
    let mut budget = RepositoryMetadataBudget::default();
    if repository_path
        .file_name()
        .is_none_or(|name| name != ".git")
    {
        let worktree_candidate = repository_path.join(".git");
        budget.observe_repository_candidate(&worktree_candidate)?;
        if gix::discover::is_git(&worktree_candidate).is_ok() {
            return Ok(budget);
        }
    }
    budget.observe_repository_candidate(repository_path)?;
    Ok(budget)
}

#[derive(Default)]
struct RepositoryMetadataBudget {
    observed_bytes: u64,
    observed_entries: u64,
    observed_paths: HashSet<PathBuf>,
}

impl RepositoryMetadataBudget {
    fn observe_repository_candidate(&mut self, candidate: &Path) -> Result<(), &'static str> {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err("repository_open_failed"),
            Ok(metadata) if metadata.is_file() => {
                self.observe_file_with_metadata(candidate, &metadata)?;
                let git_dir = gix::discover::path::from_gitdir_file(candidate)
                    .map_err(|_| "repository_open_failed")?;
                self.observe_git_dir(&git_dir)
            }
            Ok(metadata) if metadata.is_dir() => self.observe_git_dir(candidate),
            Ok(_) => Err("repository_open_failed"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("repository_open_failed"),
        }
    }

    fn observe_opened_repository(
        &mut self,
        repository: &gix::Repository,
    ) -> Result<(), &'static str> {
        self.observe_git_dir(repository.git_dir())?;
        self.observe_common_dir(repository.common_dir())
    }

    fn observe_git_dir(&mut self, git_dir: &Path) -> Result<(), &'static str> {
        self.observe_optional_file(&git_dir.join("HEAD"))?;
        self.observe_optional_file(&git_dir.join("gitdir"))?;
        self.observe_optional_file(&git_dir.join("config.worktree"))?;
        self.observe_optional_file(&git_dir.join("packed-refs"))?;
        self.observe_optional_file(&git_dir.join("shallow"))?;
        self.observe_tree(&git_dir.join("refs"), 0)?;

        let common_dir_path_file = git_dir.join("commondir");
        self.observe_optional_file(&common_dir_path_file)?;
        let common_dir = match gix::discover::path::from_plain_file(&common_dir_path_file) {
            Some(Ok(relative_or_absolute)) => git_dir.join(relative_or_absolute),
            Some(Err(_)) => return Err("repository_open_failed"),
            None => git_dir.to_path_buf(),
        };
        self.observe_common_dir(&common_dir)
    }

    fn observe_common_dir(&mut self, common_dir: &Path) -> Result<(), &'static str> {
        self.observe_optional_file(&common_dir.join("config"))?;
        self.observe_optional_file(&common_dir.join("packed-refs"))?;
        self.observe_optional_file(&common_dir.join("shallow"))?;
        self.reject_alternates(&common_dir.join("objects/info/alternates"))?;
        self.reject_alternates(&common_dir.join("objects/info/http-alternates"))?;
        self.observe_pack_directory(&common_dir.join("objects/pack"))?;
        self.observe_tree(&common_dir.join("refs"), 0)
    }

    fn reject_alternates(&self, path: &Path) -> Result<(), &'static str> {
        match fs::symlink_metadata(path) {
            Ok(_) => Err("repository_alternates_unsupported"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("repository_open_failed"),
        }
    }

    fn observe_pack_directory(&mut self, path: &Path) -> Result<(), &'static str> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("repository_open_failed");
            }
            Ok(_) => self.observe_entry(path, 0)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("repository_open_failed"),
        }

        let entries = fs::read_dir(path).map_err(|_| "repository_open_failed")?;
        let mut pack_entries = 0u64;
        for entry in entries {
            let entry = entry.map_err(|_| "repository_open_failed")?;
            pack_entries = pack_entries
                .checked_add(1)
                .filter(|entries| *entries <= MAX_REPOSITORY_PACK_DIRECTORY_ENTRIES)
                .ok_or("repository_metadata_limit_exceeded")?;
            let entry_path = entry.path();
            let metadata =
                fs::symlink_metadata(&entry_path).map_err(|_| "repository_open_failed")?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("repository_open_failed");
            }
            let path_bytes = u64::try_from(entry.file_name().as_encoded_bytes().len())
                .map_err(|_| "repository_metadata_limit_exceeded")?;
            self.observe_entry(&entry_path, path_bytes)?;
        }
        Ok(())
    }

    fn observe_tree(&mut self, path: &Path, depth: u64) -> Result<(), &'static str> {
        if depth > MAX_REPOSITORY_METADATA_DEPTH {
            return Err("repository_metadata_limit_exceeded");
        }
        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("repository_open_failed"),
        };
        for entry in entries {
            let entry = entry.map_err(|_| "repository_open_failed")?;
            let entry_path = entry.path();
            let metadata =
                fs::symlink_metadata(&entry_path).map_err(|_| "repository_open_failed")?;
            if metadata.file_type().is_symlink() {
                return Err("repository_open_failed");
            }
            if metadata.is_dir() {
                self.observe_entry(&entry_path, 0)?;
                self.observe_tree(&entry_path, depth + 1)?;
            } else if metadata.is_file() {
                self.observe_file_with_metadata(&entry_path, &metadata)?;
            } else {
                return Err("repository_open_failed");
            }
        }
        Ok(())
    }

    fn observe_optional_file(&mut self, path: &Path) -> Result<(), &'static str> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err("repository_open_failed"),
            Ok(metadata) if metadata.is_file() => self.observe_file_with_metadata(path, &metadata),
            Ok(_) => Err("repository_open_failed"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("repository_open_failed"),
        }
    }

    fn observe_file_with_metadata(
        &mut self,
        path: &Path,
        metadata: &fs::Metadata,
    ) -> Result<(), &'static str> {
        self.observe_entry(path, metadata.len())
    }

    fn observe_entry(&mut self, path: &Path, bytes: u64) -> Result<(), &'static str> {
        if !self.observed_paths.insert(path.to_path_buf()) {
            return Ok(());
        }
        self.observed_entries = self
            .observed_entries
            .checked_add(1)
            .filter(|entries| *entries <= MAX_REPOSITORY_METADATA_ENTRIES)
            .ok_or("repository_metadata_limit_exceeded")?;
        self.observed_bytes = self
            .observed_bytes
            .checked_add(bytes)
            .filter(|observed| *observed <= MAX_REPOSITORY_METADATA_BYTES)
            .ok_or("repository_metadata_limit_exceeded")?;
        Ok(())
    }
}

fn import_source_head(
    source_repository_path: PathBuf,
    expected_source_head_commit_oid: String,
    destination_repository_path: PathBuf,
    baseline_ref: String,
    managed_tree_policy_version: u8,
) -> Result<ExitCode, &'static str> {
    use gix::bstr::ByteSlice;

    if !baseline_ref.starts_with("refs/maka/") {
        return Err("baseline_ref_outside_maka_namespace");
    }
    gix::refs::FullName::try_from(baseline_ref.as_str()).map_err(|_| "invalid_baseline_ref")?;
    if managed_tree_policy_version != MANAGED_TREE_POLICY_VERSION {
        return Err("unsupported_managed_tree_policy");
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
    let source_head_id = source
        .head_id()
        .map_err(|_| "source_head_commit_unavailable")?;
    if source_head_id.detach() != expected_source_head {
        return Err("source_head_commit_mismatch");
    }
    let source_head = load_verified_object(
        &source,
        expected_source_head,
        gix::objs::Kind::Commit,
        MANAGED_TREE_POLICY_V2.max_commit_object_bytes,
        "source_head_commit_unavailable",
        "source_head_commit_unavailable",
        "commit_object_limit_exceeded",
        "source_head_commit_identity_mismatch",
    )?
    .try_into_commit()
    .map_err(|_| "source_head_commit_unavailable")?;
    let source_tree = source_head
        .tree_id()
        .map_err(|_| "source_head_tree_unavailable")?
        .detach();

    let mut stats = ManagedTreeStats::default();
    walk_verified_source_tree(
        &source,
        None,
        source_tree,
        "",
        0,
        MANAGED_TREE_POLICY_V2,
        &mut stats,
    )?;
    let expected_files = stats.files;
    let expected_bytes = stats.bytes;
    drop(stats);

    assert_import_destination_parent(&destination_repository_path)?;
    let destination = claim_fresh_import_destination(&destination_repository_path)?;
    if destination.object_hash() != gix::hash::Kind::Sha1 {
        return Err("import_destination_object_format_mismatch");
    }

    let mut copy_stats = ManagedTreeStats::default();
    walk_verified_source_tree(
        &source,
        Some(&destination),
        source_tree,
        "",
        0,
        MANAGED_TREE_POLICY_V2,
        &mut copy_stats,
    )?;
    if copy_stats.files != expected_files || copy_stats.bytes != expected_bytes {
        return Err("source_tree_observation_mismatch");
    }

    let signature = gix::actor::SignatureRef {
        name: b"Maka Workspace Service".as_bstr(),
        email: b"workspace@maka.invalid".as_bstr(),
        time: "946684800 +0000",
    };
    let baseline_commit = destination
        .new_commit_as(
            signature,
            signature,
            "maka managed workspace baseline v2",
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
        managed_tree_policy_version: MANAGED_TREE_POLICY_VERSION,
        files_imported: copy_stats.files,
        bytes_imported: copy_stats.bytes,
    });
    Ok(ExitCode::SUCCESS)
}

fn claim_fresh_import_destination(path: &Path) -> Result<gix::Repository, &'static str> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err("import_destination_not_fresh");
        }
        Err(_) => return Err("import_destination_create_failed"),
    }
    gix::ThreadSafeRepository::init_opts(
        path,
        gix::create::Kind::Bare,
        gix::create::Options {
            destination_must_be_empty: Some(true),
            object_hash: Some(gix::hash::Kind::Sha1),
            ..Default::default()
        },
        managed_open_options(),
    )
    .map_err(|_| "import_destination_create_failed")
    .map(|repository| repository.to_thread_local())
}

fn load_verified_object<'repo>(
    repository: &'repo gix::Repository,
    object_id: gix::hash::ObjectId,
    expected_kind: gix::objs::Kind,
    max_bytes: u64,
    unavailable_reason: &'static str,
    invalid_reason: &'static str,
    limit_reason: &'static str,
    identity_reason: &'static str,
) -> Result<gix::Object<'repo>, &'static str> {
    let header = repository
        .find_header(object_id)
        .map_err(|_| unavailable_reason)?;
    if header.kind() != expected_kind {
        return Err(invalid_reason);
    }
    if header.size() > max_bytes {
        return Err(limit_reason);
    }
    let object = repository
        .find_object(object_id)
        .map_err(|_| unavailable_reason)?;
    if object.kind != expected_kind {
        return Err(invalid_reason);
    }
    if object.data.len() as u64 > max_bytes {
        return Err(limit_reason);
    }
    gix::objs::Data::new(&object.data, object.kind, object.id.kind())
        .verify_checksum(object_id.as_ref())
        .map_err(|_| identity_reason)?;
    Ok(object)
}

fn assert_import_destination_parent(destination: &Path) -> Result<(), &'static str> {
    if !destination.is_absolute() {
        return Err("import_destination_parent_untrusted");
    }
    let parent = destination
        .parent()
        .ok_or("import_destination_parent_untrusted")?;
    let mut ancestors = parent.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "import_destination_parent_untrusted")?;
        if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
            return Err("import_destination_parent_untrusted");
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn walk_verified_source_tree(
    source: &gix::Repository,
    destination: Option<&gix::Repository>,
    tree_oid: gix::hash::ObjectId,
    prefix: &str,
    depth: u64,
    policy: ManagedTreePolicy,
    stats: &mut ManagedTreeStats,
) -> Result<(), &'static str> {
    let tree = load_verified_object(
        source,
        tree_oid,
        gix::objs::Kind::Tree,
        policy.max_single_tree_object_bytes,
        "source_tree_unavailable",
        "source_tree_invalid",
        "source_tree_object_limit_exceeded",
        "source_tree_identity_mismatch",
    )?
    .try_into_tree()
    .map_err(|_| "source_tree_invalid")?;
    stats.enter_tree(depth, tree.data.len() as u64, policy)?;
    assert_canonical_tree_modes(&tree.data)?;
    let mut previous_entry: Option<(Vec<u8>, bool)> = None;
    for entry in tree.iter() {
        let entry = entry.map_err(|_| "source_tree_invalid")?;
        let component =
            std::str::from_utf8(entry.filename()).map_err(|_| "unsupported_source_path")?;
        if !is_supported_source_component(component)
            || component.len() as u64 > policy.max_component_bytes
        {
            return Err("unsupported_source_path");
        }
        let is_tree = matches!(entry.mode().kind(), gix::objs::tree::EntryKind::Tree);
        if previous_entry.as_ref().is_some_and(|(name, tree)| {
            compare_git_tree_entry_names(name, *tree, entry.filename(), is_tree)
                != std::cmp::Ordering::Less
        }) {
            return Err("source_tree_not_sorted");
        }
        previous_entry = Some((entry.filename().to_vec(), is_tree));
        let relative_path = if prefix.is_empty() {
            component.to_owned()
        } else {
            format!("{prefix}/{component}")
        };
        stats.observe_entry(&relative_path, policy)?;
        match entry.mode().kind() {
            gix::objs::tree::EntryKind::Tree => {
                walk_verified_source_tree(
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
                let blob_oid = entry.object_id();
                let is_attributes = component == ".gitattributes";
                let blob = load_verified_object(
                    source,
                    blob_oid,
                    gix::objs::Kind::Blob,
                    if is_attributes {
                        MAX_ATTRIBUTES_FILE_BYTES
                    } else {
                        policy.max_file_bytes
                    },
                    "source_blob_unavailable",
                    "source_blob_invalid",
                    if is_attributes {
                        "source_attributes_limit_exceeded"
                    } else {
                        "source_file_limit_exceeded"
                    },
                    "source_blob_identity_mismatch",
                )?
                .try_into_blob()
                .map_err(|_| "source_blob_invalid")?;
                if is_attributes {
                    validate_managed_attributes_v2(&blob.data)?;
                }
                stats.observe_blob(blob.data.len() as u64, policy)?;
                if let Some(destination) = destination {
                    let copied_blob = destination
                        .write_blob(&blob.data)
                        .map_err(|_| "source_blob_copy_failed")?
                        .detach();
                    if copied_blob != blob_oid {
                        return Err("source_blob_identity_mismatch");
                    }
                }
            }
            _ => return Err("unsupported_source_entry_kind"),
        }
    }
    if let Some(destination) = destination {
        let copied_tree = destination
            .write_object(tree.decode().map_err(|_| "source_tree_invalid")?)
            .map_err(|_| "source_tree_copy_failed")?
            .detach();
        if copied_tree != tree_oid {
            return Err("source_tree_identity_mismatch");
        }
    }
    Ok(())
}

fn compare_git_tree_entry_names(
    left_name: &[u8],
    left_is_tree: bool,
    right_name: &[u8],
    right_is_tree: bool,
) -> std::cmp::Ordering {
    let common = left_name.len().min(right_name.len());
    match left_name[..common].cmp(&right_name[..common]) {
        std::cmp::Ordering::Equal => {
            let left_suffix =
                left_name
                    .get(common)
                    .copied()
                    .unwrap_or(if left_is_tree { b'/' } else { 0 });
            let right_suffix =
                right_name
                    .get(common)
                    .copied()
                    .unwrap_or(if right_is_tree { b'/' } else { 0 });
            left_suffix.cmp(&right_suffix)
        }
        ordering => ordering,
    }
}

fn assert_canonical_tree_modes(mut data: &[u8]) -> Result<(), &'static str> {
    const SHA1_OID_BYTES: usize = 20;

    while !data.is_empty() {
        let mode_end = data
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("source_tree_invalid")?;
        let mode = &data[..mode_end];
        if mode != b"40000" && mode != b"100644" && mode != b"100755" {
            return Err("source_tree_noncanonical_mode");
        }
        data = &data[mode_end + 1..];
        let filename_end = data
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("source_tree_invalid")?;
        data = &data[filename_end + 1..];
        if data.len() < SHA1_OID_BYTES {
            return Err("source_tree_invalid");
        }
        data = &data[SHA1_OID_BYTES..];
    }
    Ok(())
}

fn is_supported_source_component(component: &str) -> bool {
    let folded_component = fold_managed_path_v2(component);
    !component.is_empty()
        && component != "."
        && component != ".."
        && !component.contains('/')
        && !component.contains('\\')
        && !component.contains('\0')
        && !component
            .chars()
            .any(|character| character <= '\u{001f}' || "<>:\"|?*".contains(character))
        && !component.ends_with('.')
        && !component.ends_with(' ')
        && !is_windows_reserved_device_name(component)
        && folded_component != ".git"
        && (component == ".gitattributes" || folded_component != ".gitattributes")
}

fn fold_managed_path_v2(value: &str) -> String {
    value.nfc().default_case_fold().nfc().collect()
}

fn validate_managed_attributes_v2(data: &[u8]) -> Result<(), &'static str> {
    let content = std::str::from_utf8(data).map_err(|_| "unsupported_source_attributes")?;
    for raw_line in content.split('\n') {
        if raw_line.len() >= MAX_GIT_ATTRIBUTES_LINE_BYTES_V2 {
            return Err("unsupported_source_attributes");
        }
        if raw_line.is_empty() {
            continue;
        }
        if let Some(comment) = raw_line.strip_prefix('#') {
            if comment.chars().any(char::is_control) {
                return Err("unsupported_source_attributes");
            }
            continue;
        }
        if raw_line == "* text=auto eol=lf" {
            continue;
        }
        if raw_line
            .strip_suffix(" export-ignore")
            .is_some_and(is_portable_export_ignore_pattern_v2)
        {
            continue;
        }
        return Err("unsupported_source_attributes");
    }
    Ok(())
}

fn is_portable_export_ignore_pattern_v2(pattern: &str) -> bool {
    if !pattern.starts_with('/') || pattern.len() <= 1 || pattern.len() > 4096 {
        return false;
    }
    pattern[1..]
        .split('/')
        .all(is_literal_attributes_component_v2)
}

fn is_literal_attributes_component_v2(component: &str) -> bool {
    !component.is_empty()
        && is_supported_source_component(component)
        && !component.contains(['[', ']'])
        && !component
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

fn is_windows_reserved_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default();
    let folded = stem.to_ascii_uppercase();
    matches!(
        folded.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || folded
        .strip_prefix("COM")
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
        || folded.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || matches!(
            folded.as_str(),
            "COM¹" | "COM²" | "COM³" | "LPT¹" | "LPT²" | "LPT³"
        )
}

#[derive(Clone, Copy)]
struct ManagedTreePolicy {
    max_depth: u64,
    max_tree_visits: u64,
    max_entries: u64,
    max_total_path_bytes: u64,
    max_total_folded_path_bytes: u64,
    max_component_bytes: u64,
    max_relative_path_bytes: u64,
    max_folded_relative_path_bytes: u64,
    max_files: u64,
    max_file_bytes: u64,
    max_bytes: u64,
    max_commit_object_bytes: u64,
    max_single_tree_object_bytes: u64,
    max_total_tree_object_bytes: u64,
}

#[derive(Default)]
struct ManagedTreeStats {
    tree_visits: u64,
    entries: u64,
    total_path_bytes: u64,
    total_folded_path_bytes: u64,
    files: u64,
    bytes: u64,
    tree_object_bytes: u64,
    folded_paths: HashSet<String>,
}

impl ManagedTreeStats {
    fn enter_tree(
        &mut self,
        depth: u64,
        object_bytes: u64,
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
        self.tree_object_bytes = self
            .tree_object_bytes
            .checked_add(object_bytes)
            .filter(|bytes| *bytes <= policy.max_total_tree_object_bytes)
            .ok_or("source_tree_object_byte_limit_exceeded")?;
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
        let folded_path = fold_managed_path_v2(relative_path);
        let folded_path_bytes = folded_path.len() as u64;
        if folded_path_bytes > policy.max_folded_relative_path_bytes {
            return Err("source_folded_path_length_exceeded");
        }
        self.total_folded_path_bytes = self
            .total_folded_path_bytes
            .checked_add(folded_path_bytes)
            .filter(|bytes| *bytes <= policy.max_total_folded_path_bytes)
            .ok_or("source_folded_path_byte_limit_exceeded")?;
        if !self.folded_paths.insert(folded_path) {
            return Err("source_path_collision");
        }
        Ok(())
    }

    fn observe_blob(&mut self, size: u64, policy: ManagedTreePolicy) -> Result<(), &'static str> {
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
            max_total_folded_path_bytes: 5,
            max_component_bytes: 3,
            max_relative_path_bytes: 4,
            max_folded_relative_path_bytes: 4,
            max_files: 1,
            max_file_bytes: 3,
            max_bytes: 3,
            max_commit_object_bytes: 3,
            max_single_tree_object_bytes: 3,
            max_total_tree_object_bytes: 5,
        }
    }

    #[test]
    fn managed_tree_budget_bounds_depth_visits_and_entries() {
        let policy = tiny_policy();
        let mut stats = ManagedTreeStats::default();
        assert_eq!(stats.enter_tree(0, 2, policy), Ok(()));
        assert_eq!(stats.enter_tree(1, 3, policy), Ok(()));
        assert_eq!(
            stats.enter_tree(1, 0, policy),
            Err("source_tree_visit_limit_exceeded")
        );

        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.enter_tree(2, 0, policy),
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
    fn managed_tree_budget_bounds_single_and_total_tree_object_bytes() {
        let policy = tiny_policy();
        let mut stats = ManagedTreeStats::default();
        assert_eq!(stats.enter_tree(0, 3, policy), Ok(()));
        assert_eq!(
            stats.enter_tree(1, 3, policy),
            Err("source_tree_object_byte_limit_exceeded")
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

    #[test]
    fn managed_tree_policy_rejects_non_portable_components() {
        for component in [
            "CON",
            "NUL.txt",
            "COM1.log",
            "LPT9",
            "a:b",
            "control\u{001f}",
            "trailing.",
            "trailing ",
            ".git.",
            ".git ",
            "com¹",
            "lpt².txt",
        ] {
            assert!(
                !is_supported_source_component(component),
                "component must be rejected by portable policy: {component:?}"
            );
        }
    }

    #[test]
    fn managed_tree_policy_uses_full_unicode_casefold_after_nfc() {
        let policy = MANAGED_TREE_POLICY_V2;
        for (first, second) in [
            ("Σ.txt", "ς.txt"),
            ("STRASSE.txt", "Straße.txt"),
            ("é.txt", "e\u{301}.txt"),
        ] {
            let mut stats = ManagedTreeStats::default();
            assert_eq!(stats.observe_entry(first, policy), Ok(()));
            assert_eq!(
                stats.observe_entry(second, policy),
                Err("source_path_collision"),
                "paths must collide under the versioned fold key: {first:?}, {second:?}"
            );
        }
    }

    #[test]
    fn managed_tree_policy_bounds_folded_keys_independently() {
        let policy = ManagedTreePolicy {
            max_relative_path_bytes: 2,
            max_folded_relative_path_bytes: 2,
            ..MANAGED_TREE_POLICY_V2
        };
        let mut stats = ManagedTreeStats::default();
        assert_eq!(
            stats.observe_entry("İ", policy),
            Err("source_folded_path_length_exceeded")
        );

        let policy = ManagedTreePolicy {
            max_total_path_bytes: 3,
            max_total_folded_path_bytes: 3,
            ..MANAGED_TREE_POLICY_V2
        };
        let mut stats = ManagedTreeStats::default();
        assert_eq!(stats.observe_entry("İ", policy), Ok(()));
        assert_eq!(
            stats.observe_entry("A", policy),
            Err("source_folded_path_byte_limit_exceeded")
        );
    }

    #[test]
    fn managed_attributes_v2_accepts_only_the_deterministic_subset() {
        assert_eq!(
            validate_managed_attributes_v2(
                b"# portable Maka attributes\n\n* text=auto eol=lf\n/docs export-ignore\n"
            ),
            Ok(())
        );
        for unsupported in [
            b"*.bin filter=lfs\n".as_slice(),
            b"* working-tree-encoding=UTF-16\n".as_slice(),
            b"* ident\n".as_slice(),
            b"* text=auto eol=crlf\n".as_slice(),
            b"/*.log export-ignore\n".as_slice(),
            b"* text=auto eol=lf unknown\n".as_slice(),
            &[0xff, b'\n'],
        ] {
            assert_eq!(
                validate_managed_attributes_v2(unsupported),
                Err("unsupported_source_attributes")
            );
        }
    }

    #[test]
    fn managed_attributes_v2_rejects_bracket_globs() {
        for unsupported in [
            b"/[ab].txt export-ignore\n".as_slice(),
            b"/file[0-9].txt export-ignore\n".as_slice(),
        ] {
            assert_eq!(
                validate_managed_attributes_v2(unsupported),
                Err("unsupported_source_attributes")
            );
        }
    }

    #[test]
    fn managed_attributes_v2_rejects_non_git_blank_characters() {
        for unsupported in [
            "\u{00a0}* text=auto eol=lf\n".as_bytes(),
            b"\x0b* text=auto eol=lf\n".as_slice(),
            b"\x0c* text=auto eol=lf\n".as_slice(),
        ] {
            assert_eq!(
                validate_managed_attributes_v2(unsupported),
                Err("unsupported_source_attributes")
            );
        }
    }

    #[test]
    fn managed_attributes_v2_matches_gits_line_byte_limit() {
        let accepted = format!("/{} export-ignore", "a".repeat(2032));
        assert_eq!(accepted.len(), 2047);
        assert_eq!(validate_managed_attributes_v2(accepted.as_bytes()), Ok(()));

        let rejected = format!("/{} export-ignore", "a".repeat(2033));
        assert_eq!(rejected.len(), 2048);
        assert_eq!(
            validate_managed_attributes_v2(rejected.as_bytes()),
            Err("unsupported_source_attributes")
        );
    }

    #[test]
    fn managed_attributes_v2_rejects_noncanonical_serializations() {
        for unsupported in [
            b"* eol=lf text=auto\n".as_slice(),
            b" * text=auto eol=lf\n".as_slice(),
            b"*  text=auto eol=lf\n".as_slice(),
            b"* text=auto eol=lf \n".as_slice(),
            b"* text=auto eol=lf\r\n".as_slice(),
            b"/docs  export-ignore\n".as_slice(),
            b" /docs export-ignore\n".as_slice(),
        ] {
            assert_eq!(
                validate_managed_attributes_v2(unsupported),
                Err("unsupported_source_attributes")
            );
        }
    }

    #[test]
    fn canonical_tree_order_uses_gits_directory_suffix_rule() {
        assert_eq!(
            compare_git_tree_entry_names(b"foo", false, b"foo.bar", false),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_git_tree_entry_names(b"foo.bar", false, b"foo", true),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_git_tree_entry_names(b"foo", true, b"foo0", false),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_git_tree_entry_names(b"same", false, b"same", false),
            std::cmp::Ordering::Equal
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
