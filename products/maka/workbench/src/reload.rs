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

use nsh_core::JsonValue;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug)]
pub enum Request {
    Pause(oneshot::Sender<Result<(), String>>),
    Resume,
    Reload,
}

/// One shell owns the requests; its admitted Host and journal survive reloads.
#[derive(Clone)]
pub struct UiReload(Arc<State>);

struct State {
    sender: mpsc::UnboundedSender<Request>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<Request>>>,
    restored: Mutex<JsonValue>,
}

impl Default for UiReload {
    fn default() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self(Arc::new(State {
            sender,
            receiver: Mutex::new(Some(receiver)),
            restored: Mutex::new(JsonValue::Null),
        }))
    }
}

impl UiReload {
    pub fn take_requests(&self) -> mpsc::UnboundedReceiver<Request> {
        self.0
            .receiver
            .lock()
            .unwrap()
            .take()
            .expect("one native shell owns its UI reload requests")
    }

    pub(crate) async fn pause(&self) -> Result<(), String> {
        let (ready, received) = oneshot::channel();
        self.0
            .sender
            .send(Request::Pause(ready))
            .map_err(|_| "the native UI is closed")?;
        received
            .await
            .map_err(|_| "the native UI closed before input was paused")?
    }

    pub(crate) fn resume(&self) -> Result<(), String> {
        self.0
            .sender
            .send(Request::Resume)
            .map_err(|_| "the native UI is closed".into())
    }

    pub fn restored(&self) -> JsonValue {
        self.0.restored.lock().unwrap().clone()
    }

    pub(crate) fn request(&self, state: JsonValue) {
        *self.0.restored.lock().unwrap() = state;
        self.0
            .sender
            .send(Request::Reload)
            .expect("the active native shell owns UI reload requests");
    }
}
