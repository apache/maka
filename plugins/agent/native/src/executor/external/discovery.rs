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
use runtime::{Pipe, string};

pub(super) async fn query(
    commands: &BTreeMap<NativeRuntime, NativeCommand>,
    cwd: &str,
    kind: &str,
    selected: Option<NativeRuntime>,
    cancellation: CancellationToken,
) -> Result<Value, Error> {
    let mut result = Vec::new();
    for (&runtime, config) in commands
        .iter()
        .filter(|(id, _)| selected.is_none_or(|selected| selected == **id))
    {
        if cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let installed = runtime::executable(config, cwd).await.is_some();
        let discovered = if !installed {
            serde_json::json!({"installation":{"kind":"not_found"},"authentication":{"kind":"unknown"},"models":{"kind":"unavailable"}})
        } else if runtime == NativeRuntime::Claude {
            serde_json::json!({"installation":{"kind":"available"},"authentication":{"kind":"unsupported"},"models":{"kind":"unsupported","detail":"Claude interactive CLI does not expose model discovery"}})
        } else {
            let mut command = runtime::command(config, cwd).await?;
            if runtime == NativeRuntime::Codex {
                command.arg("app-server");
            } else {
                command.arg("acp").arg("--dangerously-skip-permissions");
            }
            let discovery =
                runtime::pipe(command, None, cancellation.clone(), |mut io| async move {
                    let result = probe(&mut io, runtime, cwd).await;
                    (result, io)
                })
                .await;
            match discovery {
                Ok(value) => value,
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(Error::CleanupUnconfirmed) => return Err(Error::CleanupUnconfirmed),
                Err(_) => {
                    serde_json::json!({"installation":{"kind":"available"},"authentication":{"kind":"unknown","detail":"Native discovery did not confirm authentication"},"models":{"kind":"error","detail":"Native protocol model discovery failed"}})
                }
            }
        };
        if kind == "status" {
            let models = if runtime == NativeRuntime::Claude && installed {
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
async fn probe(io: &mut Pipe, runtime: NativeRuntime, cwd: &str) -> Result<Value, Error> {
    if runtime == NativeRuntime::Codex {
        let (init, _) = io.request("initialize", serde_json::json!({"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        io.notify("initialized", serde_json::json!({})).await?;
        let (models, _) = io
            .request("model/list", serde_json::json!({"includeHidden":false}))
            .await?;
        let models = models.get("data").and_then(Value::as_array).ok_or_else(|| Error::Invalid("Codex model/list missing data".into()))?.iter().map(|model| {
            let levels: Vec<_> = model.get("supportedReasoningEfforts").and_then(Value::as_array).into_iter().flatten().filter_map(|e| e.get("reasoningEffort")).cloned().collect();
            serde_json::json!({"id":model["id"],"displayName":model["displayName"],"effortLevels":levels,"defaultEffort":model["defaultReasoningEffort"]})
        }).collect::<Vec<_>>();
        let authentication = match io
            .request("account/read", serde_json::json!({"refreshToken":false}))
            .await
        {
            Ok((account, _)) if account.get("account").is_some_and(|a| !a.is_null()) => {
                serde_json::json!({"kind":"authenticated","source":"codex account/read"})
            }
            Ok(_) => serde_json::json!({"kind":"unknown","source":"codex account/read"}),
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(_) => serde_json::json!({"kind":"unknown"}),
        };
        let _ = init;
        Ok(
            serde_json::json!({"installation":{"kind":"available"},"authentication":authentication,"models":{"kind":"ok","models":models}}),
        )
    } else {
        let (init, _) = io.request("initialize", serde_json::json!({"protocolVersion":1,"clientInfo":{"name":"maka","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{}})).await?;
        let version = init.pointer("/agentInfo/version").and_then(Value::as_str);
        let (opened, _) = io
            .request(
                "session/new",
                serde_json::json!({"cwd":cwd,"mcpServers":[]}),
            )
            .await?;
        let options = opened.get("configOptions").and_then(Value::as_array);
        let selector = options.and_then(|options| {
            options.iter().find(|o| {
                o.get("category").and_then(Value::as_str) == Some("model")
                    || o.get("id").and_then(Value::as_str) == Some("model")
            })
        });
        let mut models = Vec::new();
        if let Some(selector) = selector {
            flatten_models(&selector["options"], &mut models);
        }
        if models.is_empty()
            && let Some(available) = opened
                .pointer("/models/availableModels")
                .and_then(Value::as_array)
        {
            for model in available {
                models.push(
                    serde_json::json!({"id":string(model,"/modelId")?,"displayName":model["name"]}),
                );
            }
        }
        Ok(
            serde_json::json!({"installation":{"kind":"available","version":version},"authentication":{"kind":"unknown","source":"agy ACP"},"models":{"kind":"ok","models":models}}),
        )
    }
}
fn flatten_models(options: &Value, models: &mut Vec<Value>) {
    for option in options.as_array().into_iter().flatten() {
        if let Some(value) = option.get("value").and_then(Value::as_str) {
            models.push(serde_json::json!({"id":value,"displayName":option["name"]}));
        } else {
            flatten_models(&option["options"], models);
        }
    }
}
