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
use maka_agent_facts::tools::{ToolError, ToolExecutor, ToolFuture};
use maka_code_runtime::CellResult;
use maka_fs_tools::{ReadExecutor, ReadOutput, ReadScope};
use maka_sandbox::{Network, Sandbox};

pub(super) struct Check {
    pub id: String,
    pub revision: u64,
    pub result: Result<bool, String>,
}

impl Owner {
    pub(super) async fn check_automation(
        &self,
        approval: super::super::notifications::BackgroundApproval,
        source: String,
    ) -> Result<bool, String> {
        let session = self.session(&approval.target.session_id).await?;
        let config = session.configuration;
        if session.archived
            || config.permission_basis().binding != approval.target.binding
            || config.boundary_revision != approval.target.boundary_revision
            || config.workspace != approval.target.workspace
            || config.permissions != approval.target.permissions
        {
            return Err("Conversation access changed. Update this automation to continue.".into());
        }
        let sandbox = self
            .capture_sandbox(
                &config,
                approval
                    .sandbox_ceiling
                    .as_ref()
                    .unwrap_or(&Sandbox::Disabled),
            )
            .await?;
        let workspace = config.workspace;
        let (read, network) = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let path = std::path::PathBuf::from(workspace.path);
            match sandbox {
                Sandbox::Managed {
                    filesystem,
                    network,
                } => {
                    let directory =
                        maka_fs_tools::directory::open(&path, &workspace.directory_identity)
                            .map_err(reason)?;
                    let policy = Arc::new(filesystem.compile().map_err(reason)?);
                    let read = ReadExecutor::from_directory(path, directory, Some(policy))
                        .map_err(reason)?;
                    Ok((read, network))
                }
                Sandbox::Disabled => {
                    maka_fs_tools::directory::open(&path, &workspace.directory_identity)
                        .map_err(reason)?;
                    Ok((
                        ReadExecutor::new(path, ReadScope::Unrestricted).map_err(reason)?,
                        Network::Allowed,
                    ))
                }
                Sandbox::External { .. } => Err("Automation requires a local sandbox".into()),
            }
        })
        .await
        .map_err(reason)??;
        let tools = Arc::new(ScriptTools {
            read,
            network,
            config: self.configuration.clone(),
        });
        let executor = maka_js_runtime::CodeExecutor::new(Default::default()).map_err(reason)?;
        let cancellation = self.stop.child_token();
        let check = executor.execute(source, tools, cancellation.clone());
        tokio::pin!(check);
        let result = tokio::select! {
            result = &mut check => result,
            () = tokio::time::sleep(executor.limits().timeout) => {
                cancellation.cancel();
                check.await.map_err(reason)?;
                return Err("Script check timed out".into());
            }
        }
        .map_err(reason)?;
        match result {
            CellResult::Success {
                value: Value::Bool(matched),
                ..
            } => Ok(matched),
            CellResult::Success { .. } => Err("Script must return true or false".into()),
            CellResult::Failure { error, .. } => Err(error.message),
        }
    }
}

struct ScriptTools {
    read: ReadExecutor,
    network: Network,
    config: Arc<ConfigurationStore>,
}

impl ToolExecutor for ScriptTools {
    fn names(&self) -> Vec<String> {
        vec!["Read".into(), "Fetch".into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let read = self.read.clone();
        let network = self.network.clone();
        let config = self.config.clone();
        Box::pin(async move {
            let failed = |message: String| ToolError::Failed(message);
            match name.as_str() {
                "Read" => {
                    let input: maka_agent_facts::read::ReadInput =
                        serde_json::from_value(input).map_err(|e| failed(e.to_string()))?;
                    match read
                        .read(
                            input.resolve().map_err(|e| failed(e.to_string()))?,
                            maka_agent_facts::read::MAX_PAGE_CHARS,
                            cancellation,
                        )
                        .await?
                    {
                        ReadOutput::Text(page) => {
                            serde_json::to_value(page).map_err(|e| failed(e.to_string()))
                        }
                        ReadOutput::Image { .. } => {
                            Err(failed("Automation Read expects a text file".into()))
                        }
                    }
                }
                "Fetch" => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Input {
                        url: reqwest::Url,
                    }
                    let Input { url } =
                        serde_json::from_value(input).map_err(|e| failed(e.to_string()))?;
                    if !matches!(url.scheme(), "http" | "https")
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.fragment().is_some()
                    {
                        return Err(failed(
                            "Fetch requires an HTTP(S) URL without credentials or a fragment"
                                .into(),
                        ));
                    }
                    let destination = maka_sandbox::Destination::new(
                        url.host_str().expect("HTTP URL has a host"),
                        url.port_or_known_default().expect("HTTP URL has a port"),
                    )
                    .map_err(|e| failed(e.to_string()))?;
                    if !network.allows(&destination) {
                        return Err(failed(
                            "The conversation sandbox blocks this destination".into(),
                        ));
                    }
                    let fetch = async {
                        let route = config.network_configuration().await.map_err(reason)?;
                        let policy = maka_network::Policy::from_host_settings(
                            &route.proxy,
                            route.password.as_deref(),
                        )
                        .map_err(reason)?;
                        let client = policy.client_builder().build().map_err(reason)?;
                        let mut response = client
                            .get(url)
                            .send()
                            .await
                            .map_err(|error| reason(error.without_url()))?;
                        let status = response.status().as_u16();
                        let mut body = Vec::new();
                        while let Some(chunk) = response
                            .chunk()
                            .await
                            .map_err(|error| reason(error.without_url()))?
                        {
                            if chunk.len() > 1024 * 1024 - body.len() {
                                return Err("Fetch response exceeds 1 MiB".into());
                            }
                            body.extend_from_slice(&chunk);
                        }
                        Ok(
                            serde_json::json!({ "status": status, "body": String::from_utf8(body).map_err(reason)? }),
                        )
                    };
                    tokio::select! {
                        () = cancellation.cancelled() => Err(failed("Fetch cancelled".into())),
                        result = fetch => result.map_err(failed),
                    }
                }
                _ => Err(failed("Unknown automation script tool".into())),
            }
        })
    }
}
