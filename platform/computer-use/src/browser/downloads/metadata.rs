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

//! ChatGPT extension download metadata and its URL-first completion association.

use super::*;
use cua_driver_core::browser::{
    ExtensionBrowserProvider, ExtensionDownloadMetadata, ExtensionDownloadStatus,
    ExtensionProviderEvent,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::JoinHandle;

#[derive(Default)]
struct MetadataState {
    filenames: HashMap<String, String>,
    watches: HashMap<uuid::Uuid, Arc<CompletionState>>,
    disconnected: Option<ToolError>,
}

/// Filename observations are global provider metadata, never file capabilities.
#[derive(Clone)]
pub(in crate::browser) struct Metadata {
    scope: uuid::Uuid,
    state: Arc<Mutex<MetadataState>>,
    commands: mpsc::UnboundedSender<ObserverCommand>,
}

enum ObserverCommand {
    Barrier(oneshot::Sender<()>),
    Refresh,
}

pub(super) struct MetadataOwner {
    metadata: Metadata,
    worker: JoinHandle<()>,
    closed: bool,
}

struct CompletionInner {
    first_id: Option<String>,
    result: Option<Result<ExtensionDownloadMetadata, ToolError>>,
}

struct CompletionState {
    url: String,
    inner: Mutex<CompletionInner>,
    changed: Notify,
    timeout: Duration,
    deadline: tokio::time::Instant,
}

/// This is the original URL-first extension-ID association, not a tab ownership proof.
pub(super) struct Completion {
    id: uuid::Uuid,
    metadata: Metadata,
    state: Arc<CompletionState>,
}

impl CompletionState {
    fn observe(&self, download: &ExtensionDownloadMetadata) {
        let mut inner = self
            .inner
            .lock()
            .expect("download completion lock poisoned");
        if inner.result.is_some() {
            return;
        }
        match inner.first_id.as_deref() {
            None => {
                if download.status == ExtensionDownloadStatus::Started && download.url == self.url {
                    inner.first_id = Some(download.id.clone());
                    self.changed.notify_waiters();
                }
            }
            Some(id) if id == download.id => {
                inner.result = match download.status {
                    ExtensionDownloadStatus::Started | ExtensionDownloadStatus::InProgress => None,
                    ExtensionDownloadStatus::Complete => Some(Ok(download.clone())),
                    ExtensionDownloadStatus::Failed => {
                        Some(Err(failed(format!("Download {} failed.", download.id))))
                    }
                    ExtensionDownloadStatus::Canceled => Some(Err(failed(format!(
                        "Download {} was canceled.",
                        download.id
                    )))),
                };
                if inner.result.is_some() {
                    self.changed.notify_waiters();
                }
            }
            Some(_) => {}
        }
    }

    fn fail(&self, error: ToolError) {
        let mut inner = self
            .inner
            .lock()
            .expect("download completion lock poisoned");
        if inner.result.is_none() {
            inner.result = Some(Err(error));
            self.changed.notify_waiters();
        }
    }
}

impl Metadata {
    pub(in crate::browser) fn scope(&self) -> String {
        self.scope.to_string()
    }

    fn observe(&self, event: ExtensionProviderEvent) {
        match event {
            ExtensionProviderEvent::DownloadChanged { download } => {
                let watches = {
                    let mut state = self.state.lock().expect("download metadata lock poisoned");
                    // Cache before notifying completion, including empty extension filenames.
                    state
                        .filenames
                        .insert(download.id.clone(), download.filename.clone());
                    state.watches.values().cloned().collect::<Vec<_>>()
                };
                for watch in watches {
                    watch.observe(&download);
                }
            }
            ExtensionProviderEvent::GenerationClosed { reason } => {
                self.fail_current(
                    unknown(format!(
                        "Extension download metadata disconnected: {reason}"
                    )),
                    true,
                );
            }
            _ => {}
        }
    }

    fn next_deadline(&self) -> Option<tokio::time::Instant> {
        let watches = self
            .state
            .lock()
            .expect("download metadata lock poisoned")
            .watches
            .values()
            .cloned()
            .collect::<Vec<_>>();
        watches
            .into_iter()
            .filter_map(|watch| {
                let inner = watch
                    .inner
                    .lock()
                    .expect("download completion lock poisoned");
                (inner.result.is_none() && inner.first_id.is_none()).then_some(watch.deadline)
            })
            .min()
    }

    fn expire(&self) {
        let watches = self
            .state
            .lock()
            .expect("download metadata lock poisoned")
            .watches
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let now = tokio::time::Instant::now();
        for watch in watches {
            let mut inner = watch
                .inner
                .lock()
                .expect("download completion lock poisoned");
            if inner.result.is_none() && inner.first_id.is_none() && now >= watch.deadline {
                inner.result = Some(Err(failed(format!(
                    "Timed out after {}ms waiting for download.",
                    watch.timeout.as_millis()
                ))));
                watch.changed.notify_waiters();
            }
        }
    }

    fn fail_current(&self, error: ToolError, disconnected: bool) {
        let watches = {
            let mut state = self.state.lock().expect("download metadata lock poisoned");
            if disconnected {
                state.disconnected = Some(error.clone());
            }
            state.watches.values().cloned().collect::<Vec<_>>()
        };
        for watch in watches {
            watch.fail(error.clone());
        }
    }

    pub(super) fn path(&self, extension_id: &str) -> Option<String> {
        self.state
            .lock()
            .expect("download metadata lock poisoned")
            .filenames
            .get(extension_id)
            .cloned()
    }

    pub(super) async fn synchronize(&self) -> Result<(), ToolError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(ObserverCommand::Barrier(reply))
            .map_err(|_| unknown("Extension download metadata observer stopped"))?;
        response
            .await
            .map_err(|_| unknown("Extension download metadata barrier was lost"))
    }

    pub(super) fn completion(
        &self,
        url: String,
        timeout: Duration,
    ) -> Result<Completion, ToolError> {
        let state = Arc::new(CompletionState {
            url,
            inner: Mutex::new(CompletionInner {
                first_id: None,
                result: None,
            }),
            changed: Notify::new(),
            timeout,
            deadline: tokio::time::Instant::now() + timeout,
        });
        let id = uuid::Uuid::new_v4();
        let mut metadata = self.state.lock().expect("download metadata lock poisoned");
        if let Some(error) = &metadata.disconnected {
            return Err(error.clone());
        }
        metadata.watches.insert(id, state.clone());
        drop(metadata);
        self.commands
            .send(ObserverCommand::Refresh)
            .map_err(|_| unknown("Extension download metadata observer stopped"))?;
        Ok(Completion {
            id,
            metadata: self.clone(),
            state,
        })
    }
}

