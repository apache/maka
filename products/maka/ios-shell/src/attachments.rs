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

use crate::bridge::AttachmentHost;
use bytes::Bytes;
use maka_remote_client::{Attachments, ReadResource, RemoteClientError};
use nsh_core::{
    ImageData,
    element::{Arg, Instance, JsIn, Later, PropError, Registry, TsTypes},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, btree_map::Entry},
    future::ready,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);

struct PickedBlob(ImageData);

impl Arg for PickedBlob {
    fn ts_type(types: &mut TsTypes) -> String {
        <String as Arg>::ts_type(types)
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let url = <String as Arg>::from_js(value)?;
        value
            .host()
            .blob_bytes(&url)
            .map(Self)
            .ok_or_else(|| PropError("expected a live blob URL from this app".into()))
    }
}

impl AsRef<[u8]> for PickedBlob {
    fn as_ref(&self) -> &[u8] {
        self.0.bytes()
    }
}

type Attempts = Arc<Mutex<BTreeMap<String, UploadState>>>;

#[derive(PartialEq, Eq)]
enum UploadPhase {
    Preparing,
    Confirming,
}

struct UploadState {
    cancel: CancellationToken,
    phase: UploadPhase,
}

struct UploadAttempt {
    attempts: Attempts,
    id: String,
    cancel: CancellationToken,
}

impl UploadAttempt {
    fn begin_confirm(&self) -> bool {
        let mut attempts = self.attempts.lock().expect("upload attempts");
        let state = attempts
            .get_mut(&self.id)
            .expect("registered upload attempt");
        if state.cancel.is_cancelled() {
            return false;
        }
        state.phase = UploadPhase::Confirming;
        true
    }
}

impl Drop for UploadAttempt {
    fn drop(&mut self) {
        self.attempts
            .lock()
            .expect("upload attempts")
            .remove(&self.id);
        self.cancel.cancel();
    }
}

#[nsh_core::element::class]
struct IosAttachments {
    host: Option<AttachmentHost>,
    attempts: Attempts,
    slot: Arc<Semaphore>,
}

pub(crate) fn registry(host: Option<AttachmentHost>) -> Registry {
    let mut registry = Registry::ui_set("maka/host");
    let slot = Arc::new(Semaphore::new(1));
    registry.value("iosAttachments", move || {
        Instance::new(IosAttachments {
            host: host.clone(),
            attempts: Default::default(),
            slot: slot.clone(),
        })
    });
    registry
}

impl Drop for IosAttachments {
    fn drop(&mut self) {
        for state in self.attempts.lock().expect("upload attempts").values() {
            state.cancel.cancel();
        }
    }
}

struct UploadRequest {
    root: String,
    generation: u64,
    session: String,
    name: String,
    blob: PickedBlob,
}

#[nsh_core::element::class]
impl IosAttachments {
    pub fn upload(
        &self,
        root_id: String,
        generation: u64,
        session_id: String,
        attempt_id: String,
        name: String,
        blob: PickedBlob,
    ) -> Later<Value> {
        let Some(host) = self.host.clone() else {
            return Later::new(ready(Err("attachment Host is unavailable")));
        };
        let cancel = CancellationToken::new();
        {
            let mut attempts = self.attempts.lock().expect("upload attempts");
            match attempts.entry(attempt_id.clone()) {
                Entry::Occupied(_) => {
                    return Later::new(ready(Err("duplicate attachment attempt")));
                }
                Entry::Vacant(entry) => entry.insert(UploadState {
                    cancel: cancel.clone(),
                    phase: UploadPhase::Preparing,
                }),
            };
        }
        let attempt = UploadAttempt {
            attempts: self.attempts.clone(),
            id: attempt_id,
            cancel,
        };
        let runtime = host.runtime().clone();
        let task = runtime.spawn(upload(
            host,
            self.slot.clone(),
            attempt,
            UploadRequest {
                root: root_id,
                generation,
                session: session_id,
                name,
                blob,
            },
        ));
        Later::new(async move { task.await.map_err(|err| err.to_string())? })
    }

    pub fn cancel(&self, attempt_id: String) {
        if let Some(state) = self
            .attempts
            .lock()
            .expect("upload attempts")
            .get(&attempt_id)
        {
            state.cancel.cancel();
        }
    }

    pub fn cancel_before_confirm(&self, attempt_id: String) {
        if let Some(state) = self
            .attempts
            .lock()
            .expect("upload attempts")
            .get(&attempt_id)
            && state.phase == UploadPhase::Preparing
        {
            state.cancel.cancel();
        }
    }
}

fn status(kind: &str) -> Value {
    json!({"kind": kind})
}

