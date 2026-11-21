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
use maka_event_log::root_store::ActionDefinitionChange;
use maka_workspace_api::{
    actions::{ActionDefinition, ActionId, Create, Project, Remove, Update},
    terminal::Outcome,
};
use uuid::Uuid;

pub(super) struct Service(pub(super) Arc<Processes>);
impl Handler for Service {
    fn call(
        &self,
        name: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let owner = self.0.clone();
        Box::pin(async move {
            owner
                .action_user(&context)
                .map_err(|e| HandlerError::from(e.to_string()))?;
            if matches!(name.as_str(), "create" | "update" | "remove")
                && context.operation().is_none()
            {
                return Err("Action mutation requires an operation".into());
            }
            let mut ticket = context
                .scope()
                .resources
                .reserve()
                .map_err(|e| HandlerError::from(e.to_string()))?;
            ticket.start();
            let result = owner.action_call(&name, input, &context).await;
            ticket.complete(Ok(()));
            match result {
                Ok(value) => Ok(value),
                Err(ToolError::Failed(message) | ToolError::Io { message, .. }) => {
                    Ok(HandlerValue::Json(
                        serde_json::to_value(Outcome::<Value>::Failed { message })
                            .map_err(|e| HandlerError::from(e.to_string()))?,
                    ))
                }
                Err(error) => Err(HandlerError::from(error.to_string())),
            }
        })
    }
}
fn decode<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, ToolError> {
    serde_json::from_value(input).map_err(failed)
}
fn completed(value: impl serde::Serialize) -> Result<Value, ToolError> {
    super::terminal::completed(value)
}
impl Processes {
    fn action_user(&self, context: &Context) -> Result<(), ToolError> {
        if !matches!(
            context.scope().identity,
            maka_capabilities::call::Identity::Remote { .. }
        ) || context.caller().is_none()
            || context.native_context::<NativeCallContext>().is_some()
        {
            return Err(failed(
                "Project Actions require an admitted interactive user client",
            ));
        }
        cancelled(&context.scope().cancellation)?;
        if self.drain.is_cancelled() {
            return Err(failed("Process owner is draining"));
        }
        Ok(())
    }
    async fn action_project(
        &self,
        id: &str,
    ) -> Result<maka_event_log::projects::ProjectRecord, ToolError> {
        let prefix = self
            .session_prefix
            .as_ref()
            .ok_or_else(|| failed("Project owner is not configured"))?;
        self.store
            .get_project(id)
            .await
            .map_err(persistence)?
            .filter(|project| {
                project.archived_at.is_none()
                    && project.identity.starts_with(&format!("{prefix}project:"))
            })
            .ok_or_else(|| failed("Project is unavailable in this provider"))
    }
    async fn action_call(
        &self,
        name: &str,
        input: Value,
        context: &Context,
    ) -> Result<HandlerValue, ToolError> {
        let change = match name {
            "definitions" => {
                let input: Project = decode(input)?;
                let project = self.action_project(&input.project_id).await?;
                return completed(
                    self.store
                        .action_definitions(&project.id)
                        .await
                        .map_err(persistence)?,
                )
                .map(HandlerValue::Json);
            }
            "create" => {
                let input: Create = decode(input)?;
                validate_definition(&input.name, &input.command)?;
                let project = self.action_project(&input.project_id).await?;
                ActionDefinitionChange::Create(ActionDefinition {
                    id: ActionId(Uuid::new_v4()),
                    project_id: project.id,
                    revision: 1,
                    name: input.name.trim().into(),
                    command: input.command,
                })
            }
            "update" => {
                let input: Update = decode(input)?;
                validate_definition(&input.name, &input.command)?;
                let project = self.action_project(&input.project_id).await?;
                let revision = input
                    .revision
                    .checked_add(1)
                    .filter(|v| *v <= maka_workspace_api::terminal::MAX_SEQUENCE)
                    .ok_or_else(|| failed("Action revision exhausted"))?;
                ActionDefinitionChange::Update {
                    definition: ActionDefinition {
                        id: input.id,
                        project_id: project.id,
                        revision,
                        name: input.name.trim().into(),
                        command: input.command,
                    },
                    expected_revision: input.revision,
                }
            }
            "remove" => {
                let input: Remove = decode(input)?;
                let project = self.action_project(&input.project_id).await?;
                ActionDefinitionChange::Remove {
                    project: project.id,
                    id: input.id,
                    expected_revision: input.revision,
                }
            }
            _ => return Err(failed("Action method is unavailable")),
        };
        let change = self
            .store
            .prepare_action_definition(change, |value| Outcome::Completed { value })
            .map_err(persistence)?;
        context.complete_result(change).map_err(persistence)
    }
}
fn validate_definition(name: &str, command: &str) -> Result<(), ToolError> {
    if name.trim().is_empty()
        || name.len() > 128
        || name.contains('\0')
        || command.trim().is_empty()
        || command.len() > 4 * 1024
        || command.contains('\0')
    {
        return Err(failed(
            "Action requires a name up to 128 bytes and a command up to 4 KiB",
        ));
    }
    Ok(())
}
