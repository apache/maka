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

mod upload;
mod worker;
use futures_util::future::BoxFuture;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::call::Scope;
use maka_capabilities::http::Body;
use maka_capabilities::http::Client;
use maka_capabilities::http::Error;
use maka_capabilities::http::Head;
use maka_capabilities::http::Method;
use maka_capabilities::http::Request;
use maka_capabilities::http::Response;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

/// Authority and worker ownership supplied by the actual embedding. HTTP data
/// cannot choose a Root, grant, invocation, or lifecycle owner.
pub trait Authority: Send + Sync {
    fn admit(&self, call: &Scope) -> Result<Box<dyn Send>, Error>;
    fn policy<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a maka_sandbox::Destination,
        origin: String,
    ) -> BoxFuture<'a, Result<maka_network::Policy, Error>>;
    fn check<'a>(
        &'a self,
        call: &'a Scope,
        destination: &'a maka_sandbox::Destination,
    ) -> BoxFuture<'a, Result<(), Error>>;
    fn record(
        &self,
        call: Scope,
        operation: maka_event_log::effects::Operation,
        destination: maka_sandbox::Destination,
        effect: BoxFuture<'static, Result<serde_json::Value, ToolError>>,
    ) -> BoxFuture<'static, Result<serde_json::Value, ToolError>>;
    fn spawn(&self, worker: Worker) -> Result<(), Error>;
}
pub type Worker =
    Box<dyn FnOnce(CancellationToken) -> BoxFuture<'static, Result<(), String>> + Send>;

