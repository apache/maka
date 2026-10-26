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

use maka_agent_ports::model::Binding;
use maka_agent_ports::model::Error;
use maka_agent_ports::model::Lifetime;
use maka_agent_ports::model::Session;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

/// Disposable protocol state. Adapter replacement creates a fresh session;
/// canonical input remains sufficient without this cache.
#[derive(Clone, Default)]
pub struct Conversation {
    state: Arc<Mutex<Option<BoundSession>>>,
    opening: Arc<AsyncMutex<()>>,
}
struct BoundSession {
    binding: Binding,
    session: Arc<dyn Session>,
}
impl Conversation {
    pub fn try_switch_fallback_transport(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|bound| bound.session.try_switch_fallback_transport())
    }

    pub(crate) async fn session(
        &self,
        binding: &Binding,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<Arc<dyn Session>, Error> {
        let _opening = self.opening.lock().await;
        if let Some(previous) = &*self.state.lock().unwrap()
            && previous.binding.same_registration(binding)
        {
            return Ok(previous.session.clone());
        }
        let session = binding.open(Lifetime::Conversation, cancellation).await?;
        *self.state.lock().unwrap() = Some(BoundSession {
            binding: binding.clone(),
            session: session.clone(),
        });
        Ok(session)
    }
    pub fn needs_confirmation(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|bound| bound.session.needs_confirmation())
    }
    pub async fn confirm(
        &self,
        prompt: &maka_agent_facts::model::prompt_source::Prompt,
        settled_tool_call_ids: &[&str],
        response_id: Option<&str>,
    ) -> bool {
        let session = self
            .state
            .lock()
            .unwrap()
            .as_ref()
            .map(|bound| bound.session.clone());
        match session {
            Some(session) => {
                session
                    .confirm(prompt, settled_tool_call_ids, response_id)
                    .await
            }
            None => false,
        }
    }
}
