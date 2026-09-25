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

use super::{
    Document,
    binding::{self, Binding, Identity},
    failure,
};
use crate::plugins::remote::Bound;
use futures_util::{FutureExt, future::BoxFuture};
use maka_plugins::{
    remote::{self, Caller, Error},
    terminal_ui::presenter::Page,
};
use maka_protocol::{
    OperationError, OperationErrorCode,
    plugin::{RemoteBinding, RemoteKind},
};
use serde_json::Value;
use std::{panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::sync::watch;
use tokio_util::task::TaskTracker;

pub(in crate::server::plugin_remote) struct Handle {
    page: Arc<dyn Page>,
    closed: watch::Receiver<Option<Result<(), Error>>>,
}
impl Handle {
    pub(super) fn cancel(&self) {
        // A faulty synchronous signal must not prevent the owned close task.
        let _ = std::panic::catch_unwind(AssertUnwindSafe(|| self.page.cancel()));
    }
    async fn closed(&self) -> Result<(), Error> {
        let mut closed = self.closed.clone();
        loop {
            if let Some(result) = closed.borrow_and_update().clone() {
                return result;
            }
            closed
                .changed()
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?;
        }
    }
}
pub(in crate::server::plugin_remote) enum Method {
    Shared(Arc<dyn remote::Method>),
    Page(Arc<Handle>),
}
impl Method {
    pub fn isolated(&self) -> bool {
        matches!(self, Self::Page(_))
    }
    pub fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        match self {
            Self::Shared(method) => method.call(input, caller),
            Self::Page(page) => page.page.call(input, caller),
        }
    }
    pub async fn run(
        &self,
        bound: &Bound,
        input: Value,
        caller: Caller,
        preserve_receipt: bool,
    ) -> Result<Value, Error> {
        let cancellation = caller.cancellation.clone();
        let _cancel_on_exit = cancellation.clone().drop_guard();
        let mut call = self.call(input, caller);
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(Error::Cancelled),
            _ = bound.retired() => Err(Error::Retired),
            _ = tokio::time::sleep(Duration::from_secs(30)) => Err(Error::Cancelled),
            result = &mut call => {
                if !self.isolated() && matches!(result, Err(Error::CleanupUnconfirmed)) {
                    bound.endpoint.owner.cleanup_failed("Remote method cleanup is unconfirmed".into());
                }
                return result.and_then(|value| { remote::validate_payload(&value)?; Ok(value) });
            }
        };
        cancellation.cancel();
        if self.isolated() {
            // Let the page settle an already received authoritative backend
            // outcome before dropping its invocation after cancellation.
            let settled = tokio::time::timeout(Duration::from_secs(6), call)
                .await
                .unwrap_or(Err(Error::CleanupUnconfirmed));
            return match settled {
                Ok(value) if preserve_receipt && receipt(&value) => Ok(value),
                Err(Error::CleanupUnconfirmed) => Err(Error::CleanupUnconfirmed),
                _ => result,
            };
        }
        match tokio::time::timeout(Duration::from_secs(5), call).await {
            Ok(result) if !matches!(result, Err(Error::CleanupUnconfirmed)) => {}
            _ => {
                bound
                    .endpoint
                    .owner
                    .cleanup_failed("Remote method ignored cancellation".into());
                return Err(Error::CleanupUnconfirmed);
            }
        };
        result
    }
    pub async fn close_failed_page(&self, document: &Document) -> Result<(), Error> {
        if let Self::Page(page) = self {
            document.close();
            page.closed().await?;
        }
        Ok(())
    }
}
impl Document {
    /// Called only after endpoint admission and with this call's reservation.
    pub fn method(
        self: &Arc<Self>,
        binding: &RemoteBinding,
        bound: Arc<Bound>,
        method: Arc<dyn remote::Method>,
        tasks: &TaskTracker,
        input: &Value,
    ) -> Result<Method, OperationError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(failure(Error::Cancelled));
        }
        if let Some(presenter) = &state.presenter {
            return Ok(
                if presenter.check(binding, &bound.target, RemoteKind::Method, input)? {
                    Method::Page(presenter.page.clone())
                } else {
                    Method::Shared(method)
                },
            );
        }
        let factory = match std::panic::catch_unwind(AssertUnwindSafe(|| method.page_factory())) {
            Ok(factory) => factory,
            Err(_) => {
                drop(state);
                self.close();
                self.cleanup_failed();
                bound
                    .endpoint
                    .owner
                    .cleanup_failed("Terminal page factory panicked".into());
                return Err(failure(Error::CleanupUnconfirmed));
            }
        };
        let Some(factory) = factory else {
            state.ordinary = true;
            return Ok(Method::Shared(method));
        };
        let identity = Identity::new(binding, &bound.target, RemoteKind::Method);
        if state.ordinary
            || state
                .reservations
                .values()
                .any(|reserved| reserved != &identity)
            || !state.streams.is_empty()
        {
            return Err(OperationError {
                code: OperationErrorCode::OperationConflict,
                message: "A terminal page requires a document without other requests".into(),
            });
        }
        let observations = std::panic::catch_unwind(AssertUnwindSafe(|| {
            binding::capture(factory.as_ref(), &bound.target)
        }))
        .unwrap_or_else(|_| {
            Err(failure(Error::Provider(
                "Terminal observation capture panicked".into(),
            )))
        });
        let observations = match observations {
            Ok(observations) => observations,
            Err(error) => {
                drop(state);
                self.close();
                return Err(error);
            }
        };
        // open reserves and queues initialization; UI code executes off this
        // lock. Publish once before another call or Close can observe the owner.
        let page = match std::panic::catch_unwind(AssertUnwindSafe(|| {
            factory.open(self.cancellation.child_token())
        }))
        .unwrap_or(Err(Error::CleanupUnconfirmed))
        {
            Ok(page) => page,
            Err(error) => {
                drop(state);
                self.close();
                if matches!(error, Error::CleanupUnconfirmed) {
                    self.cleanup_failed();
                    bound
                        .endpoint
                        .owner
                        .cleanup_failed("Terminal page open cleanup is unconfirmed".into());
                }
                return Err(failure(error));
            }
        };
        let (done, closed) = watch::channel(None);
        let handle = Arc::new(Handle {
            page: page.clone(),
            closed,
        });
        let token = self.tasks.token();
        state.presenter = Some(Binding {
            identity,
            _factory: factory,
            observations,
            page: handle.clone(),
        });
        drop(state);
        let document = self.clone();
        tasks.spawn(async move {
            let _ = AssertUnwindSafe(async {
                tokio::select! {
                    _ = document.cancellation.cancelled() => {},
                    _ = bound.retired() => {},
                    _ = page.retired() => {},
                }
            })
            .catch_unwind()
            .await;
            document.close();
            let result = AssertUnwindSafe(async {
                tokio::time::timeout(Duration::from_secs(5), page.close())
                    .await
                    .map_err(|_| Error::CleanupUnconfirmed)?
            })
            .catch_unwind()
            .await
            .unwrap_or(Err(Error::CleanupUnconfirmed));
            if result.is_err() {
                document.cleanup_failed();
                bound
                    .endpoint
                    .owner
                    .cleanup_failed("Terminal page cleanup is unconfirmed".into());
            }
            done.send_replace(Some(result.map_err(|_| Error::CleanupUnconfirmed)));
            drop(token);
        });
        Ok(Method::Page(handle))
    }
}

pub(in crate::server::plugin_remote) fn receipt(value: &Value) -> bool {
    use maka_plugins::terminal_ui::view::Reply;
    serde_json::from_value::<Reply>(value.clone()).is_ok_and(|reply| reply.validate().is_ok())
}
