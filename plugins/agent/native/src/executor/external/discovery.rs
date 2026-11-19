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
use runtime::Pipe;

pub(super) async fn query(
    commands: &BTreeMap<NativeRuntime, NativeCommand>,
    cwd: &str,
    kind: &str,
    selected: Option<NativeRuntime>,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    if kind == "usage_limits" {
        let config = runtime::resolve(&commands[&NativeRuntime::Antigravity], cwd)
            .await
            .require()?;
        return agy::usage_limits(&config, cwd, cancellation).await;
    }
    let mut result = Vec::new();
    for (&runtime, config) in commands
        .iter()
        .filter(|(id, _)| selected.is_none_or(|selected| selected == **id))
    {
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let discovered = match runtime::resolve(config, cwd).await {
            runtime::Resolution::Missing => {
                serde_json::json!({"installation":{"kind":"not_found"},"authentication":{"kind":"unknown"},"models":{"kind":"unavailable"}})
            }
            runtime::Resolution::UnsupportedBatch => {
                serde_json::json!({"installation":{"kind":"unsupported","detail":runtime::BATCH_SHIM_UNSUPPORTED},"authentication":{"kind":"unknown"},"models":{"kind":"unavailable"}})
            }
            runtime::Resolution::Native(_) if runtime == NativeRuntime::Claude => {
                serde_json::json!({"installation":{"kind":"available"},"authentication":{"kind":"unsupported"},"models":{"kind":"unsupported","detail":"Claude interactive CLI does not expose model discovery"}})
            }
            runtime::Resolution::Native(config) => {
                let discovery = if runtime == NativeRuntime::Antigravity {
                    agy::models(&config, cwd, cancellation.clone()).await
                } else {
                    async {
                        let command =
                            codex::proxy_resolved(&config, cwd, cancellation.clone()).await?;
                        runtime::pipe(
                            command,
                            runtime::Transport::WebSocket,
                            None,
                            cancellation.clone(),
                            Probe,
                        )
                        .await
                    }
                    .await
                };
                match discovery {
                    Ok(value) => value,
                    Err(
                        error @ (Error::Cancelled
                        | Error::Unknown
                        | Error::CleanupUnconfirmed
                        | Error::Persistence(_)),
                    ) => return Err(error),
                    Err(_) => {
                        serde_json::json!({"installation":{"kind":"available"},"authentication":{"kind":"unknown","detail":"Native discovery did not confirm authentication"},"models":{"kind":"error","detail":"Native protocol model discovery failed"}})
                    }
                }
            }
        };
        if kind == "status" {
            let models = if runtime == NativeRuntime::Claude
                && discovered
                    .pointer("/installation/kind")
                    .and_then(Value::as_str)
                    == Some("available")
            {
                serde_json::json!({"kind":"unsupported","detail":"Claude interactive CLI does not expose model discovery; native default is available"})
            } else if let Some(models) = discovered
                .pointer("/models/models")
                .and_then(Value::as_array)
            {
                serde_json::json!({"kind":"ready","count":models.len()})
            } else {
                discovered["models"].clone()
            };
            result.push(serde_json::json!({"id":runtime.as_str(),"name":runtime.name(),"installation":discovered["installation"],"authentication":discovered["authentication"],"models":models}));
        } else if kind == "models" {
            result.push(discovered["models"].clone());
        } else {
            result.push(serde_json::json!({"runtime":runtime.as_str(),"installation":discovered["installation"],"authentication":discovered["authentication"],"models":discovered["models"]}));
        }
    }
    if selected.is_some() && kind != "status" {
        result
            .into_iter()
            .next()
            .ok_or_else(|| Error::Invalid("Native runtime unavailable".into()))
    } else {
        Ok(Value::Array(result))
    }
}
struct Probe;
impl runtime::PipeProtocol for Probe {
    type Output = Value;
    fn run<'io>(self, io: &'io mut Pipe) -> BoxFuture<'io, Result<Value, Error>>
    where
        Self: 'io,
    {
        Box::pin(probe(io))
    }
}

async fn probe(io: &mut Pipe) -> Result<Value, Error> {
    let init = io.request("initialize", serde_json::json!({"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
    io.notify("initialized", serde_json::json!({})).await?;
    let mut cursor = None;
    let mut seen = std::collections::BTreeSet::new();
    let mut models = Vec::new();
    loop {
        let page = io
            .request(
                "model/list",
                serde_json::json!({"includeHidden":false,"cursor":cursor}),
            )
            .await?;
        let data = page
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::Invalid("Codex model/list missing data".into()))?;
        models.extend(data.iter().map(|model| {
            let levels:Vec<_>=model.get("supportedReasoningEfforts").and_then(Value::as_array).into_iter().flatten().filter_map(|e|e.get("reasoningEffort")).cloned().collect();
            serde_json::json!({"id":model["id"],"displayName":model["displayName"],"effortLevels":levels,"defaultEffort":model["defaultReasoningEffort"]})
        }));
        match page.get("nextCursor") {
            None | Some(Value::Null) => break,
            Some(Value::String(next)) if seen.insert(next.clone()) => cursor = Some(next.clone()),
            _ => {
                return Err(Error::Invalid(
                    "Codex model/list returned an invalid or repeated cursor".into(),
                ));
            }
        }
    }
    let authentication = match io
        .request("account/read", serde_json::json!({"refreshToken":false}))
        .await
    {
        Ok(account) if account.get("account").is_some_and(|a| !a.is_null()) => {
            serde_json::json!({"kind":"authenticated","source":"codex account/read"})
        }
        Ok(_) => serde_json::json!({"kind":"unknown","source":"codex account/read"}),
        Err(runtime::RpcError::Failed(Error::Cancelled)) => return Err(Error::Cancelled),
        Err(_) => serde_json::json!({"kind":"unknown"}),
    };
    let _ = init;
    Ok(
        serde_json::json!({"installation":{"kind":"available"},"authentication":authentication,"models":{"kind":"ok","models":models}}),
    )
}
