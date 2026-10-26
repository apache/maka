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

use super::{Owner, execute};
use maka_app_client::{Mutation, MutationEvent};
use nsh_core::JsonValue;
use nsh_core::prelude::*;
use serde_json::json;
use std::sync::Arc;

/// One original Settings attempt, including its transient progress and cleanup.
#[class]
pub struct OriginalMutation {
    owner: Arc<Owner>,
    mutation: Arc<Mutation>,
}

impl OriginalMutation {
    pub(super) fn new(owner: Arc<Owner>, mutation: Mutation) -> Self {
        Self {
            owner,
            mutation: Arc::new(mutation),
        }
    }
}

impl Drop for OriginalMutation {
    fn drop(&mut self) {
        self.mutation.request_cancel();
        let mutation = self.mutation.clone();
        let _ = self.owner.spawn(async move { mutation.close().await });
        // Once task admission closes, Client.close owns final session cleanup.
    }
}

#[class]
impl OriginalMutation {
    #[getter]
    pub fn operation_id(&self) -> String {
        self.mutation.id().to_string()
    }

    /// Pull the original Call. A finished business receipt survives cleanup failure.
    pub async fn next(this: Instance<Self>) -> Result<JsonValue, String> {
        let (owner, mutation) =
            this.with(|original| (original.owner.clone(), original.mutation.clone()));
        drop(this);
        execute(owner, async move {
            match mutation.next().await? {
                Some(MutationEvent::Progress(value)) => {
                    Ok(json!({"kind":"progress","value":value}))
                }
                Some(MutationEvent::NotDispatched) => Ok(json!({"kind":"not_dispatched"})),
                Some(MutationEvent::Finished { reply, cleanup }) => Ok(json!({
                    "kind":"finished", "reply":reply, "cleanupError":cleanup.err()
                })),
                None => Ok(JsonValue::Null),
            }
        })
        .await
    }

    /// Request cancellation of this operation; only its original receipt decides the result.
    pub fn cancel(&self) {
        self.mutation.request_cancel();
    }
}