pub struct Http {
    authority: Arc<dyn Authority>,
    tls: std::sync::Mutex<Option<(maka_network::Policy, Arc<maka_network::TlsConfigCache>)>>,
}
impl Http {
    pub fn new(authority: Arc<dyn Authority>) -> Self {
        Self {
            authority,
            tls: Default::default(),
        }
    }
}
impl Client for Http {
    fn request(&self, call: Scope, input: Request) -> BoxFuture<'_, Result<Response, Error>> {
        Box::pin(async move {
            let _lease = self.authority.admit(&call)?;
            if call.cancellation.is_cancelled() {
                return Err(Error::Denied);
            }
            let url = reqwest::Url::parse(&input.url).map_err(invalid)?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid("invalid HTTP request"));
            }
            let mut headers = HeaderMap::new();
            let destination = maka_sandbox::Destination::new(
                url.host_str().ok_or_else(|| invalid("missing HTTP host"))?,
                url.port_or_known_default()
                    .ok_or_else(|| invalid("missing HTTP port"))?,
            )
            .map_err(invalid)?;
            for (name, value) in input.headers {
                let name = HeaderName::from_bytes(name.as_bytes()).map_err(invalid)?;
                if matches!(
                    name.as_str(),
                    "host"
                        | "connection"
                        | "content-length"
                        | "transfer-encoding"
                        | "upgrade"
                        | "proxy-authorization"
                        | "proxy-connection"
                ) {
                    return Err(invalid("HTTP framing and proxy headers are owned by Host"));
                }
                headers
                    .try_append(name, HeaderValue::from_str(&value).map_err(invalid)?)
                    .map_err(invalid)?;
            }
            let policy = self
                .authority
                .policy(&call, &destination, url.origin().ascii_serialization())
                .await?;
            policy
                .check_request_headers(&url, &headers, input.body.length() != Some(0), false)
                .map_err(invalid)?;
            let tls = {
                let mut cached = self.tls.lock().unwrap();
                if cached
                    .as_ref()
                    .is_none_or(|(previous, _)| previous != &policy)
                {
                    *cached = Some((
                        policy.clone(),
                        Arc::new(maka_network::TlsConfigCache::default()),
                    ));
                }
                cached.as_ref().unwrap().1.clone()
            };
            let connections = maka_network::ConnectionTasks::default();
            let client = tls
                .build(
                    connections
                        .client_builder(policy.client_builder())
                        .read_timeout(Duration::from_secs(60))
                        .redirect(reqwest::redirect::Policy::none()),
                )
                .map_err(failed)?;
            let method = match input.method {
                Method::Get => reqwest::Method::GET,
                Method::Head => reqwest::Method::HEAD,
                Method::Post => reqwest::Method::POST,
                Method::Put => reqwest::Method::PUT,
                Method::Patch => reqwest::Method::PATCH,
                Method::Delete => reqwest::Method::DELETE,
                Method::Options => reqwest::Method::OPTIONS,
            };
            let operation = maka_event_log::effects::Operation::Http {
                method: input.method,
                url: url.to_string(),
                body_length: input.body.length(),
            };
            let stop = CancellationToken::new();
            let length = input.body.length();
            let upload_stop = CancellationToken::new();
            let (upload, mut receipt) = upload::body(input.body, upload_stop.clone());
            let mut request = client.request(method, url).headers(headers).body(upload);
            if let Some(length) = length {
                request = request.header(reqwest::header::CONTENT_LENGTH, length);
            }
            let mut ticket = call.resources.reserve().map_err(failed)?;
            let (head, response) = oneshot::channel();
            let (send, output) = mpsc::channel(1);
            let (ended, finished) = watch::channel(None);
            let body = Arc::new(ResponseBody {
                authority: self.authority.clone(),
                call: call.clone(),
                destination: destination.clone(),
                stop: stop.clone(),
                output: tokio::sync::Mutex::new(output),
                ended: finished,
            });
            let authority = self.authority.clone();
            self.authority.spawn(Box::new(move |retiring| Box::pin(async move {
                ticket.start();
                let cancellation = call.cancellation.clone();
                let effect = Box::pin(async move {
                    let result = tokio::select! {
                        biased;
                        _ = stop.cancelled() => Err("HTTP response closed".into()),
                        _ = retiring.cancelled() => Err("plugin retired during HTTP response".into()),
                        _ = cancellation.cancelled() => Err("invocation closed".into()),
                        result = worker::run(request, head, send) => result,
                    };
                    upload_stop.cancel();
                    connections.close().await;
                    let upload = receipt.finish().await.map_err(|error|
                        ToolError::CleanupUnconfirmed(error.to_string()))?;
                    match result {
                        Ok(mut outcome) => {
                            outcome["upload"] = upload;
                            Ok(outcome)
                        }
                        Err(error) => Err(ToolError::OutcomeUnknown(format!("{error}; upload={upload}"))),
                    }
                });
                let result = authority.record(call, operation, destination, effect).await;
                // Cancelling local I/O cannot roll back remote side effects.
                let settled = match &result {
                    Err(error @ (ToolError::Persistence(_) | ToolError::CleanupUnconfirmed(_))) =>
                        Err(error.to_string()),
                    _ => Ok(()),
                };
                ticket.complete(settled.clone());
                ended.send_replace(Some(Completion { result: result.map(|_| ()).map_err(|error| error.to_string()), settled: settled.clone() }));
                settled
            })))?;
            match response.await {
                Ok(Ok(head)) => Ok(Response { head, body }),
                result => {
                    body.close().await?;
                    Err(failed(match result {
                        Ok(Err(error)) => error,
                        _ => "HTTP request interrupted; remote outcome may be unknown".into(),
                    }))
                }
            }
        })
    }
}
#[derive(Clone)]
struct Completion {
    result: Result<(), String>,
    settled: Result<(), String>,
}
struct ResponseBody {
    authority: Arc<dyn Authority>,
    call: Scope,
    destination: maka_sandbox::Destination,
    stop: CancellationToken,
    output: tokio::sync::Mutex<mpsc::Receiver<Vec<u8>>>,
    ended: watch::Receiver<Option<Completion>>,
}
impl Drop for ResponseBody {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}
impl Body for ResponseBody {
    fn next(&self) -> BoxFuture<'_, Result<Option<Vec<u8>>, Error>> {
        Box::pin(async move {
            let _lease = self.authority.admit(&self.call)?;
            if self.call.cancellation.is_cancelled() {
                return Err(Error::Denied);
            }
            self.authority.check(&self.call, &self.destination).await?;
            let mut output = self
                .output
                .try_lock()
                .map_err(|_| invalid("HTTP response already has a reader"))?;
            tokio::select! {
                biased;
                _ = self.call.cancellation.cancelled() => Err(Error::Denied),
                _ = self.stop.cancelled() => Err(Error::Denied),
                chunk = output.recv() => match chunk {
                    Some(bytes) => Ok(Some(bytes)),
                    None => {
                        let mut ended = self.ended.clone();
                        ended.wait_for(Option::is_some).await.map_err(failed)?;
                        let result = ended.borrow().as_ref().unwrap().result.clone();
                        result.map(|()| None).map_err(failed)
                    }
                },
            }
        })
    }
    fn cancel(&self) {
        self.stop.cancel();
    }
    fn close(&self) -> BoxFuture<'_, Result<(), Error>> {
        self.cancel();
        Box::pin(async move {
            let mut ended = self.ended.clone();
            tokio::time::timeout(Duration::from_secs(5), ended.wait_for(Option::is_some))
                .await
                .map_err(|_| Error::CleanupUnconfirmed)?
                .map_err(|_| Error::CleanupUnconfirmed)?;
            let settled = ended.borrow().as_ref().unwrap().settled.clone();
            settled.map_err(|_| Error::CleanupUnconfirmed)
        })
    }
}
fn invalid(error: impl ToString) -> Error {
    Error::Invalid(error.to_string())
}
fn failed(error: impl ToString) -> Error {
    Error::Failed(error.to_string())
}
fn message(error: impl ToString) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests;