async fn upload(
    host: AttachmentHost,
    slot: Arc<Semaphore>,
    attempt: UploadAttempt,
    request: UploadRequest,
) -> Result<Value, String> {
    let UploadRequest {
        root,
        generation,
        session,
        name,
        blob,
    } = request;
    let cancelled = || status("cancelled");
    let Some(connection) = host.connection(&root, generation).await else {
        return Ok(status("not_submitted"));
    };
    let cancel = &attempt.cancel;
    let retired = connection.retired();
    let slot = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(cancelled()),
        _ = retired.cancelled() => return Ok(status("not_submitted")),
        slot = slot.acquire() => slot.expect("upload semaphore is never closed"),
    };
    host.upload_started(&attempt.id);
    let hash_cancel = cancel.clone();
    let hash_retired = retired.clone();
    let hashed = tokio::task::spawn_blocking(move || {
        let bytes = blob.as_ref();
        if bytes.len() > MAX_BYTES {
            return Err(status("too_large"));
        }
        let mut digest = Sha256::new();
        for part in bytes.chunks(64 * 1024) {
            if hash_cancel.is_cancelled() || hash_retired.is_cancelled() {
                return Err(status("not_submitted"));
            }
            digest.update(part);
        }
        let digest = format!("sha256:{}", hex::encode(digest.finalize()));
        Ok((digest, Bytes::from_owner(blob)))
    });
    let prepare = async {
        let (digest, bytes) = match hashed.await.map_err(|err| err.to_string())? {
            Ok(hashed) => hashed,
            Err(outcome) => return Ok(Err(outcome)),
        };
        let input = json!({
            "sessionId": session, "name": name, "bytes": bytes.len(), "digest": digest,
        });
        let resources = Attachments::from([("file".into(), ReadResource::binary(bytes))]);
        Ok(connection
            .calls()
            .prepare_mutation("agent", "uploadAttachment", input, resources)
            .await
            .map_err(|err| {
                log::warn!("prepare attachment upload: {err}");
                status("not_submitted")
            }))
    };
    let prepared = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(cancelled()),
        _ = retired.cancelled() => return Ok(status("not_submitted")),
        result = tokio::time::timeout(UPLOAD_TIMEOUT, prepare) => match result {
            Ok(Ok(Ok(prepared))) => prepared,
            Ok(Ok(Err(outcome))) => return Ok(outcome),
            Ok(Err(err)) => return Err(err),
            Err(_) => return Ok(status("not_submitted")),
        },
    };
    let reference =
        serde_json::from_str(prepared.reference().get()).map_err(|err| err.to_string())?;
    if retired.is_cancelled() {
        return Ok(status("not_submitted"));
    }
    if !attempt.begin_confirm() {
        return Ok(cancelled());
    }
    // Once confirm starts, abandoning the wait cannot prove the write was not executed.
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Ok(status("unconfirmed")),
        result = tokio::time::timeout(UPLOAD_TIMEOUT, prepared.confirm(|_| ready(()))) => result,
    };
    drop(slot);
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(RemoteClientError::MutationNotExecuted)) => Ok(status("not_submitted")),
        Ok(Err(RemoteClientError::MutationCleanup {
            diagnostic, result, ..
        })) => {
            log::warn!("attachment upload cleanup failed: {diagnostic}");
            match *result {
                Ok(value) => Ok(value),
                Err(RemoteClientError::MutationNotExecuted) => Ok(status("not_submitted")),
                Err(err) => {
                    log::warn!("recorded attachment upload failure: {err}");
                    Ok(status("unconfirmed"))
                }
            }
        }
        other => {
            match other {
                Ok(Err(err)) => log::warn!("confirm attachment upload: {err}"),
                Err(err) => log::warn!("confirm attachment upload: {err}"),
                Ok(Ok(_)) => unreachable!(),
            }
            Ok(recover(host, connection, generation, &attempt, reference).await)
        }
    }
}

async fn recover(
    host: AttachmentHost,
    connection: crate::bridge::AttachmentConnection,
    generation: u64,
    attempt: &UploadAttempt,
    reference: Value,
) -> Value {
    let Some(reply) = host
        .receipt(
            connection,
            generation,
            &attempt.id,
            reference,
            &attempt.cancel,
        )
        .await
    else {
        return status("unconfirmed");
    };
    let outcome = &reply["receipt"]["outcome"];
    match outcome["kind"].as_str() {
        Some("not_executed") => status("not_submitted"),
        Some("returned") if outcome["result"]["kind"] == "success" => {
            outcome["result"]["value"].clone()
        }
        _ => status("unconfirmed"),
    }
}
