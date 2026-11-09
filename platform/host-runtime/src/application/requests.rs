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

use super::abi::{HostRequest, ResourceMetadata};
use super::operations::{receipt_reply, receipt_value};
use super::*;

impl Context {
    /// Execute a typed script request using this original admitted context.
    pub fn request(&self, operation: HostRequest) -> BoxFuture<'static, Result<Value>> {
        let result = (|| match operation {
            HostRequest::StateRead { key } => {
                let result = self.state_read(key)?;
                Ok(Box::pin(async move {
                    serde_json::to_value(result.await?).map_err(|error| error.to_string())
                }) as BoxFuture<'static, Result<Value>>)
            }
            HostRequest::StateScan { query } => {
                let result = self.state_scan(query)?;
                Ok(Box::pin(async move {
                    serde_json::to_value(result.await?).map_err(|error| error.to_string())
                }) as BoxFuture<'static, Result<Value>>)
            }
            HostRequest::CompleteState { .. } => {
                Err("pure state completion is only available through the callback bridge".into())
            }
            HostRequest::Emit { value } => {
                let emitted = self.emit(value);
                Ok(Box::pin(async move {
                    emitted.await?;
                    Ok(Value::Null)
                }) as BoxFuture<'static, Result<Value>>)
            }
            HostRequest::Call {
                import,
                provider,
                method,
                input,
                attachments,
            } => {
                let attachments = self.forward(attachments)?;
                self.call(&import, provider, method, input, attachments)
            }
            HostRequest::Mutate {
                import,
                provider,
                method,
                input,
                operation_id,
                recovery,
                attachments,
            } => {
                let result = self.mutate(
                    &import,
                    provider,
                    method,
                    input,
                    operation_id,
                    recovery,
                    self.forward(attachments)?,
                )?;
                Ok(Box::pin(async move { receipt_value(result.await?) })
                    as BoxFuture<'static, Result<Value>>)
            }
            HostRequest::LookupIntent { operation_id } => {
                let result = self.lookup_intent(operation_id)?;
                Ok(Box::pin(async move {
                    serde_json::to_value(result.await?).map_err(|e| e.to_string())
                }) as BoxFuture<'static, Result<Value>>)
            }
            HostRequest::Recover { reference } => {
                let result = self.recover(reference.clone())?;
                Ok(
                    Box::pin(async move { receipt_value(receipt_reply(reference, result.await)) })
                        as BoxFuture<'static, Result<Value>>,
                )
            }
            operation => {
                let result = self.read(operation);
                Ok(Box::pin(async move { result }) as BoxFuture<'static, Result<Value>>)
            }
        })();
        Box::pin(async move {
            match result {
                Ok(observer) => observer.await,
                Err(error) => Err(error),
            }
        })
    }
}
impl Context {
    fn forward(&self, attachments: BTreeMap<String, String>) -> Result<Attachments> {
        attachments
            .into_iter()
            .map(|(target, source)| {
                self.attachments
                    .get(&source)
                    .cloned()
                    .map(|resource| (target, resource))
                    .ok_or_else(|| "unknown request resource slot".to_string())
            })
            .collect()
    }
    fn read(&self, operation: HostRequest) -> Result<Value> {
        if self.scope.cancellation.is_cancelled() {
            return Err("Host request was revoked".into());
        }
        let slot = match &operation {
            HostRequest::Metadata { slot } | HostRequest::Read { slot, .. } => slot,
            HostRequest::Emit { .. }
            | HostRequest::Call { .. }
            | HostRequest::Mutate { .. }
            | HostRequest::Recover { .. }
            | HostRequest::LookupIntent { .. }
            | HostRequest::StateRead { .. }
            | HostRequest::StateScan { .. }
            | HostRequest::CompleteState { .. } => {
                unreachable!()
            }
        };
        let resource = self
            .attachments
            .get(slot)
            .ok_or("unknown request resource slot")?;
        let mut ticket = self.scope.resources.reserve().map_err(|e| e.to_string())?;
        ticket.start();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match operation {
            HostRequest::Metadata { .. } => {
                let value = serde_json::to_value(ResourceMetadata {
                    resource_type: resource.resource_type(),
                    bytes: resource.bytes(),
                    metadata: resource.metadata(),
                })
                .map_err(|error| error.to_string())?;
                Ok(value)
            }
            HostRequest::Read { start, end, .. } => {
                if end < start || end - start > 64 * 1024 || end > resource.bytes() {
                    return Err("invalid request resource byte range".into());
                }
                let bytes = resource.read(start..end)?;
                if bytes.len() != end - start {
                    return Err("request resource returned a different byte count".into());
                }
                Ok(serde_json::json!(bytes))
            }
            HostRequest::Emit { .. }
            | HostRequest::Call { .. }
            | HostRequest::Mutate { .. }
            | HostRequest::Recover { .. }
            | HostRequest::LookupIntent { .. }
            | HostRequest::StateRead { .. }
            | HostRequest::StateScan { .. }
            | HostRequest::CompleteState { .. } => {
                unreachable!()
            }
        }));
        match result {
            Ok(result) => {
                ticket.complete(Ok(()));
                result
            }
            Err(_) => {
                let error = "native request resource panicked; cleanup unconfirmed".to_string();
                ticket.complete(Err(error.clone()));
                Err(error)
            }
        }
    }
}