impl MetadataOwner {
    pub(super) fn start(provider: &ExtensionBrowserProvider) -> Self {
        let (commands, mut waiting) = mpsc::unbounded_channel::<ObserverCommand>();
        let mut events = provider.subscribe_events();
        let metadata = Metadata {
            scope: uuid::Uuid::new_v4(),
            state: Arc::default(),
            commands,
        };
        let observed = metadata.clone();
        let worker = tokio::spawn(async move {
            loop {
                let deadline = observed.next_deadline();
                let expiry = async {
                    match deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending::<()>().await,
                    }
                };
                tokio::select! {
                    biased;
                    barrier=waiting.recv()=> {
                        let reply = match barrier {
                            None => break,
                            Some(ObserverCommand::Refresh) => continue,
                            Some(ObserverCommand::Barrier(reply)) => reply,
                        };
                        let queued = events.len();
                        for _ in 0..queued {
                            match events.try_recv() {
                                Ok(event) => observed.observe(event),
                                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {
                                    observed.fail_current(unknown("Extension download metadata events were lost"), false);
                                }
                                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => break,
                                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                                    observed.fail_current(unknown("Extension download metadata observer stopped"), true);
                                    break;
                                }
                            }
                        }
                        let _ = reply.send(());
                    }
                    ()=expiry=>observed.expire(),
                    event=events.recv()=>match event {
                        Ok(event) => observed.observe(event),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            observed.fail_current(unknown("Extension download metadata events were lost"), false);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                }
            }
            observed.fail_current(
                unknown("Extension download metadata observer stopped"),
                true,
            );
        });
        Self {
            metadata,
            worker,
            closed: false,
        }
    }

    pub(super) fn metadata(&self) -> Metadata {
        self.metadata.clone()
    }

    pub(super) async fn close(&mut self) -> Result<(), ToolError> {
        if self.closed {
            return Ok(());
        }
        self.metadata
            .fail_current(unknown("Extension download metadata observer closed"), true);
        self.worker.abort();
        match (&mut self.worker).await {
            Ok(()) => {}
            Err(error) if error.is_cancelled() => {}
            Err(error) => {
                return Err(cleanup(format!(
                    "Extension download metadata observer did not stop: {error}"
                )));
            }
        }
        self.closed = true;
        Ok(())
    }
}

