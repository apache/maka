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

//! BrowserMCP stays an external provider. The Rust shell owns stdio and cleanup.
use nsh_engine::EngineConfig;
use rmcp::{ServiceExt, model::CallToolRequestParams, transport::TokioChildProcess};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, oneshot};

fn command() -> Result<tokio::process::Command, String> {
    let node = std::env::var_os("MAKA_QUICK_WEB_NODE")
        .ok_or("Start Maka with the Quick Tools launcher")?;
    let entry =
        std::env::var_os("MAKA_QUICK_WEB_ENTRY").ok_or("BrowserMCP provider is not configured")?;
    if !std::path::Path::new(&node).is_absolute() || !std::path::Path::new(&entry).is_file() {
        return Err("BrowserMCP provider is unavailable; install workspace dependencies".into());
    }
    let mut command = tokio::process::Command::new(node);
    command.arg(entry).kill_on_drop(true);
    Ok(command)
}

async fn request(data: &Value, connect: bool) -> Result<Value, String> {
    if connect {
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            command()?
                .args([
                    "setup",
                    "--clients",
                    "none",
                    "--browsers",
                    "chrome",
                    "--wait",
                    "0",
                    "--no-open",
                ])
                .output(),
        )
        .await
        .map_err(|_| "Browser setup timed out")?
        .map_err(|e| e.to_string())?;
        return Ok(json!({"connected": output.status.success()}));
    }
    let name = data["name"].as_str().ok_or("Expected browser method")?;
    if !["sites_search", "site_run", "js"].contains(&name) {
        return Err("Unsupported browser method".into());
    }
    let args = data["args"]
        .as_object()
        .ok_or("Expected browser arguments")?
        .clone();
    if serde_json::to_vec(&args).map_err(|e| e.to_string())?.len() > 128 * 1024 {
        return Err("Browser arguments too large".into());
    }
    let mut launch = command()?;
    launch.arg("stdio");
    let transport = TokioChildProcess::new(launch).map_err(|e| e.to_string())?;
    let service = tokio::time::timeout(Duration::from_secs(8), ().serve(transport))
        .await
        .map_err(|_| "BrowserMCP startup timed out")?
        .map_err(|e| e.to_string())?;
    let reply = tokio::time::timeout(
        Duration::from_secs(25),
        service.call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(args)),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(2), service.cancel())
        .await
        .map_err(|_| "Browser cleanup timed out")?
        .map_err(|e| e.to_string())?;
    let value = reply
        .map_err(|_| "Browser request timed out")?
        .map_err(|e| e.to_string())?;
    serde_json::to_value(value).map_err(|e| e.to_string())
}

pub fn attach(config: &mut EngineConfig) {
    let requests = Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<()>>::new()));
    let cancellations = requests.clone();
    config.host.handle("quickTools.web.cancel", move |call| {
        if let Some(id) = call.data()["id"].as_str() {
            if let Some(cancel) = cancellations
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(id)
            {
                let _ = cancel.send(());
            }
        }
        call.resolve(Value::Null);
    });
    let slots = Arc::new(Semaphore::new(4));
    for method in ["quickTools.web.call", "quickTools.web.connect"] {
        let runtime = config.runtime.clone().expect("desktop runtime");
        let slots = slots.clone();
        let requests = requests.clone();
        config.host.handle(method, move |call| {
            let slots = slots.clone();
            let requests = requests.clone();
            let (cancel, mut cancelled) = oneshot::channel();
            let id = if method.ends_with("call") {
                let Some(id) = call.data()["id"]
                    .as_str()
                    .filter(|id| id.parse::<uuid::Uuid>().is_ok())
                else {
                    call.reject("Expected browser request ID");
                    return;
                };
                let id = id.to_owned();
                let mut pending = requests.lock().unwrap_or_else(|e| e.into_inner());
                if pending.len() >= 4 || pending.contains_key(&id) {
                    call.reject("Too many browser requests");
                    return;
                }
                pending.insert(id.clone(), cancel);
                Some(id)
            } else {
                None
            };
            runtime.spawn(async move {
                let operation = async {
                    let _slot = slots
                        .try_acquire()
                        .map_err(|_| "Too many browser requests")?;
                    request(call.data(), method.ends_with("connect")).await
                };
                let result = if let Some(id) = id {
                    let result = tokio::select! {
                        result = operation => result,
                        _ = &mut cancelled => Err("Browser request cancelled".into()),
                    };
                    requests
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id);
                    result
                } else {
                    operation.await
                };
                match result {
                    Ok(value) => call.resolve(value),
                    Err(error) => call.reject(error),
                }
            });
        });
    }
}
