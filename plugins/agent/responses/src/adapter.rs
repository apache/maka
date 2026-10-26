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

use crate::{Lane, transport::Shared};
use futures_util::future::BoxFuture;
use maka_agent_facts::model::prompt_source::Prompt;
use maka_agent_ports::model::Context;
use maka_agent_ports::model::Error;
use maka_agent_ports::model::Lifetime;
use maka_agent_ports::model::ProviderAdapter;
use maka_agent_ports::model::Request;
use maka_agent_ports::model::Session;
use std::sync::Arc;

/// Native protocol implementation; all network capabilities come from Host.
#[derive(Default)]
pub struct Adapter {
    transport: Arc<Shared>,
}
impl ProviderAdapter for Adapter {
    fn supports_item_acceptance(&self) -> bool {
        true
    }
    fn enforces_idle_timeout(&self) -> bool {
        true
    }

    fn open(
        &self,
        lifetime: Lifetime,
        _: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn Session>, Error>> {
        let session = Native {
            transport: self.transport.clone(),
            lane: matches!(lifetime, Lifetime::Conversation).then(Lane::default),
        };
        Box::pin(async { Ok(Arc::new(session) as Arc<dyn Session>) })
    }
}
struct Native {
    transport: Arc<Shared>,
    lane: Option<Lane>,
}
impl Session for Native {
    fn try_switch_fallback_transport(&self) -> bool {
        self.lane.as_ref().is_some_and(|lane| {
            lane.transport
                .try_switch_fallback_transport(&self.transport)
        })
    }

    fn stream(&self, request: Request, context: Context) -> BoxFuture<'static, Result<(), Error>> {
        Box::pin(crate::stream(
            request,
            context,
            self.lane.clone(),
            self.transport.clone(),
        ))
    }
    fn needs_confirmation(&self) -> bool {
        self.lane.as_ref().is_some_and(Lane::needs_confirmation)
    }
    fn confirm<'a>(
        &'a self,
        prompt: &'a Prompt,
        settled_tool_call_ids: &'a [&'a str],
        response_id: Option<&'a str>,
    ) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            match &self.lane {
                Some(lane) => {
                    lane.confirm(prompt, settled_tool_call_ids, response_id)
                        .await
                }
                None => false,
            }
        })
    }
}
