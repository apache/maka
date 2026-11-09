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

use crate::{
    ReadScope, failed,
    mutation::{EDIT_NAME, Mutation, WRITE_NAME},
    scoped::Authority,
};
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

/// Explicit trusted write grant, independent of ReadScope.
pub enum WriteScope {
    Disabled,
    Restricted { roots: Vec<PathBuf> },
    Policy(Arc<maka_sandbox::filesystem::Compiled>),
    Unrestricted,
}

/// Host-owned serialization shared by every write-capable run.
#[derive(Default)]
pub struct WriteCoordinator {
    pub(crate) mutation: Mutex<()>,
    #[cfg(test)]
    after_capture: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub struct MutationExecutor {
    authority: Option<Arc<Authority>>,
    coordinator: Arc<WriteCoordinator>,
}

enum Request {
    File(Mutation),
    Patch(crate::patch::Batch),
}

/// Validate the same input accepted by the executor and describe its exact
/// target names. This performs no mutation and grants no filesystem authority.
pub fn mutation_paths(name: &str, input: Value, cwd: &Path) -> Result<Vec<PathBuf>, ToolError> {
    let paths = if name == crate::patch::PATCH_NAME {
        crate::patch::Batch::parse(input)?
            .paths()
            .map(Path::to_owned)
            .collect::<Vec<_>>()
    } else {
        vec![PathBuf::from(Mutation::parse(name, input)?.path())]
    };
    let authority = Authority::new(cwd, ReadScope::Unrestricted)?;
    paths
        .into_iter()
        .map(|path| {
            if path
                .components()
                .any(|part| part == std::path::Component::ParentDir)
            {
                return Err(failed("Write does not support parent (..) path components"));
            }
            authority.write_display_path(&path).map(PathBuf::from)
        })
        .collect()
}

impl MutationExecutor {
    /// Retain the selected directory. A supplied policy also governs external
    /// paths; without one, the directory is the entire write grant.
    pub fn from_directory(
        path: std::path::PathBuf,
        directory: cap_std::fs::Dir,
        coordinator: Arc<WriteCoordinator>,
        policy: Option<Arc<maka_sandbox::filesystem::Compiled>>,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            authority: Some(Arc::new(Authority::from_directory(
                path, directory, policy,
            )?)),
            coordinator,
        })
    }
    pub fn new(
        cwd: impl AsRef<Path>,
        scope: WriteScope,
        coordinator: Arc<WriteCoordinator>,
    ) -> Result<Self, ToolError> {
        let read_scope = match scope {
            WriteScope::Disabled => None,
            WriteScope::Restricted { roots } => Some(ReadScope::Restricted { roots }),
            WriteScope::Policy(policy) => Some(ReadScope::Policy(policy)),
            WriteScope::Unrestricted => Some(ReadScope::Unrestricted),
        };
        Ok(Self {
            // Reuse capture mechanics only; the caller supplied a distinct write grant.
            authority: read_scope
                .map(|scope| Authority::new(cwd.as_ref(), scope).map(Arc::new))
                .transpose()?,
            coordinator,
        })
    }
}

impl MutationExecutor {
    pub fn publish_change(
        &self,
        change: crate::publication::PublicationChange,
        source: crate::publication::SourceIdentity,
        content: Option<Box<dyn crate::publication::PublicationContent>>,
        cancellation: CancellationToken,
    ) -> ToolFuture<crate::publication::PublicationResult> {
        let authority = self.authority.clone();
        let coordinator = self.coordinator.clone();
        Box::pin(async move {
            let authority = authority.ok_or_else(|| failed("Write authority is disabled"))?;
            let started = Arc::new(AtomicBool::new(false));
            let worker_started = started.clone();
            tokio::task::spawn_blocking(move || {
                crate::publication::run(
                    &authority,
                    &coordinator,
                    change,
                    source,
                    content,
                    &cancellation,
                    &worker_started,
                )
            })
            .await
            .map_err(|error| {
                if started.load(Ordering::SeqCst) {
                    ToolError::OutcomeUnknown(format!(
                        "publication worker failed after mutation started: {error}"
                    ))
                } else {
                    failed(format!(
                        "publication worker failed before mutation: {error}"
                    ))
                }
            })?
        })
    }
}

