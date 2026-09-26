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

//! URLs use the public transcript reader: View checkpoints retain only identity.
use super::*;
use maka_plugins::{remote::Stream, terminal_ui::transcript as transcript_api};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
type Mount = (Uuid, Uuid, Uuid);
#[derive(Clone)]
struct Source {
    pages: auth::Pages,
    mounts: Arc<Mutex<BTreeMap<Mount, String>>>,
}
pub(super) fn resource(attempt: &auth::Attempt) -> transcript_api::Resource {
    transcript_api::Resource {
        id: format!("auth-{}-{}", attempt.id, attempt.url_revision),
        read: "terminal-auth-url".into(),
        stream: "terminal-auth-url-stream".into(),
        route: Value::Null,
    }
}
pub(super) fn publish(
    pages: auth::Pages,
    package: &str,
    staged: &mut Staged,
) -> Result<(), String> {
    let source = Arc::new(Source {
        pages,
        mounts: Arc::default(),
    });
    for (name, handler) in [
        ("terminal-auth-url", remote::Handler::Method(source.clone())),
        ("terminal-auth-url-stream", remote::Handler::Stream(source)),
    ] {
        staged
            .insert(
                remote::key(package, name).map_err(|error| error.to_string())?,
                remote::Endpoint::standalone(handler).requiring_host_paths(),
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
impl Source {
    fn url(&self, caller: &Caller, id: &str) -> Result<String, Error> {
        self.pages
            .snapshot(caller)
            .filter(|attempt| attempt.active() && resource(attempt).id == id)
            .and_then(|attempt| attempt.url)
            .ok_or_else(|| Error::Invalid("Sign-in URL is no longer available".into()))
    }
}
impl Method for Source {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let this = self.clone();
        Box::pin(async move {
            let read: transcript_api::Read =
                serde_json::from_value(input).map_err(|error| Error::Invalid(error.to_string()))?;
            if read.fence != 1
                || read.direction != transcript_api::Direction::Tail
                || read.cursor.is_some()
                || this.mounts.lock().unwrap().get(&(
                    caller.connection_id,
                    caller.document_id,
                    read.mount,
                )) != Some(&read.resource)
            {
                return Err(Error::Invalid("Unknown sign-in URL mount".into()));
            }
            let text = this.url(&caller, &read.resource)?;
            let page = transcript_api::Page {
                fence: 1,
                records: vec![transcript_api::Record::Block {
                    block: transcript_api::Block {
                        key: transcript_api::Key {
                            turn: "authorization".into(),
                            message: "url".into(),
                            part: transcript_api::Part::Text,
                        },
                        revision: read.resource,
                        // Expanded prose also supports keyboard record selection/source copy.
                        kind: transcript_api::Kind::Assistant,
                        state: None,
                        content: transcript_api::Content {
                            text,
                            ..Default::default()
                        },
                        timestamp_ms: None,
                        affinity: None,
                    },
                }],
                timings: vec![],
                older: None,
                newer: None,
                continuation: None,
            };
            page.validate()
                .map_err(|error| Error::Provider(error.to_string()))?;
            serde_json::to_value(page).map_err(|error| Error::Provider(error.to_string()))
        })
    }
}
impl StreamProvider for Source {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>> {
        let this = self.clone();
        Box::pin(async move {
            let open: transcript_api::Open =
                serde_json::from_value(input).map_err(|error| Error::Invalid(error.to_string()))?;
            this.url(&caller, &open.resource)?;
            let owner = (caller.connection_id, caller.document_id, open.mount);
            let mut mounts = this.mounts.lock().unwrap();
            if mounts.contains_key(&owner) {
                return Err(Error::Invalid("URL already mounted".into()));
            }
            mounts.insert(owner, open.resource);
            drop(mounts);
            Ok(Box::new(Reading {
                source: this,
                owner,
                ready: Mutex::new(false),
                stop: caller.cancellation.child_token(),
            }) as Box<dyn Stream>)
        })
    }
}
struct Reading {
    source: Source,
    owner: Mount,
    ready: Mutex<bool>,
    stop: CancellationToken,
}
impl Stream for Reading {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        let ready = std::mem::replace(&mut *self.ready.lock().unwrap(), true);
        Box::pin(async move {
            if !ready {
                return Ok(Some(json!({"kind":"ready","fence":1})));
            }
            self.stop.cancelled().await;
            Ok(None)
        })
    }
    fn cancel(&self) {
        self.stop.cancel();
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        self.stop.cancel();
        self.source.mounts.lock().unwrap().remove(&self.owner);
        Box::pin(async { Ok(()) })
    }
}
