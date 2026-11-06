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

//! Capture presentation state before releasing a window's engine, without
//! synchronously waiting for JavaScript on the native UI thread.

use maka_workbench::reload::UiReload;
use nsh_engine::{HostCall, HostChannel, JsonValue};
use std::sync::{Arc, Mutex};
use tokio::{
    runtime::Handle,
    sync::{mpsc, oneshot},
};

pub(super) struct WindowClose {
    phase: Mutex<Phase>,
    reload: UiReload,
    runtime: Handle,
}
enum Phase {
    Open,
    Preparing {
        id: String,
        reply: oneshot::Sender<Result<JsonValue, String>>,
    },
    Saving,
    Ready,
}

impl WindowClose {
    pub(super) fn new(reload: UiReload, runtime: Handle) -> Self {
        Self {
            phase: Mutex::new(Phase::Open),
            reload,
            runtime,
        }
    }

    pub(super) fn answer(&self, call: HostCall) {
        let previous = {
            let mut phase = self.phase.lock().unwrap();
            match &*phase {
                Phase::Preparing { id, .. }
                    if call.data().get("id").and_then(JsonValue::as_str) == Some(id.as_str()) =>
                {
                    std::mem::replace(&mut *phase, Phase::Saving)
                }
                _ => {
                    call.resolve(JsonValue::Null);
                    return;
                }
            }
        };
        if let Phase::Preparing { reply, .. } = previous {
            let response = match call.data().get("error").and_then(JsonValue::as_str) {
                Some(error) => Err(error.to_owned()),
                None => call
                    .data()
                    .get("state")
                    .cloned()
                    .ok_or_else(|| "UI close reply has no state".into()),
            };
            let _ = reply.send(response);
        }
        call.resolve(JsonValue::Null);
    }

    pub(super) fn prepare(
        self: &Arc<Self>,
        host: HostChannel,
        ready: mpsc::UnboundedSender<()>,
        current: Arc<Mutex<Option<Arc<Self>>>>,
    ) -> bool {
        let id = uuid::Uuid::new_v4().to_string();
        let response = {
            let mut phase = self.phase.lock().unwrap();
            match &*phase {
                Phase::Ready => return true,
                Phase::Preparing { .. } | Phase::Saving => return false,
                Phase::Open => {
                    let (reply, response) = oneshot::channel();
                    *phase = Phase::Preparing {
                        id: id.clone(),
                        reply,
                    };
                    response
                }
            }
        };
        let sent = host.send("desktop.prepareClose", serde_json::json!({ "id": id }));
        let window = self.clone();
        self.runtime.spawn(async move {
            let outcome = match sent {
                Err(error) => Err(error),
                Ok(()) => {
                    match tokio::time::timeout(std::time::Duration::from_secs(5), response).await {
                        Ok(Ok(result)) => result,
                        Ok(Err(_)) => Err("UI closed before its state was captured".into()),
                        Err(_) => Err("UI state capture timed out".into()),
                    }
                }
            };
            // A late result must never close a replacement window.
            let current = current.lock().unwrap();
            if !current
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &window))
            {
                return;
            }
            match outcome {
                Ok(state) => {
                    window.reload.remember(state);
                    *window.phase.lock().unwrap() = Phase::Ready;
                    let _ = ready.send(());
                }
                Err(error) => {
                    *window.phase.lock().unwrap() = Phase::Open;
                    eprintln!("maka-desktop-shell: cannot save the window: {error}");
                    let _ = host.send("desktop.closeFailed", JsonValue::String(error));
                }
            }
        });
        false
    }
}
