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

use maka_agent_facts::tools::ToolError;
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAuthorization, InvocationContext,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct LoopbackFixture;
impl BrowserAuthorization for LoopbackFixture {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed("fixture cancelled".into()));
            }
            let url = reqwest::Url::parse(access.url())
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            if url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            {
                Ok(())
            } else {
                Err(ToolError::Failed(
                    "fixture permits only its isolated loopback HTTP pages".into(),
                ))
            }
        })
    }
    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
        self.authorize(access, cancellation)
    }
}
pub fn context<'a>(session: &'a str, turn: &'a str) -> InvocationContext<'a> {
    InvocationContext::new(session, turn).with_browser_authorization(Arc::new(LoopbackFixture))
}
