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

//! Terminal effects use the admitted Host, its original Calls and durable client receipts.
use super::{Scope, execute, require_contract};
use maka_app_client::MutationEvent;
use nsh_core::JsonValue;
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

fn session<'a>(method: &str, input: &'a JsonValue) -> Result<&'a str, String> {
    let target = match method {
        "start" => input,
        "stop" => input,
        "release" => &input["target"],
        "control" => &input["controller"]["target"],
        _ => return Err("Unsupported terminal mutation".into()),
    };
    target["sessionId"]
        .as_str()
        .ok_or_else(|| "Terminal action has no session owner".into())
}

/// Execute exactly one original terminal action in this immutable session.
pub(super) async fn mutate(
    scope: Arc<Scope>,
    method: String,
    input: JsonValue,
) -> Result<JsonValue, String> {
    if session(&method, &input)? != scope.session {
        return Err("Terminal action belongs to another session".into());
    }
    execute(scope.owner.clone(), async move {
        let client = scope.client.resolve(&scope.owner).await?;
        require_contract(
            "terminal",
            &method,
            &client.describe("terminal").await?.contract,
        )?;
        let id = Uuid::new_v4();
        let mutation = client
            .terminal_mutation(id, &method, input, &scope.session)
            .await?;
        let result: Result<(_, Option<String>), String> = async {
            mutation.prepare().await?;
            loop {
                match mutation.next().await? {
                    Some(MutationEvent::Finished { reply, cleanup }) => {
                        break Ok((reply, cleanup.err()));
                    }
                    Some(MutationEvent::Progress(_)) => {}
                    Some(MutationEvent::NotDispatched) => {
                        return Err("Terminal action did not dispatch".into());
                    }
                    None => return Err("Terminal action ended without its original receipt".into()),
                }
            }
        }
        .await;
        // Neither a hidden tab nor a JS exception is a physical cleanup receipt.
        let closed = mutation.close().await;
        let (reply, cleanup) = result?;
        Ok(json!({"operationId":id,"reply":reply,"cleanupError":cleanup.or(closed.err())}))
    })
    .await
}

/// Unknown originals survive a view or launcher restart; never repeat their input.
pub(super) async fn pending(scope: Arc<Scope>) -> Result<JsonValue, String> {
    execute(scope.owner.clone(), async move {
        let client = scope.client.local(&scope.owner).await?;
        serde_json::to_value(client.pending_terminals(&scope.session).await?)
            .map_err(|error| error.to_string())
    })
    .await
}

/// Recover only an original owned by this exact session and terminal service.
pub(super) async fn recover(scope: Arc<Scope>, operation_id: String) -> Result<JsonValue, String> {
    let id = Uuid::parse_str(&operation_id).map_err(|error| error.to_string())?;
    execute(scope.owner.clone(), async move {
        let client = scope.client.local(&scope.owner).await?;
        client.operation_for_terminal(id, &scope.session).await?;
        serde_json::to_value(client.recover(id).await?).map_err(|error| error.to_string())
    })
    .await
}

/// Fence only an original whose preparation did not commit, without replaying it.
pub(super) async fn abandon(scope: Arc<Scope>, operation_id: String) -> Result<JsonValue, String> {
    let id = Uuid::parse_str(&operation_id).map_err(|error| error.to_string())?;
    execute(scope.owner.clone(), async move {
        let client = scope.client.local(&scope.owner).await?;
        client.operation_for_terminal(id, &scope.session).await?;
        serde_json::to_value(client.abandon_unprepared(id).await?)
            .map_err(|error| error.to_string())
    })
    .await
}
