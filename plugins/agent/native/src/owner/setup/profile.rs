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

//! Private HOME data belongs to this Root and the actual captured provider.
use crate::owner::Owner;
use maka_agent_authority::setup::Error;
use maka_agent_facts::durable::ContentRef;
use maka_event_log::{
    EventLog, StoreError,
    connection::Query,
    content,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use maka_host_runtime::{
    application::{Binding, Context},
    storage::{StateChange, instance_prefix},
};
use maka_plugin_core::{
    composition::InstanceId, operation::RecoveryRef, package::PackageRef, scope::Scope,
    storage::Namespace, work::resources::Resources,
};
use maka_process::isolated::{self, FrozenHome, HomeCapture, HomeEntry, HomeEntryKind, TaskOwner};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Read, Seek, Write},
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};
use tempfile::TempDir;

const VERSION: u32 = 1;
const MANIFEST: &str = "manifest.jsonl";
const BUFFER: usize = 64 * 1024;

#[derive(Clone)]
pub(crate) struct ProfileBroker {
    actual: Arc<ActualProfile>,
}
struct ActualProfile {
    owner: Weak<Owner>,
    writer: DataWriter,
    binding: Binding,
    namespace: Namespace,
    key: String,
    provider: Provider,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provider {
    namespace: InstanceId,
    export: String,
    package: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selector {
    schema_version: u32,
    provider: Provider,
    // Provenance is not a replacement activation or a profile grant.
    package: PackageRef,
    basis: String,
    manifest: ContentRef,
    entries: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    relative_path: PathBuf,
    mode: u32,
    kind: Kind,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Kind {
    File { content: ContentRef },
    Directory,
    Symlink { target: PathBuf },
}

pub(crate) struct SeededProfile {
    actual: Arc<ActualProfile>,
    capture: HomeCapture,
    revision: Option<u64>,
}
impl SeededProfile {
    pub(crate) fn owns(&self, home: &FrozenHome) -> bool {
        self.capture.owns(home)
    }
}

pub(crate) struct PreparedProfile {
    actual: Arc<ActualProfile>,
    original: RecoveryRef,
    resources: Arc<Resources>,
    expected_revision: Option<u64>,
    selector: Selector,
    body: Arc<PreparedHome>,
}
struct PreparedHome {
    home: FrozenHome,
    regular_files: NonZeroU64,
    manifest: Mutex<File>,
    _directory: TempDir,
}

impl ProfileBroker {
    pub(crate) fn new(owner: &Arc<Owner>, binding: &Binding) -> Result<Self, Error> {
        let captured = owner
            .services
            .imports()
            .flat_map(|(_, bindings)| bindings)
            .any(|actual| {
                actual.consumer() == binding.consumer()
                    && actual.provider() == binding.provider()
                    && actual.registration_epoch() == binding.registration_epoch()
                    && actual.export() == binding.export()
            });
        if !captured
            || binding.consumer().instance() != &owner.data_source.namespace
            || binding.contract() != &maka_agent_api::executor::setup::contract()
        {
            return Err(Error::Invalid(
                "profile requires the actual captured setup provider".into(),
            ));
        }
        let writer = owner.store.data_writer().map_err(persistence)?;
        let provider = Provider {
            namespace: binding.provider().instance().clone(),
            export: binding.export().into(),
            package: binding.package().id.clone(),
        };
        let prefix = instance_prefix(
            &owner.data_source.state_domain,
            owner.data_source.deployment,
            &owner.data_source.namespace,
        );
        let digest = Sha256::digest(serde_json::to_vec(&provider).map_err(persistence)?);
        let key = format!("{prefix}executor-profile/{}", hex::encode(digest));
        let namespace = Namespace::new("maka.agent", Scope::Profile).map_err(persistence)?;
        Ok(Self {
            actual: Arc::new(ActualProfile {
                owner: Arc::downgrade(owner),
                writer,
                binding: binding.clone(),
                namespace,
                key,
                provider,
            }),
        })
    }

    fn current(&self) -> Result<Arc<Owner>, Error> {
        let owner = self.actual.owner.upgrade().ok_or(Error::Retired)?;
        if owner.stop.is_cancelled() {
            return Err(Error::Retired);
        }
        if !self
            .actual
            .writer
            .same_root(&owner.store.data_writer().map_err(persistence)?)
        {
            return Err(Error::Invalid(
                "profile belongs to another original Root".into(),
            ));
        }
        Ok(owner)
    }
    fn top(&self, top: &Context) -> Result<RecoveryRef, Error> {
        let owner = self.current()?;
        let original = top.operation().ok_or_else(|| {
            Error::Invalid("profile completion requires the original mutation".into())
        })?;
        if top.scope().cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if !matches!(
            top.scope().identity,
            maka_capabilities::call::Identity::Remote { .. }
        ) || top.work_custody().is_some()
            || top
                .operation_scope()
                .is_none_or(|scope| scope.reference() != original)
            || original.namespace != owner.data_source.namespace
            || original.source.state_domain != owner.data_source.state_domain
            || original.source.deployment != owner.data_source.deployment
        {
            return Err(Error::Invalid(
                "profile completion lacks its actual top-level Root source".into(),
            ));
        }
        Ok(original.clone())
    }

    pub(crate) async fn stage_frozen_home(
        &self,
        top: &Context,
        seeded: &SeededProfile,
        home: FrozenHome,
    ) -> Result<PreparedProfile, Error> {
        let original = self.top(top)?;
        if !Arc::ptr_eq(&self.actual, &seeded.actual) || !seeded.owns(&home) {
            return Err(Error::Invalid(
                "setup HOME differs from its original seeded profile".into(),
            ));
        }
        let expected_revision = seeded.revision;
        let resources = top.scope().resources.clone();
        let owner = self.current()?;
        let root = owner.store.owned_root().map_err(persistence)?;
        let root_path = root.canonical_path().to_owned();
        let actual = self.actual.clone();
        let mut ticket = resources.reserve().map_err(persistence)?;
        ticket.start();
        let (body, manifest, entries) = tokio::task::spawn_blocking(move || {
            let result = stage(home, &root_path);
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(persistence)?
        .map_err(persistence)?;
        self.top(top)?;
        Ok(PreparedProfile {
            original,
            resources,
            expected_revision,
            selector: Selector {
                schema_version: VERSION,
                provider: actual.provider.clone(),
                package: actual.binding.package().clone(),
                basis: actual.binding.execution_basis().into(),
                manifest,
                entries,
            },
            body: Arc::new(body),
            actual,
        })
    }

    pub(crate) fn prepare_selector(
        &self,
        top: &Context,
        prepared: PreparedProfile,
    ) -> Result<StateChange, Error> {
        let original = self.top(top)?;
        if !Arc::ptr_eq(&self.actual, &prepared.actual)
            || prepared.original != original
            || !Arc::ptr_eq(&prepared.resources, &top.scope().resources)
        {
            return Err(Error::Invalid(
                "prepared profile differs from its original setup source".into(),
            ));
        }
        top.prepare_statement(&self.actual.writer, PublishProfile { prepared })
            .map_err(persistence)
    }

    pub(crate) async fn seed_current_profile(&self, task: TaskOwner) -> Result<TaskOwner, Error> {
        self.seed_setup_profile(task)
            .await
            .map(|(task, _seeded)| task)
    }

    pub(crate) async fn seed_setup_profile(
        &self,
        mut task: TaskOwner,
    ) -> Result<(TaskOwner, SeededProfile), Error> {
        let owner = self.current()?;
        let root = owner.store.owned_root().map_err(persistence)?;
        let path = root.canonical_path().to_owned();
        let directory = tokio::task::spawn_blocking(move || {
            tempfile::Builder::new()
                .prefix("executor-profile-read-")
                .tempdir_in(path)
        })
        .await
        .map_err(persistence)?
        .map_err(persistence)?;
        let seeded = self
            .actual
            .writer
            .query(Materialize {
                actual: self.actual.clone(),
                directory,
            })
            .await
            .map_err(persistence)?;
        self.current()?;
        let revision = seeded.revision;
        if let Some(material) = seeded.material {
            task = tokio::task::spawn_blocking(move || {
                let entries = SeedEntries {
                    records: BufReader::new(material.manifest),
                    directory: material.directory,
                    index: 0,
                };
                task.seed_home(entries).map_err(persistence)?;
                Ok::<_, Error>(task)
            })
            .await
            .map_err(persistence)??;
        }
        let capture = task.home_capture();
        Ok((
            task,
            SeededProfile {
                actual: self.actual.clone(),
                capture,
                revision,
            },
        ))
    }
}

fn stage(home: FrozenHome, root: &Path) -> Result<(PreparedHome, ContentRef, u64), StoreError> {
    let directory = tempfile::Builder::new()
        .prefix("executor-profile-stage-")
        .tempdir_in(root)?;
    let path = directory.path().join(MANIFEST);
    let mut writer = BufWriter::new(create(&path)?);
    let mut entries = 0u64;
    let mut regular_files = 0u64;
    for entry in home.entries().map_err(isolation)? {
        let entry = entry.map_err(isolation)?;
        let kind = match entry.kind {
            HomeEntryKind::File { mut file } => {
                regular_files = regular_files
                    .checked_add(1)
                    .ok_or_else(|| invalid("profile regular-file count overflow"))?;
                Kind::File {
                    content: hash(&mut file)?,
                }
            }
            HomeEntryKind::Directory => Kind::Directory,
            HomeEntryKind::Symlink { target } => Kind::Symlink { target },
        };
        serde_json::to_writer(
            &mut writer,
            &Entry {
                relative_path: entry.relative_path,
                mode: entry.mode,
                kind,
            },
        )?;
        writer.write_all(b"\n")?;
        entries = entries
            .checked_add(1)
            .ok_or_else(|| invalid("profile entry count overflow"))?;
    }
    let regular_files = NonZeroU64::new(regular_files)
        .ok_or_else(|| invalid("private HOME contains no regular-file persistence material"))?;
    writer.flush()?;
    drop(writer);
    let mut manifest = readonly(&path)?;
    let reference = hash(&mut manifest)?;
    manifest.rewind()?;
    Ok((
        PreparedHome {
            home,
            regular_files,
            manifest: Mutex::new(manifest),
            _directory: directory,
        },
        reference,
        entries,
    ))
}

struct PublishProfile {
    prepared: PreparedProfile,
}
impl Statement for PublishProfile {
    type Value = ();
    type Output = ();
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![self.prepared.body.clone()]
    }
    fn execute(self, connection: &Connection) -> Result<Prepared<()>, StoreError> {
        self.publish(connection).map_err(|cause| match cause {
            cause @ (StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_)) => {
                StoreError::CompletionUnresolved {
                    cause: Arc::new(cause),
                }
            }
            cause => cause,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error, StoreError::CompletionUnresolved { cause }
            if matches!(cause.as_ref(), StoreError::RevisionConflict { .. } | StoreError::InvalidTransition(_)))
    }
}
impl PublishProfile {
    fn publish(self, connection: &Connection) -> Result<Prepared<()>, StoreError> {
        let prepared = self.prepared;
        let actual = &prepared.actual;
        let current =
            EventLog::read_plugin_data_in_transaction(connection, &actual.namespace, &actual.key)?;
        let revision = current.as_ref().map(|record| record.revision);
        if revision != prepared.expected_revision {
            return Err(StoreError::RevisionConflict {
                expected: format!("{:?}", prepared.expected_revision),
                actual: format!("{revision:?}"),
            });
        }
        let revision = revision
            .unwrap_or(0)
            .checked_add(1)
            .filter(|revision| *revision < (1 << 53))
            .ok_or_else(|| invalid("profile selector revision exhausted"))?;
        let mut manifest = prepared
            .body
            .manifest
            .lock()
            .map_err(|_| invalid("profile manifest owner poisoned"))?;
        manifest.rewind()?;
        let mut source = prepared.body.home.entries().map_err(isolation)?;
        let mut count = 0u64;
        let mut regular_files = 0u64;
        for line in BufReader::new(&mut *manifest).lines() {
            let record: Entry = serde_json::from_str(&line?)?;
            let entry = source
                .next()
                .ok_or_else(|| invalid("original frozen HOME inventory ended early"))?
                .map_err(isolation)?;
            if record.relative_path != entry.relative_path || record.mode != entry.mode {
                return Err(invalid("original frozen HOME inventory changed"));
            }
            match (record.kind, entry.kind) {
                (Kind::File { content }, HomeEntryKind::File { mut file }) => {
                    regular_files = regular_files
                        .checked_add(1)
                        .ok_or_else(|| invalid("profile regular-file count overflow"))?;
                    content::put_stream(connection, &content.digest, content.bytes, &mut file)?;
                }
                (Kind::Directory, HomeEntryKind::Directory) => {}
                (Kind::Symlink { target: a }, HomeEntryKind::Symlink { target: b }) if a == b => {}
                _ => return Err(invalid("original frozen HOME entry changed type")),
            }
            count += 1;
        }
        if count != prepared.selector.entries
            || regular_files != prepared.body.regular_files.get()
            || source.next().is_some()
        {
            return Err(invalid("original frozen HOME inventory length changed"));
        }
        manifest.rewind()?;
        content::put_stream(
            connection,
            &prepared.selector.manifest.digest,
            prepared.selector.manifest.bytes,
            &mut *manifest,
        )?;
        let value = serde_json::to_string(&prepared.selector)?;
        connection.execute("INSERT INTO plugin_data(package_id,scope_id,key,revision,value_json) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(package_id,scope_id,key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", params![actual.namespace.package(), String::from(actual.namespace.scope().clone()), actual.key, revision as i64, value])?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA,
        })
    }
}

struct Materialize {
    actual: Arc<ActualProfile>,
    directory: TempDir,
}
struct SeedMaterial {
    directory: TempDir,
    manifest: File,
}
struct SeedRead {
    revision: Option<u64>,
    material: Option<SeedMaterial>,
}
impl Query for Materialize {
    type Output = SeedRead;
    fn execute(self, connection: &Connection) -> Result<Self::Output, StoreError> {
        let record = EventLog::read_plugin_data_in_transaction(
            connection,
            &self.actual.namespace,
            &self.actual.key,
        )?;
        let revision = record.as_ref().map(|record| record.revision);
        let Some(value) = record.as_ref().and_then(|record| record.data.value()) else {
            return Ok(SeedRead {
                revision,
                material: None,
            });
        };
        let selector: Selector = serde_json::from_value(value.clone())?;
        if selector.schema_version != VERSION || selector.provider != self.actual.provider {
            return Err(invalid(
                "current profile selector differs from the actual provider",
            ));
        }
        let path = self.directory.path().join(MANIFEST);
        let mut manifest = create(&path)?;
        copy_content(connection, &selector.manifest, &mut manifest)?;
        drop(manifest);
        let manifest = readonly(&path)?;
        let mut count = 0u64;
        for line in BufReader::new(&manifest).lines() {
            let record: Entry = serde_json::from_str(&line?)?;
            if let Kind::File { content } = record.kind {
                let mut file = create(&self.directory.path().join(count.to_string()))?;
                copy_content(connection, &content, &mut file)?;
            }
            count = count
                .checked_add(1)
                .ok_or_else(|| invalid("profile entry count overflow"))?;
        }
        if count != selector.entries {
            return Err(invalid("current profile inventory length differs"));
        }
        let mut manifest = manifest;
        manifest.rewind()?;
        Ok(SeedRead {
            revision,
            material: Some(SeedMaterial {
                directory: self.directory,
                manifest,
            }),
        })
    }
}
struct SeedEntries {
    records: BufReader<File>,
    directory: TempDir,
    index: u64,
}
impl Iterator for SeedEntries {
    type Item = Result<HomeEntry, isolated::Error>;
    fn next(&mut self) -> Option<Self::Item> {
        let mut line = String::new();
        match self.records.read_line(&mut line) {
            Ok(0) => return None,
            Err(error) => return Some(Err(error.into())),
            Ok(_) => {}
        }
        let result = (|| {
            let record: Entry = serde_json::from_str(&line).map_err(io::Error::other)?;
            let kind = match record.kind {
                Kind::File { .. } => HomeEntryKind::File {
                    file: readonly(&self.directory.path().join(self.index.to_string()))?,
                },
                Kind::Directory => HomeEntryKind::Directory,
                Kind::Symlink { target } => HomeEntryKind::Symlink { target },
            };
            self.index += 1;
            Ok(HomeEntry {
                relative_path: record.relative_path,
                mode: record.mode,
                kind,
            })
        })();
        Some(result.map_err(isolated::Error::Io))
    }
}

fn create(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}
fn readonly(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}
fn hash(file: &mut File) -> io::Result<ContentRef> {
    file.rewind()?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0; BUFFER];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("profile content length overflow"))?;
    }
    Ok(ContentRef {
        digest: format!("sha256:{}", hex::encode(digest.finalize())),
        bytes,
    })
}
fn copy_content(
    connection: &Connection,
    reference: &ContentRef,
    output: &mut File,
) -> Result<(), StoreError> {
    reference.validate().map_err(invalid)?;
    let row: Option<(i64, i64)> = connection
        .query_row(
            "SELECT id,length(payload) FROM contents WHERE content_sha256=?1",
            [&reference.digest],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (id, length) =
        row.ok_or_else(|| invalid("current profile immutable content is missing"))?;
    if u64::try_from(length).ok() != Some(reference.bytes) {
        return Err(invalid("current profile content length differs"));
    }
    let mut blob = connection.blob_open("main", "contents", "payload", id, true)?;
    let result = (|| {
        let mut buffer = [0; BUFFER];
        let mut digest = Sha256::new();
        let mut bytes = 0u64;
        loop {
            let count = blob.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
            bytes += count as u64;
        }
        if bytes != reference.bytes
            || format!("sha256:{}", hex::encode(digest.finalize())) != reference.digest
        {
            return Err(invalid("current profile immutable content digest differs"));
        }
        Ok(())
    })();
    match (result, blob.close()) {
        (result, Ok(())) => result,
        (Ok(()), Err(error)) => Err(error.into()),
        (Err(stream), Err(close)) => Err(io::Error::other(format!(
            "{stream}; closing original profile Blob also failed: {close}"
        ))
        .into()),
    }
}
fn isolation(error: isolated::Error) -> StoreError {
    io::Error::other(error).into()
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
fn persistence(error: impl std::fmt::Display) -> Error {
    Error::Provider(format!(
        "Private credential profile persistence unavailable: {error}"
    ))
}
