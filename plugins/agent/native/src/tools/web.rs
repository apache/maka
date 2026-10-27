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
use maka_tools::request::{BindingRequest, BoundTool, RequestBinding};
use std::collections::BTreeMap;
pub(super) struct Binding {
    pub services: Vec<Service>,
    pub workers: tokio_util::task::TaskTracker,
}
impl RequestBinding for Binding {
    fn bind(
        &self,
        input: BindingRequest,
    ) -> futures_util::future::BoxFuture<'static, Result<BTreeMap<String, BoundTool>, ToolError>>
    {
        let services: Vec<_> = self
            .services
            .iter()
            .filter(|service| input.tools.contains(&service.selection.name))
            .cloned()
            .collect();
        let service = services
            .first()
            .expect("selected request binding group")
            .clone();
        let workers = self.workers.clone();
        Box::pin(async move {
            let request = service
                .services
                .request_with_execution(
                    Identity::Agent {
                        invocation: input.invocation,
                        operation_id: None,
                    },
                    input.cancellation.clone(),
                    input.execution.ok_or_else(|| {
                        ToolError::Persistence("Execution custody unavailable".into())
                    })?,
                )
                .map_err(ToolError::Failed)?;
            let import = service.selection.import.clone();
            let capture = workers
                .spawn(async move {
                    let result = AssertUnwindSafe(async {
                        request
                            .call(
                                &import,
                                0,
                                "capture".into(),
                                serde_json::json!({}),
                                Attachments::default(),
                            )?
                            .await
                    })
                    .catch_unwind()
                    .await;
                    request
                        .finish()
                        .await
                        .map_err(ToolError::CleanupUnconfirmed)?;
                    result
                        .map_err(|_| ToolError::Failed("Web capture panicked".into()))?
                        .map_err(ToolError::Failed)
                })
                .await
                .map_err(|_| {
                    ToolError::CleanupUnconfirmed("Web capture worker disappeared".into())
                })??;
            if input.cancellation.is_cancelled() {
                return Err(ToolError::Failed("Web capture cancelled".into()));
            }
            let capture: maka_web_api::contract::Capture = serde_json::from_value(capture)
                .map_err(|_| ToolError::Failed("Web capture invalid".into()))?;
            Ok(services
                .into_iter()
                .map(|service| {
                    let name = service.selection.name.clone();
                    let projection = if !capture.available {
                        BoundTool::Unavailable
                    } else if service.selection.method == "search"
                        && capture.source == maka_web_api::settings::Source::Model
                    {
                        input
                            .model
                            .as_ref()
                            .and_then(maka_web::search::native)
                            .map_or(BoundTool::Unavailable, BoundTool::Provider)
                    } else if service.selection.method == "search" && !capture.credential_configured
                    {
                        BoundTool::Unavailable
                    } else {
                        BoundTool::Prepared(Arc::new(Service {
                            web_basis: Some(capture.basis.clone()),
                            ..service
                        }))
                    };
                    (name, projection)
                })
                .collect())
        })
    }
}