impl ToolExecutor for MutationExecutor {
    fn names(&self) -> Vec<String> {
        if self.authority.is_some() {
            vec![
                WRITE_NAME.into(),
                EDIT_NAME.into(),
                crate::patch::PATCH_NAME.into(),
            ]
        } else {
            vec![]
        }
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let authority = self.authority.clone();
        let coordinator = self.coordinator.clone();
        Box::pin(async move {
            let authority = authority.ok_or_else(|| failed("Write authority is disabled"))?;
            let input = if name == crate::patch::PATCH_NAME {
                Request::Patch(crate::patch::Batch::parse(input)?)
            } else {
                Request::File(Mutation::parse(&name, input)?)
            };
            let started = Arc::new(AtomicBool::new(false));
            let worker_started = started.clone();
            // The worker owns the lock and must be joined even after cancellation.
            tokio::task::spawn_blocking(move || match input {
                Request::File(input) => {
                    let output_path = authority.write_display_path(Path::new(input.path()))?;
                    run(
                        &authority,
                        &coordinator,
                        input,
                        &output_path,
                        &cancellation,
                        &worker_started,
                    )
                }
                Request::Patch(input) => crate::patch::run(
                    &authority,
                    &coordinator,
                    input,
                    &cancellation,
                    &worker_started,
                ),
            })
            .await
            .map_err(|error| {
                if started.load(Ordering::SeqCst) {
                    ToolError::OutcomeUnknown(format!(
                        "Write worker failed after mutation started: {error}"
                    ))
                } else {
                    failed(format!("Write worker failed before mutation: {error}"))
                }
            })?
        })
    }
}

fn run(
    authority: &Authority,
    coordinator: &WriteCoordinator,
    input: Mutation,
    output_path: &str,
    cancellation: &CancellationToken,
    started: &AtomicBool,
) -> Result<Value, ToolError> {
    check_cancelled(cancellation)?;
    let mut target = crate::write_target::Target::capture(
        authority,
        Path::new(input.path()),
        if input.needs_read() {
            crate::write_target::ReadMode::Required
        } else {
            crate::write_target::ReadMode::Preview
        },
    )?;
    #[cfg(test)]
    if let Some(hook) = coordinator.after_capture.lock().unwrap().take() {
        hook();
    }
    let _guard = coordinator
        .mutation
        .lock()
        .map_err(|_| failed("Write coordinator poisoned"))?;
    check_cancelled(cancellation)?;
    let (content, result) = target.prepare(input, output_path, cancellation)?;
    target.apply(content.as_bytes(), cancellation, started)?;
    Ok(result)
}

pub(crate) fn check_cancelled(token: &CancellationToken) -> Result<(), ToolError> {
    if token.is_cancelled() {
        Err(failed("Write cancelled before mutation"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::mpsc};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_existing_and_missing_reject_replacement_and_cancel() {
        for (initial, name) in [
            (false, WRITE_NAME),
            (true, WRITE_NAME),
            (false, EDIT_NAME),
            (true, EDIT_NAME),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let path = root.join("file");
            if initial {
                fs::write(&path, "original").unwrap();
            }
            let coordinator = Arc::new(WriteCoordinator::default());
            let executor = MutationExecutor::new(
                &root,
                WriteScope::Restricted {
                    roots: vec![root.clone()],
                },
                coordinator.clone(),
            )
            .unwrap();
            let guard = coordinator.mutation.lock().unwrap();
            let (sent, captured) = mpsc::channel();
            *coordinator.after_capture.lock().unwrap() =
                Some(Box::new(move || sent.send(()).unwrap()));
            let task = tokio::spawn(executor.invoke(
                name.into(),
                arguments(name, "original"),
                CancellationToken::new(),
            ));
            captured
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            if initial {
                fs::rename(&path, root.join("old")).unwrap();
            }
            fs::write(&path, "replacement").unwrap();
            drop(guard);
            assert!(matches!(task.await.unwrap(), Err(ToolError::Failed(_))));
            assert_eq!(fs::read(&path).unwrap(), b"replacement");
            if initial {
                assert_eq!(fs::read(root.join("old")).unwrap(), b"original");
            }

            let guard = coordinator.mutation.lock().unwrap();
            let (sent, captured) = mpsc::channel();
            *coordinator.after_capture.lock().unwrap() =
                Some(Box::new(move || sent.send(()).unwrap()));
            let token = CancellationToken::new();
            let task = tokio::spawn(executor.invoke(
                name.into(),
                arguments(name, "replacement"),
                token.clone(),
            ));
            captured
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            token.cancel();
            drop(guard);
            assert!(matches!(task.await.unwrap(), Err(ToolError::Failed(_))));
            assert_eq!(fs::read(&path).unwrap(), b"replacement");
        }
    }

    fn arguments(name: &str, old: &str) -> Value {
        if name == WRITE_NAME {
            json!({"path":"file","content":"tool"})
        } else {
            json!({"path":"file","old_string":old,"new_string":"tool"})
        }
    }
}
