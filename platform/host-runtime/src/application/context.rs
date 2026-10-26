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

use super::*;

/// Actual request capabilities shared by native and JavaScript services.
/// Imports are captured from the consumer activation, never resolved by a
/// guest-supplied global name. Calls preserve the original private Scope evidence.
pub struct Context {
    pub(super) stream: Option<subscriptions::Emitter>,
    pub(super) caller: Option<Caller>,
    pub(super) scope: Scope,
    pub(super) consumer: Activation,
    pub(super) requester: Activation,
    pub(super) operation: Option<RecoveryRef>,
    pub(super) operation_scope:
        Option<maka_event_log::applications::operations::OperationDispatchScope>,
    pub(super) attachments: Attachments,
    pub(super) imports: Arc<BTreeMap<String, Vec<Binding>>>,
    pub(super) dispatch: Weak<Dispatch>,
}
impl Context {
    /// Actual calling activation, captured by dispatch. Resource services may
    /// bind handles to this identity; possession of it does not grant access.
    pub fn requester(&self) -> &Activation {
        &self.requester
    }
    /// Original policy-authenticated caller, if the embedding supplies one.
    /// Equality is only an additional resource-ownership check, never a grant.
    pub fn caller(&self) -> Option<&Caller> {
        self.caller.as_ref()
    }
    /// Publish bounded, schema-checked subscription or mutation progress. Backpressure waits
    /// for the reader; producer completion or cancellation rejects further emits.
    pub fn emit(&self, value: Value) -> BoxFuture<'static, Result<()>> {
        match &self.stream {
            Some(stream) => stream.emit(value),
            None => Box::pin(async { Err("request does not declare a progress stream".into()) }),
        }
    }
    pub fn operation(&self) -> Option<&RecoveryRef> {
        self.operation.as_ref()
    }
    /// Proof of the actual original Host dispatch, never reconstructed from a receipt.
    pub fn operation_scope(
        &self,
    ) -> Option<&maka_event_log::applications::operations::OperationDispatchScope> {
        self.operation_scope.as_ref()
    }
    pub fn execution_custody(&self) -> Option<&Arc<dyn maka_agent_facts::tools::ExecutionCustody>> {
        self.scope.execution()
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
    pub fn attachments(&self) -> &Attachments {
        &self.attachments
    }
    /// Enqueues work before returning its observer. Dropping that observer cannot
    /// acknowledge cleanup or cancel an accepted child. The parent waits for the
    /// actual executor's cleanup, independently of its business result.
    pub fn call(
        &self,
        import: &str,
        provider: usize,
        method: String,
        input: Value,
        attachments: Attachments,
    ) -> Result<BoxFuture<'static, Result<Value>>> {
        let (reply, result) = oneshot::channel();
        self.enqueue(
            import,
            provider,
            method,
            input,
            attachments.into(),
            self.scope.clone(),
            CallKind::Query(reply),
        )?;
        Ok(Box::pin(async move {
            result
                .await
                .map_err(|_| "Host deployment is closed".to_string())??
                .result()
                .await
        }))
    }
    /// Captures and enqueues a child subscription before returning its observer.
    /// Closing demand cancels only this child; the parent Ticket waits for the
    /// actual executor's cleanup, including when the observer is dropped.
    pub fn subscribe(
        &self,
        import: &str,
        provider: usize,
        method: String,
        input: Value,
        attachments: Attachments,
    ) -> Result<BoxFuture<'static, Result<Subscription>>> {
        let scope = self.scope.child().map_err(|error| error.to_string())?;
        let guard = scope.cancellation.clone().drop_guard();
        let (reply, result) = oneshot::channel();
        self.enqueue(
            import,
            provider,
            method,
            input,
            attachments.into(),
            scope,
            CallKind::Subscription { reply },
        )?;
        Ok(Box::pin(async move {
            let subscription = result
                .await
                .map_err(|_| "Host deployment is closed".to_string())??;
            guard.disarm();
            Ok(subscription)
        }))
    }
    /// The observer's outer Err is admission failure. Once accepted, business
    /// uncertainty is always an OperationReply with its original RecoveryRef.
    /// A clean refusal additionally requires this request Scope's real finish.
    #[allow(clippy::too_many_arguments)]
    pub fn mutate(
        &self,
        import: &str,
        provider: usize,
        method: String,
        input: Value,
        operation: Uuid,
        attachments: impl Into<CallResources>,
    ) -> Result<BoxFuture<'static, Result<OperationReply>>> {
        let result =
            self.begin_mutation(import, provider, method, input, operation, attachments)?;
        Ok(Box::pin(async move { Ok(result.await?.result().await) }))
    }
    /// Enqueues the same durable mutation and exposes its original progress
    /// reader. Final receipt and physical cleanup remain independent; dropping
    /// this observer cannot release the accepted request's parent Ticket.
    pub fn begin_mutation(
        &self,
        import: &str,
        provider: usize,
        method: String,
        input: Value,
        operation: Uuid,
        attachments: impl Into<CallResources>,
    ) -> Result<BoxFuture<'static, Result<Mutation>>> {
        let (reply, result) = oneshot::channel();
        self.enqueue(
            import,
            provider,
            method,
            input,
            attachments.into(),
            self.scope.clone(),
            CallKind::Mutation {
                operation,
                confirmation: None,
                reply,
            },
        )?;
        Ok(Box::pin(async move {
            result
                .await
                .map_err(|_| "Host deployment is closed".to_string())?
        }))
    }
    /// Uses the original reference, never the current import/provider selection.
    pub fn recover(
        &self,
        reference: RecoveryRef,
    ) -> Result<BoxFuture<'static, Result<Option<OperationObservation>>>> {
        if self.scope.cancellation.is_cancelled() {
            return Err("Host request was revoked".into());
        }
        let dispatch = self.dispatch.upgrade().ok_or("Host deployment is closed")?;
        let ticket = self.scope.resources.reserve().map_err(|e| e.to_string())?;
        let result = dispatch.recover(
            self.consumer.clone(),
            reference,
            self.scope.clone(),
            Some(ticket),
        )?;
        Ok(Box::pin(async move {
            result
                .await
                .map_err(|_| "Host deployment is closed".to_string())?
        }))
    }
    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &self,
        import: &str,
        provider: usize,
        method: String,
        input: Value,
        attachments: CallResources,
        scope: Scope,
        kind: CallKind,
    ) -> Result<()> {
        if self.scope.cancellation.is_cancelled() {
            return Err("Host request was revoked".into());
        }
        let binding = self
            .imports
            .get(import)
            .and_then(|providers| providers.get(provider))
            .ok_or("unknown request import provider")?
            .clone();
        let dispatch = self.dispatch.upgrade().ok_or("Host deployment is closed")?;
        attachments.check_scope(&scope)?;
        // A captured input already owns its original Ticket and reservations.
        // Local descriptors reserve before their first trait call as before.
        let ticket = if attachments.captured() {
            None
        } else {
            Some(self.scope.resources.reserve().map_err(|e| e.to_string())?)
        };
        dispatch.enqueue(binding, method, input, scope, attachments, ticket, kind)?;
        Ok(())
    }
}
