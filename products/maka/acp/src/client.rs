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

//! ACP calls the selected application services; it has no operation-name adapter.
use crate::Error;
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::{
    CallResources,
    host::{Client as Host, LocalCall},
    transport::wire::Reply,
};
use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Client(Arc<Inner>);
struct Inner {
    host: AsyncMutex<Host>,
    stop: CancellationToken,
    // Original calls, including immutable resources and recovery references.
    // An interrupted observer never discards these or retries confirmation.
    unsettled: Mutex<Vec<LocalCall>>,
}
struct Call {
    owner: Client,
    original: Option<LocalCall>,
}
impl Call {
    fn original(&mut self) -> &mut LocalCall {
        self.original.as_mut().expect("original call")
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        if let Some(call) = self.original.take()
            && !call.cleanup_confirmed()
        {
            self.owner.0.stop.cancel();
            self.owner.0.unsettled.lock().unwrap().push(call);
        }
    }
}
impl Client {
    pub fn new(host: Host, stop: CancellationToken) -> Self {
        Self(Arc::new(Inner {
            host: AsyncMutex::new(host),
            stop,
            unsettled: Mutex::default(),
        }))
    }
    async fn open(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        resources: Attachments,
    ) -> Result<Call, Error> {
        let host = self.0.host.lock().await;
        let original = host.call(endpoint, method.into(), input, resources).await?;
        drop(host);
        let mut call = Call {
            owner: self.clone(),
            original: Some(original),
        };
        call.original().start().await?;
        Ok(call)
    }
    pub async fn query<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<T, Error> {
        let mut call = self
            .open(endpoint, method, input, Attachments::new())
            .await?;
        match call.original().receive().await? {
            Reply::Finished { result, cleanup } => {
                cleanup?;
                Ok(serde_json::from_value(result?)?)
            }
            Reply::Aborted { reason, cleanup } => {
                cleanup?;
                Err(reason.into())
            }
            _ => {
                call.original().close().await?;
                Err("Expected an application query result".into())
            }
        }
    }
    pub async fn mutate<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
        resources: Attachments,
    ) -> Result<T, Error> {
        let descriptors = CallResources::from(resources.clone()).descriptors()?;
        let reacquisition = if descriptors.is_empty() {
            serde_json::json!({"kind": "none"})
        } else {
            serde_json::json!({"kind": "unavailable", "reason": "live_only_request_resources"})
        };
        let mut recovery = serde_json::json!({
            "kind": "maka_acp_mutation",
            "version": 1,
            "request": {"endpoint": endpoint, "method": method, "input": input},
            "resources": {"descriptors": descriptors, "reacquisition": reacquisition},
        });
        let mut call = self.open(endpoint, method, input, resources).await?;
        match call.original().receive().await? {
            Reply::Prepared { reference } => {
                recovery["reference"] = serde_json::to_value(reference)?;
            }
            Reply::Aborted { reason, cleanup } => {
                cleanup?;
                return Err(reason.into());
            }
            _ => {
                call.original().close().await?;
                return Err("Expected original mutation preparation".into());
            }
        }
        // Keep the same original call even when confirmation has an uncertain result.
        let mut result = call.original().confirm(recovery).await;
        loop {
            match result {
                Ok(Reply::Mutation { reply, cleanup }) => {
                    cleanup?;
                    return match reply.receipt {
                        Receipt::Recorded {
                            outcome:
                                OperationOutcome::Returned {
                                    result: OperationResult::Success { value },
                                },
                            cleanup: OperationCleanup::Confirmed,
                        } => Ok(serde_json::from_value(value)?),
                        Receipt::Recorded {
                            outcome:
                                OperationOutcome::Returned {
                                    result: OperationResult::Failure { diagnostic },
                                },
                            cleanup: OperationCleanup::Confirmed,
                        } => Err(diagnostic.into()),
                        Receipt::Recorded {
                            outcome: OperationOutcome::NotExecuted { .. },
                            cleanup: OperationCleanup::Confirmed,
                        } => Err("Application mutation was prevented before execution".into()),
                        receipt => {
                            self.0.stop.cancel();
                            Err(format!("Application mutation has no confirmed result: {receipt:?}; original reference: {}", serde_json::to_string(&reply.reference)?).into())
                        }
                    };
                }
                Ok(Reply::Progress { .. }) => {
                    result = call.original().receive().await;
                }
                Ok(Reply::Aborted { reason, cleanup }) => {
                    cleanup?;
                    return Err(reason.into());
                }
                Ok(_) => {
                    call.original().close().await?;
                    return Err("Expected an application mutation receipt".into());
                }
                Err(error) => {
                    let reference = call
                        .original()
                        .reference()
                        .map(serde_json::to_string)
                        .transpose()?;
                    return Err(format!("Application mutation result is unresolved: {error}; original reference: {}", reference.as_deref().unwrap_or("unavailable")).into());
                }
            }
        }
    }
    pub async fn subscribe(
        &self,
        endpoint: &str,
        method: &str,
        input: Value,
    ) -> Result<Subscription, Error> {
        let mut call = self
            .open(endpoint, method, input, Attachments::new())
            .await?;
        match call.original().receive().await? {
            Reply::Subscribed => Ok(Subscription(call)),
            Reply::Aborted { reason, cleanup } => {
                cleanup?;
                Err(reason.into())
            }
            _ => {
                call.original().close().await?;
                Err("Expected an application subscription".into())
            }
        }
    }
    /// Only the original session acknowledgement proves all its calls drained.
    pub async fn close(&self) -> Result<(), Error> {
        self.0.stop.cancel();
        self.0.host.lock().await.close().await?;
        self.0.unsettled.lock().unwrap().clear();
        Ok(())
    }
}
pub(crate) struct Subscription(Call);
impl Subscription {
    pub async fn next<T: DeserializeOwned>(&mut self) -> Result<T, Error> {
        match self.0.original().pull().await? {
            Reply::Item { value } => Ok(serde_json::from_value(value)?),
            Reply::Aborted { reason, cleanup } => {
                cleanup?;
                Err(reason.into())
            }
            Reply::Finished { result, cleanup } => {
                cleanup?;
                result?;
                Err("Application observation ended".into())
            }
            _ => Err("Unexpected application observation reply".into()),
        }
    }
    pub async fn close(mut self) -> Result<(), Error> {
        Ok(self.0.original().close().await?)
    }
}
