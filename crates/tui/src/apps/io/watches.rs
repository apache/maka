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

use super::*;
use uuid::Uuid;

/// A changes stream a view declared: the package's stream method, for one
/// session or for the application.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Watch {
    pub owner: Uuid,
    pub package: String,
    pub method: String,
    pub session: Option<String>,
    /// Replacing a plugin restarts its stream even when its method name stays.
    pub activation: String,
}

pub enum Change {
    /// The stream said its views are stale.
    Stale(Watch),
    /// The stream ended or failed; it may start again when still wanted.
    Ended(Watch),
    /// Source ownership could not be confirmed; retire its containing page.
    Failed(Watch),
}

/// Changes streams kept open while a view that declared one is on screen.
/// Each owns its stream; the containing page separately owns the document.
/// Dropping its sender cancels observation while retaining late-Open cleanup.
pub struct Watches {
    documents: std::collections::HashMap<Uuid, document::Owned>,
    tasks: tokio::task::JoinSet<Result<(), ()>>,
    cleanup_failed: bool,
    running: std::collections::HashMap<Watch, tokio::sync::oneshot::Sender<()>>,
    changes: tokio::sync::mpsc::UnboundedSender<Change>,
}

/// A stream that ends or fails waits this long before it may start again.
const RESTART: std::time::Duration = std::time::Duration::from_secs(10);

impl Watches {
    pub fn new() -> (Self, tokio::sync::mpsc::UnboundedReceiver<Change>) {
        let (changes, receiver) = tokio::sync::mpsc::unbounded_channel();
        (
            Self {
                running: Default::default(),
                documents: Default::default(),
                tasks: tokio::task::JoinSet::new(),
                cleanup_failed: false,
                changes,
            },
            receiver,
        )
    }
    /// Starts what is wanted and not running; stops what no longer is.
    pub fn reconcile(&mut self, client: &Client, wanted: std::collections::BTreeSet<Watch>) {
        self.running.retain(|watch, _| wanted.contains(watch));
        for watch in wanted {
            if self.running.contains_key(&watch) {
                continue;
            }
            let Some(document) = self.ready(watch.owner) else {
                continue;
            };
            let (stop, stopped) = tokio::sync::oneshot::channel();
            self.running.insert(watch.clone(), stop);
            self.tasks.spawn(follow(
                client.clone(),
                watch,
                document,
                self.changes.clone(),
                stopped,
            ));
        }
    }
    pub fn ended(&mut self, watch: &Watch) {
        self.running.remove(watch);
    }
    pub fn document(&mut self, client: &Client, request: &Request) -> Option<Document> {
        if matches!(request.work, Work::Directory(_)) {
            return None;
        }
        if let Some(page) = self.documents.get(&request.execution) {
            return page.matches(request).then(|| page.document.clone());
        }
        let preceding = self
            .documents
            .values()
            .filter(|page| page.matches(request))
            .map(|page| {
                page.document.retire();
                page.document.clone()
            })
            .collect();
        let page = document::Owned::new(client.clone(), request, preceding, &mut self.tasks);
        let borrowed = page.document.clone();
        self.documents.insert(request.execution, page);
        Some(borrowed)
    }
    pub fn reconcile_documents(&mut self, wanted: std::collections::BTreeSet<Uuid>) {
        self.documents.retain(|owner, page| {
            if wanted.contains(owner) {
                return true;
            }
            page.document.retire();
            !page.document.confirmed_closed()
        });
        while let Some(result) = self.tasks.try_join_next() {
            self.cleanup_failed |= !matches!(result, Ok(Ok(())));
        }
    }
    fn ready(&self, owner: Uuid) -> Option<Uuid> {
        self.documents.get(&owner)?.document.ready()
    }
    pub fn transcripts(&self, mounts: Vec<transcript::Mount>) -> Vec<transcript::Mount> {
        mounts
            .into_iter()
            .filter_map(|mut mount| {
                mount.document = self.ready(mount.owner)?;
                Some(mount)
            })
            .collect()
    }
    pub fn stop(&mut self) {
        self.running.clear();
        self.documents.clear();
    }
    pub async fn shutdown(&mut self) -> Result<(), ()> {
        self.stop();
        while let Some(result) = self.tasks.join_next().await {
            self.cleanup_failed |= !matches!(result, Ok(Ok(())));
        }
        if self.cleanup_failed { Err(()) } else { Ok(()) }
    }
}
impl Drop for Watches {
    fn drop(&mut self) {
        self.stop();
        self.tasks.detach_all();
    }
}

async fn follow(
    client: Client,
    watch: Watch,
    document: Uuid,
    changes: tokio::sync::mpsc::UnboundedSender<Change>,
    mut stopped: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), ()> {
    let binding = RemoteBinding::Package {
        package_id: watch.package.clone(),
        method: watch.method.clone(),
        session_id: watch.session.clone(),
    };
    let bound = client.plugin_remote(RemoteRequest::Bind {
        binding: binding.clone(),
    });
    let result = tokio::select! {
        _ = &mut stopped => return Ok(()),
        result = bound => result,
    };
    let result = match result {
        Ok(RemoteResult::Bound {
            target,
            handler: RemoteKind::Stream,
        }) if target.activation == watch.activation => {
            // Open is not dropped: a late stream still belongs to this task.
            let opened = client
                .plugin_remote(RemoteRequest::Open {
                    binding,
                    target,
                    document,
                    input: serde_json::Value::Null,
                })
                .await;
            if let Ok(RemoteResult::Opened { stream }) = opened {
                let observe = async {
                    if changes.send(Change::Stale(watch.clone())).is_err() {
                        return;
                    }
                    loop {
                        match client
                            .plugin_remote(RemoteRequest::Next { document, stream })
                            .await
                        {
                            Ok(RemoteResult::Item { .. }) => {
                                if changes.send(Change::Stale(watch.clone())).is_err() {
                                    return;
                                }
                            }
                            Ok(RemoteResult::Pending) => {}
                            _ => return,
                        }
                    }
                };
                let cancelled =
                    tokio::select! { biased; _ = &mut stopped => true, _ = observe => false };
                let cleanup = match client
                    .plugin_remote(RemoteRequest::Close { document, stream })
                    .await
                {
                    Ok(RemoteResult::Closed) => Ok(()),
                    _ => Err(()),
                };
                if cancelled {
                    return cleanup;
                }
                cleanup
            } else if matches!(opened, Err(maka_client::RequestFailure::Unknown(_))) {
                Err(())
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    };
    if result.is_err() {
        let _ = changes.send(Change::Failed(watch));
        return result;
    }
    tokio::select! {
        _ = &mut stopped => {},
        _ = tokio::time::sleep(RESTART) => { let _ = changes.send(Change::Ended(watch)); }
    }
    result
}
