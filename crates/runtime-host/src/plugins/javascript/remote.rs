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

use super::callbacks::{self, Callback};
use futures_util::future::BoxFuture;
use maka_plugins::remote::{Caller, Error, Method, Stream, StreamProvider};
use maka_runtime::tools::ToolError;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) struct Source {
    pub package: maka_plugins::package::Package,
    pub presenters: Arc<super::presenter::Capacity>,
    pub catalog: maka_plugins::contributions::Catalog,
}
pub(super) struct Remote(pub Arc<Callback>);
impl Method for Remote {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let callback = self.0.clone();
        Box::pin(async move {
            invoke(&callback, input, caller)
                .await
                .map(|(value, _guard)| value)
        })
    }
}
impl StreamProvider for Remote {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>> {
        let callback = self.0.clone();
        Box::pin(async move {
            let (value, guard) = invoke(&callback, input, caller).await?;
            let handle = value
                .as_str()
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .ok_or_else(|| Error::Invalid("JS stream returned an invalid handle".into()))?
                .to_owned();
            Ok(Box::new(JsStream {
                callback,
                handle,
                guard,
                cancelling: Mutex::new(None),
            }) as Box<dyn Stream>)
        })
    }
}
struct JsStream {
    callback: Arc<Callback>,
    handle: String,
    guard: super::invocation::RemoteGuard,
    cancelling: Mutex<Option<tokio::task::JoinHandle<Result<(), maka_js_runtime::plugin::Error>>>>,
}
impl Stream for JsStream {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        Box::pin(async move {
            let value = self
                .callback
                .module
                .call(vec!["streamNext".into()], vec![json!(self.handle)])
                .await
                .map_err(|error| Error::Provider(error.to_string()))?;
            let value = result(value)?;
            #[derive(serde::Deserialize)]
            #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
            enum Item {
                Item { value: Value },
                End,
            }
            match serde_json::from_value(value)
                .map_err(|error| Error::Invalid(error.to_string()))?
            {
                Item::Item { value } => Ok(Some(value)),
                Item::End => Ok(None),
            }
        })
    }
    fn cancel(&self) {
        self.guard.cancellation.cancel();
        let mut task = self.cancelling.lock().unwrap();
        if task.is_none() {
            let module = self.callback.module.clone();
            let handle = self.handle.clone();
            *task = Some(tokio::spawn(
                async move { module.cancel_call(handle).await },
            ));
        }
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        Box::pin(async move {
            self.cancel();
            let task = self
                .cancelling
                .lock()
                .unwrap()
                .take()
                .expect("stream cancellation started");
            task.await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            self.callback
                .module
                .call(vec!["streamClose".into()], vec![json!(self.handle)])
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?;
            Ok(())
        })
    }
}
async fn invoke(
    callback: &Callback,
    input: Value,
    caller: Caller,
) -> Result<(Value, super::invocation::RemoteGuard), Error> {
    let guard = callback.calls.enter_remote(caller.clone())?;
    let value = callbacks::invoke(
        &callback.module,
        callback.id,
        input,
        json!({
            "clientInstanceId":caller.client_instance_id, "documentId":caller.document_id,
            "sessionId":caller.session_id,
            "remoteAuthority": guard.id,
        }),
        caller.cancellation,
    )
    .await
    .map_err(|error| match error {
        ToolError::CleanupUnconfirmed(_) => Error::CleanupUnconfirmed,
        ToolError::OutcomeUnknown(message) => Error::OutcomeUnknown(message),
        _ => Error::Provider(error.to_string()),
    })?;
    Ok((result(value)?, guard))
}

fn result(value: Value) -> Result<Value, Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum Code {
        Invalid,
        Revoked,
        Cancelled,
        OutcomeUnknown,
        Unavailable,
    }
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum Result {
        Value { value: Value },
        Error { code: Code, message: String },
    }
    match serde_json::from_value(value).map_err(|error| Error::Invalid(error.to_string()))? {
        Result::Value { value } => Ok(value),
        Result::Error { code, message } => Err(match code {
            Code::Invalid => Error::Invalid(message),
            Code::Revoked => Error::Retired,
            Code::Cancelled => Error::Cancelled,
            Code::OutcomeUnknown => Error::OutcomeUnknown(message),
            Code::Unavailable => Error::Provider(message),
        }),
    }
}