impl Drop for MetadataOwner {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

impl Completion {
    pub(super) async fn wait(
        &self,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<ExtensionDownloadMetadata, ToolError> {
        let deadline = self.state.deadline;
        loop {
            let changed = self.state.changed.notified();
            let started = {
                let inner = self
                    .state
                    .inner
                    .lock()
                    .expect("download completion lock poisoned");
                if let Some(result) = &inner.result {
                    return result.clone();
                }
                inner.first_id.is_some()
            };
            // The original completion timeout ends at the first matching Started.
            // There is no replacement whole-download deadline after that point.
            if started {
                tokio::select! {
                    biased;
                    ()=cancellation.cancelled()=>return Err(unknown("Download wait cancelled after the response was released; do not replay")),
                    ()=changed=>{},
                }
            } else {
                tokio::select! {
                    biased;
                    ()=cancellation.cancelled()=>return Err(unknown("Download wait cancelled after the response was released; do not replay")),
                    ()=changed=>{},
                    ()=tokio::time::sleep_until(deadline)=>return Err(failed(format!("Timed out after {}ms waiting for download.", self.state.timeout.as_millis()))),
                }
            }
        }
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        self.metadata
            .state
            .lock()
            .expect("download metadata lock poisoned")
            .watches
            .remove(&self.id);
        let _ = self.metadata.commands.send(ObserverCommand::Refresh);
    }
}

#[cfg(test)]
pub(super) fn setup_fixture() -> Metadata {
    let (commands, _receive) = mpsc::unbounded_channel();
    Metadata {
        scope: uuid::Uuid::new_v4(),
        state: Arc::default(),
        commands,
    }
}

#[cfg(test)]
pub(super) fn completion_fixture() -> (Metadata, impl Send) {
    // Retain the real queue receiver without pretending that a Extension event,
    // metadata barrier or completion has been observed.
    let (commands, receive) = mpsc::unbounded_channel();
    (
        Metadata {
            scope: uuid::Uuid::new_v4(),
            state: Arc::default(),
            commands,
        },
        receive,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Metadata, mpsc::UnboundedReceiver<ObserverCommand>) {
        let (commands, receive) = mpsc::unbounded_channel();
        (
            Metadata {
                scope: uuid::Uuid::new_v4(),
                state: Arc::default(),
                commands,
            },
            receive,
        )
    }

    fn extension(
        id: &str,
        url: &str,
        status: ExtensionDownloadStatus,
        filename: &str,
    ) -> ExtensionDownloadMetadata {
        ExtensionDownloadMetadata {
            id: id.into(),
            filename: filename.into(),
            url: url.into(),
            status,
        }
    }

    #[test]
    fn complete_wait_requires_started_then_the_same_actual_extension_id() {
        let (metadata, _receive) = store();
        let watch = metadata
            .completion("https://fixture.test/file".into(), Duration::from_secs(3))
            .unwrap();
        let observe = |id, url, status| {
            metadata.observe(ExtensionProviderEvent::DownloadChanged {
                download: extension(id, url, status, ""),
            })
        };
        observe(
            "17",
            "https://fixture.test/file",
            ExtensionDownloadStatus::Complete,
        );
        assert!(watch.state.inner.lock().unwrap().result.is_none());
        observe(
            "other",
            "https://foreign.test/file",
            ExtensionDownloadStatus::Started,
        );
        assert!(watch.state.inner.lock().unwrap().first_id.is_none());
        observe(
            "17",
            "https://fixture.test/file",
            ExtensionDownloadStatus::Started,
        );
        observe(
            "18",
            "https://fixture.test/file",
            ExtensionDownloadStatus::Complete,
        );
        assert!(watch.state.inner.lock().unwrap().result.is_none());
        observe(
            "17",
            "https://fixture.test/file",
            ExtensionDownloadStatus::Complete,
        );
        let inner = watch.state.inner.lock().unwrap();
        assert_eq!(inner.result.as_ref().unwrap().as_ref().unwrap().id, "17");
    }

    #[test]
    fn same_url_global_metadata_retains_the_original_first_started_association() {
        let (metadata, _receive) = store();
        let url = "https://fixture.test/same-resource";
        let watch = metadata
            .completion(url.into(), Duration::from_secs(3))
            .unwrap();
        for download in [
            extension(
                "foreign-first",
                url,
                ExtensionDownloadStatus::Started,
                "/foreign/extension/name",
            ),
            extension(
                "our-later",
                url,
                ExtensionDownloadStatus::Started,
                "/our/extension/name",
            ),
            extension(
                "our-later",
                url,
                ExtensionDownloadStatus::Complete,
                "/our/extension/name",
            ),
        ] {
            metadata.observe(ExtensionProviderEvent::DownloadChanged { download });
        }
        assert!(watch.state.inner.lock().unwrap().result.is_none());
        metadata.observe(ExtensionProviderEvent::DownloadChanged {
            download: extension(
                "foreign-first",
                url,
                ExtensionDownloadStatus::Complete,
                "/foreign/extension/name",
            ),
        });
        assert_eq!(
            watch
                .state
                .inner
                .lock()
                .unwrap()
                .result
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap()
                .id,
            "foreign-first"
        );
        // This string remains observed metadata. No owning tab or readable file is asserted.
        assert_eq!(
            metadata.path("foreign-first").as_deref(),
            Some("/foreign/extension/name")
        );
        assert_eq!(
            metadata.path("our-later").as_deref(),
            Some("/our/extension/name")
        );
    }

    #[test]
    fn extension_filename_cache_keeps_empty_strings_and_never_rewrites_windows_paths() {
        let (metadata, _receive) = store();
        assert_eq!(metadata.path("absent"), None);
        for (id, filename) in [
            ("empty", ""),
            ("windows", r"C:\Users\fixture\Downloads\file.bin"),
        ] {
            metadata.observe(ExtensionProviderEvent::DownloadChanged {
                download: extension(
                    id,
                    "https://fixture.test/file",
                    ExtensionDownloadStatus::InProgress,
                    filename,
                ),
            });
            assert_eq!(metadata.path(id).as_deref(), Some(filename));
        }
    }

    #[test]
    fn completion_deadline_is_removed_at_started_not_replaced_by_a_file_deadline() {
        let (metadata, _receive) = store();
        let watch = metadata
            .completion("https://fixture.test/file".into(), Duration::ZERO)
            .unwrap();
        assert!(metadata.next_deadline().is_some());
        metadata.observe(ExtensionProviderEvent::DownloadChanged {
            download: extension(
                "17",
                "https://fixture.test/file",
                ExtensionDownloadStatus::Started,
                "",
            ),
        });
        assert_eq!(metadata.next_deadline(), None);
        metadata.expire();
        assert!(watch.state.inner.lock().unwrap().result.is_none());
        metadata.observe(ExtensionProviderEvent::DownloadChanged {
            download: extension(
                "17",
                "https://fixture.test/file",
                ExtensionDownloadStatus::Canceled,
                "",
            ),
        });
        assert!(
            matches!(watch.state.inner.lock().unwrap().result.as_ref().unwrap(), Err(ToolError::Failed(message)) if message == "Download 17 was canceled.")
        );
    }

    #[test]
    fn event_loss_settles_current_watches_unknown_without_fabricating_an_id() {
        let (metadata, _receive) = store();
        let watch = metadata
            .completion("https://fixture.test/file".into(), Duration::from_secs(3))
            .unwrap();
        metadata.fail_current(unknown("event stream gap"), false);
        let inner = watch.state.inner.lock().unwrap();
        assert!(inner.first_id.is_none());
        assert!(
            matches!(inner.result.as_ref().unwrap(), Err(ToolError::OutcomeUnknown(message)) if message == "event stream gap")
        );
    }
}
