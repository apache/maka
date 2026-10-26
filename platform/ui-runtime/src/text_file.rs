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

//! A bounded text file explicitly granted by native instance configuration.
//! Commands cannot choose paths. Accepted work drains after the view retires.
use crate::budget::{Kind, NativeBudget, Permit};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use maka_capabilities::call::Resources;
use maka_plugin_core::contract::{Contract, Interface, Transport};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
};

#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileConfiguration {
    #[schemars(length(min = 1))]
    pub path: Option<PathBuf>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileProps {
    pub command: Option<TextFileCommand>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileCommand {
    pub owner: String,
    pub sequence: u64,
    pub operation: TextFileOperation,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum TextFileOperation {
    Read,
    Write {
        #[serde(rename = "expectedDigest")]
        expected_digest: Option<String>,
        text: String,
    },
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileObservation {
    pub owner: String,
    pub path: Option<String>,
    pub sequence: u64,
    pub state: TextFileState,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TextFileState {
    Unavailable,
    Idle,
    Loading,
    Saving,
    Ready {
        digest: Option<String>,
        text: Option<String>,
    },
    Failed {
        error: TextFileError,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TextFileError {
    ReadFailed,
    WriteFailed,
    InvalidFile,
    InvalidUtf8,
    Conflict,
    WorkerFailed,
}
pub fn contract() -> Contract {
    Contract {
        name: "maka.ui.TextFile".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Component {
            props: serde_json::to_value(schemars::schema_for!(TextFileProps))
                .unwrap()
                .into(),
            events: BTreeMap::from([(
                "changed".into(),
                serde_json::to_value(schemars::schema_for!(TextFileObservation))
                    .unwrap()
                    .into(),
            )]),
            captures: BTreeMap::new(),
        },
    }
}
fn read(
    directory: &Dir,
    name: &std::ffi::OsStr,
    budget: &NativeBudget,
) -> Result<(Option<String>, Option<Permit>), TextFileError> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match directory.open_with(name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((None, None)),
        Err(_) => return Err(TextFileError::ReadFailed),
    };
    let metadata = file.metadata().map_err(|_| TextFileError::ReadFailed)?;
    if !metadata.is_file() {
        return Err(TextFileError::InvalidFile);
    }
    let length = usize::try_from(metadata.len()).map_err(|_| TextFileError::WorkerFailed)?;
    let admitted = length
        .checked_add(1)
        .and_then(|n| n.checked_mul(6))
        .ok_or(TextFileError::WorkerFailed)?;
    let mut permit = budget
        .reserve(Kind::Encoded, admitted)
        .map_err(|_| TextFileError::WorkerFailed)?;
    let mut bytes = Vec::with_capacity(length);
    file.take(
        u64::try_from(length)
            .map_err(|_| TextFileError::WorkerFailed)?
            .checked_add(1)
            .ok_or(TextFileError::WorkerFailed)?,
    )
    .read_to_end(&mut bytes)
    .map_err(|_| TextFileError::ReadFailed)?;
    if bytes.len() != length {
        return Err(TextFileError::Conflict);
    }
    let text = String::from_utf8(bytes).map_err(|_| TextFileError::InvalidUtf8)?;
    let encoded = serde_json::to_vec(&text)
        .map_err(|_| TextFileError::WorkerFailed)?
        .len();
    permit.shrink_to(encoded);
    Ok((Some(text), Some(permit)))
}

fn digest(text: Option<&str>) -> Option<String> {
    text.map(|text| format!("sha256:{}", hex::encode(Sha256::digest(text.as_bytes()))))
}
fn perform_admitted(
    path: &Path,
    operation: TextFileOperation,
    budget: &NativeBudget,
) -> Result<(TextFileState, Option<Permit>), TextFileError> {
    if !path.is_absolute() {
        return Err(TextFileError::InvalidFile);
    }
    let parent = path.parent().ok_or(TextFileError::InvalidFile)?;
    let name = path.file_name().ok_or(TextFileError::InvalidFile)?;
    if matches!(operation, TextFileOperation::Write { .. }) {
        std::fs::create_dir_all(parent).map_err(|_| TextFileError::WriteFailed)?;
    }
    let directory = match Dir::open_ambient_dir(parent, ambient_authority()) {
        Ok(directory) => directory,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && matches!(operation, TextFileOperation::Read) =>
        {
            return Ok((
                TextFileState::Ready {
                    digest: None,
                    text: None,
                },
                None,
            ));
        }
        Err(_) => return Err(TextFileError::ReadFailed),
    };
    let (current, mut retained) = read(&directory, name, budget)?;
    let text = match operation {
        TextFileOperation::Read => current,
        TextFileOperation::Write {
            expected_digest,
            text,
        } => {
            if digest(current.as_deref()) != expected_digest {
                return Err(TextFileError::Conflict);
            }
            drop(current);
            retained = None;
            let temporary = format!(".maka-text-{}", uuid::Uuid::new_v4());
            let result = (|| {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use cap_std::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = directory
                    .open_with(&temporary, &options)
                    .map_err(|_| TextFileError::WriteFailed)?;
                file.write_all(text.as_bytes())
                    .and_then(|()| file.sync_all())
                    .map_err(|_| TextFileError::WriteFailed)?;
                // Detect ordinary external edits. This is not an atomic CAS against
                // arbitrary external writers between the check and rename.
                let (checked, _checking) = read(&directory, name, budget)?;
                if digest(checked.as_deref()) != expected_digest {
                    return Err(TextFileError::Conflict);
                }
                directory
                    .rename(&temporary, &directory, name)
                    .map_err(|_| TextFileError::WriteFailed)
            })();
            let _ = directory.remove_file(&temporary);
            result?;
            Some(text)
        }
    };
    Ok((
        TextFileState::Ready {
            digest: digest(text.as_deref()),
            text,
        },
        retained,
    ))
}
struct Reply {
    state: TextFileState,
    _bytes: Vec<Permit>,
}
pub struct TextFile {
    path: Option<PathBuf>,
    resources: Arc<Resources>,
    budget: NativeBudget,
    receiver: Option<mpsc::Receiver<Reply>>,
    bytes: Vec<Permit>,
    current: TextFileObservation,
    announced: Option<TextFileObservation>,
    closed: bool,
}
impl TextFile {
    pub fn new(path: Option<PathBuf>, resources: Arc<Resources>, budget: NativeBudget) -> Self {
        Self {
            current: TextFileObservation {
                owner: uuid::Uuid::new_v4().to_string(),
                path: path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                sequence: 0,
                state: if path.is_some() {
                    TextFileState::Idle
                } else {
                    TextFileState::Unavailable
                },
            },
            path,
            resources,
            budget,
            receiver: None,
            bytes: Vec::new(),
            announced: None,
            closed: false,
        }
    }
    pub fn will_update(&self, props: &TextFileProps) -> bool {
        !self.closed
            && self.path.is_some()
            && props.command.as_ref().is_some_and(|command| {
                command.owner == self.current.owner && command.sequence > self.current.sequence
            })
    }
    pub fn update(&mut self, props: &TextFileProps) {
        let Some(command) = &props.command else {
            return;
        };
        if self.closed
            || self.receiver.is_some()
            || command.owner != self.current.owner
            || command.sequence <= self.current.sequence
        {
            return;
        }
        let Some(path) = self.path.clone() else {
            return;
        };
        self.current.sequence = command.sequence;
        let result = (|| {
            let mut bytes = Vec::new();
            if let TextFileOperation::Write { text, .. } = &command.operation {
                let length = maka_plugin_core::json::encoded_size(text, usize::MAX)
                    .map_err(|_| TextFileError::WorkerFailed)?;
                bytes.push(
                    self.budget
                        .reserve(Kind::Encoded, length)
                        .map_err(|_| TextFileError::WorkerFailed)?,
                );
            }
            let budget = self.budget.clone();
            let mut ticket = self
                .resources
                .reserve()
                .map_err(|_| TextFileError::WorkerFailed)?;
            let operation = command.operation.clone();
            let (sender, receiver) = mpsc::sync_channel(1);
            std::thread::Builder::new()
                .name("native-text-file".into())
                .spawn(move || {
                    ticket.start();
                    let result =
                        std::panic::catch_unwind(|| perform_admitted(&path, operation, &budget));
                    let (state, cleanup) = match result {
                        Ok(Ok((state, retained))) => {
                            bytes.extend(retained);
                            (state, Ok(()))
                        }
                        Ok(Err(error)) => (TextFileState::Failed { error }, Ok(())),
                        Err(_) => (
                            TextFileState::Failed {
                                error: TextFileError::WorkerFailed,
                            },
                            Err("text file worker panicked".into()),
                        ),
                    };
                    let _ = sender.send(Reply {
                        state,
                        _bytes: bytes,
                    });
                    ticket.complete(cleanup);
                })
                .map_err(|_| TextFileError::WorkerFailed)?;
            self.receiver = Some(receiver);
            Ok(if matches!(command.operation, TextFileOperation::Read) {
                TextFileState::Loading
            } else {
                TextFileState::Saving
            })
        })();
        self.current.state = result.unwrap_or_else(|error| TextFileState::Failed { error });
        self.bytes.clear();
    }
    fn poll(&mut self) {
        let Some(receiver) = &self.receiver else {
            return;
        };
        match receiver.try_recv() {
            Ok(reply) => {
                self.current.state = reply.state;
                self.bytes = reply._bytes;
                self.receiver = None;
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                self.current.state = TextFileState::Failed {
                    error: TextFileError::WorkerFailed,
                };
                self.receiver = None;
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
    }
    pub fn observe(&mut self) -> Option<TextFileObservation> {
        self.poll();
        if self.announced.as_ref() == Some(&self.current) {
            return None;
        }
        self.announced = Some(self.current.clone());
        Some(self.current.clone())
    }
    pub fn close(&mut self) {
        self.closed = true;
    }
}

pub const IMPLEMENTATION: &str = "maka.ui.text-file";

pub fn native() -> maka_plugin_core::package::NativeDefinition {
    maka_plugin_core::package::NativeDefinition::new(
        IMPLEMENTATION,
        schemars::schema_for!(TextFileConfiguration).into(),
        [("TextFile", contract())],
    )
}

#[cfg(test)]
mod tests {
    fn perform(
        path: &std::path::Path,
        operation: super::TextFileOperation,
    ) -> Result<super::TextFileState, super::TextFileError> {
        super::perform_admitted(path, operation, &super::NativeBudget::default())
            .map(|(state, _)| state)
    }

    use super::*;
    fn write(expected: Option<&str>, text: &str) -> TextFileOperation {
        TextFileOperation::Write {
            expected_digest: expected.map(str::to_owned),
            text: text.into(),
        }
    }
    #[test]
    fn complete_atomic_replacement_detects_external_changes_and_preserves_original() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested/theme.json");
        assert_eq!(
            perform(&path, TextFileOperation::Read),
            Ok(TextFileState::Ready {
                digest: None,
                text: None
            })
        );
        let original = "{\"name\":\"夜色\"}\n";
        let revision = digest(Some(original)).unwrap();
        assert_eq!(
            perform(&path, write(None, original)),
            Ok(TextFileState::Ready {
                digest: Some(revision.clone()),
                text: Some(original.into())
            })
        );
        std::fs::write(&path, "external").unwrap();
        assert_eq!(
            perform(&path, write(Some(&revision), "replaced")),
            Err(TextFileError::Conflict)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external");
        let external = digest(Some("external")).unwrap();
        let exact = "色😀".repeat(4000) + "COMPLETE END";
        assert!(exact.len() > 16 * 1024);
        assert!(perform(&path, write(Some(&external), &exact)).is_ok());
        assert_eq!(
            perform(&path, write(Some(&external), &(exact.clone() + "x"))),
            Err(TextFileError::Conflict)
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), exact);
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
    }
    #[test]
    fn reads_reject_non_regular_files_and_invalid_utf8_without_following_links() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("file");
        std::fs::write(&path, [255]).unwrap();
        assert_eq!(
            perform(&path, TextFileOperation::Read),
            Err(TextFileError::InvalidUtf8)
        );
        assert_eq!(
            perform(directory.path(), TextFileOperation::Read),
            Err(TextFileError::InvalidFile)
        );
        assert_eq!(
            perform(Path::new("relative"), TextFileOperation::Read),
            Err(TextFileError::InvalidFile)
        );
        #[cfg(unix)]
        {
            let link = directory.path().join("link");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert!(perform(&link, TextFileOperation::Read).is_err());
            assert!(perform(&link, write(None, "overwrite")).is_err());
            std::fs::remove_file(&path).unwrap();
            assert!(perform(&link, write(None, "overwrite")).is_err());
            assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
            let fifo = directory.path().join("fifo");
            let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            assert_eq!(
                perform(&fifo, TextFileOperation::Read),
                Err(TextFileError::InvalidFile)
            );
        }
    }
    #[tokio::test]
    async fn admitted_write_drains_after_original_owner_retires_and_budget_failure_never_writes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("theme.json");
        let resources = Arc::new(Resources::default());
        let budget = NativeBudget::default();
        let mut owner = TextFile::new(Some(path.clone()), resources.clone(), budget.clone());
        let mut command = TextFileCommand {
            owner: "other-owner".into(),
            sequence: 1,
            operation: write(None, "accepted"),
        };
        owner.update(&TextFileProps {
            command: Some(command.clone()),
        });
        assert_eq!(owner.observe().unwrap().state, TextFileState::Idle);
        command.owner = owner.current.owner.clone();
        owner.update(&TextFileProps {
            command: Some(command.clone()),
        });
        owner.close();
        command.sequence += 1;
        command.operation = write(None, "late");
        owner.update(&TextFileProps {
            command: Some(command),
        });
        drop(owner);
        resources.finish().await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "accepted");
        assert_eq!(budget.usage(), (0, 0, 0));
        let budget = NativeBudget::new(crate::budget::BudgetLimits {
            encoded_bytes: 1,
            ..Default::default()
        });
        let resources = Arc::new(Resources::default());
        let mut owner = TextFile::new(Some(path.clone()), resources.clone(), budget.clone());
        owner.update(&TextFileProps {
            command: Some(TextFileCommand {
                owner: owner.current.owner.clone(),
                sequence: 1,
                operation: write(digest(Some("accepted")).as_deref(), "denied"),
            }),
        });
        assert_eq!(
            owner.observe().unwrap().state,
            TextFileState::Failed {
                error: TextFileError::WorkerFailed
            }
        );
        resources.finish().await.unwrap();
        assert_eq!(budget.usage(), (0, 0, 0));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "accepted");
    }
}
