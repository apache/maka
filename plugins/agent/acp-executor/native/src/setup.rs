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
use maka_agent_ports::remote::Error;
use maka_external_agent::{
    ports::Ports,
    setup::{Action, Outcome, Progress},
};

pub(super) async fn run(
    owner: Arc<Owner>,
    input: Value,
    context: Arc<Context>,
) -> Result<Value, String> {
    context.operation().ok_or("ACP setup requires a mutation")?;
    let authority = context
        .native_context::<maka_agent_authority::setup::ActualSetupContext>()
        .ok_or("ACP setup requires its actual top-level native setup capability")?;
    authority
        .0
        .bind_original(&context)
        .await
        .map_err(|error| error.to_string())?;
    let action: Action = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut scope = owner
        .calls
        .issuer
        .issue_with(
            context.scope().identity.clone(),
            Arc::new(calls::Issued {
                origin: context.clone(),
                role: calls::Role::Setup(authority),
                process: std::sync::Mutex::new(calls::ProcessSlot::Available),
            }),
            context.scope().cancellation.clone(),
        )
        .map_err(|error| error.to_string())?;
    scope
        .restrict_sandbox(context.scope().sandbox_floor())
        .map_err(|error| error.to_string())?;
    let mut ticket = context
        .scope()
        .resources
        .reserve()
        .map_err(|e| e.to_string())?;
    ticket.start();
    let result = maka_external_agent::setup::execute(
        &owner.agent,
        Ports {
            processes: owner.processes.clone(),
            storage: owner.storage.clone(),
            callbacks: owner.calls.clone(),
        },
        scope.clone(),
        action,
        &Output(context),
    )
    .await;
    let scoped = scope.finish().await.map_err(|error| error.to_string());
    let processes = owner.processes.settle_task(&scope).await.map(|_| ());
    let cleanup = scoped.and(processes);
    match &cleanup {
        Ok(()) => ticket.complete(Ok(())),
        Err(error) => ticket.unconfirmed(error.clone(), scope),
    }
    cleanup?;
    let result: Outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => Outcome::Unresolved {
            diagnostic: error.to_string(),
        },
    };
    serde_json::to_value(result).map_err(|e| e.to_string())
}
struct Output(Arc<Context>);
impl maka_external_agent::setup::Output for Output {
    fn emit(&self, value: Progress) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            self.0
                .emit(serde_json::to_value(value).map_err(|e| Error::Provider(e.to_string()))?)
                .await
                .map_err(Error::Provider)
        })
    }
}
