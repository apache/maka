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

use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    fiber::Identity,
    remote::{Caller, Endpoint, Error, Handler, Method, Stream, StreamProvider},
    terminal_ui::{
        presenter::{Observation, ObservationRole},
        transcript::Resource,
    },
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub(super) struct Sources {
    pub opened: AtomicUsize,
    pub closed: AtomicUsize,
    pub reads: AtomicUsize,
    pub completed: Semaphore,
}
impl Default for Sources {
    fn default() -> Self {
        Self {
            opened: AtomicUsize::new(0),
            closed: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            completed: Semaphore::new(0),
        }
    }
}
impl Sources {
    pub fn stream(self: &Arc<Self>) -> Endpoint {
        Endpoint::standalone(Handler::Stream(Arc::new(Provider(self.clone()))))
    }
    pub fn stage(self: &Arc<Self>, staged: &mut Staged, identity: &Identity) -> Vec<Observation> {
        let resource = Resource {
            id: "activity".into(),
            read: "activity-read".into(),
            stream: "activity-stream".into(),
            route: Value::Null,
        };
        let mut members = Vec::new();
        for (method, role) in [
            ("changed", ObservationRole::ChangesStream),
            (
                "activity-read",
                ObservationRole::TranscriptRead(resource.clone()),
            ),
            (
                "activity-stream",
                ObservationRole::TranscriptStream(resource),
            ),
        ] {
            let endpoint = if matches!(role, ObservationRole::TranscriptRead(_)) {
                Endpoint::standalone(Handler::Method(self.clone()))
            } else {
                self.stream()
            };
            members.push(Observation {
                method: method.into(),
                target: endpoint.target(identity),
                role,
            });
            staged
                .insert(format!("example.pages/{method}"), endpoint)
                .unwrap();
        }
        staged
            .insert("example.pages/non-member", self.stream())
            .unwrap();
        members
    }
}
impl Method for Sources {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(json!({"input":input,"document":caller.document_id})) })
    }
}
struct Provider(Arc<Sources>);
impl StreamProvider for Provider {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>> {
        // The provider is shared; only the returned instance belongs to a page.
        self.0.opened.fetch_add(1, Ordering::SeqCst);
        let source = caller.cancellation.clone();
        let stream = Instance {
            source,
            input,
            state: self.0.clone(),
        };
        Box::pin(async move { Ok(Box::new(stream) as Box<dyn Stream>) })
    }
}
struct Instance {
    source: CancellationToken,
    input: Value,
    state: Arc<Sources>,
}
impl Stream for Instance {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        Box::pin(async { Ok(Some(self.input.clone())) })
    }
    fn cancel(&self) {
        self.source.cancel();
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        Box::pin(async move {
            self.source.cancel();
            self.state.closed.fetch_add(1, Ordering::SeqCst);
            self.state.completed.add_permits(1);
            if self.input.get("route").and_then(Value::as_str) == Some("unknown") {
                Err(Error::CleanupUnconfirmed)
            } else {
                Ok(())
            }
        })
    }
}
