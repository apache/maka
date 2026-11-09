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

#[cfg(target_os = "macos")]
pub mod chrome;
#[cfg(target_os = "macos")]
mod dismiss;
#[cfg(target_os = "macos")]
pub mod panel;
#[cfg(target_os = "macos")]
mod shortcuts;
mod web;
#[cfg(target_os = "macos")]
pub fn attach(config: &mut nsh_engine::EngineConfig) {
    web::attach(config);
    use std::sync::{Arc, Mutex};
    let Some(root) = config.data_dir.clone() else {
        return;
    };
    let root = root.join("default/quick-tools");
    let bridge = Arc::new(Mutex::new(None::<chrome::Bridge>));
    let runtime = config.runtime.clone().expect("desktop runtime");
    for name in [
        "quickTools.chrome.list",
        "quickTools.chrome.run",
        "quickTools.chrome.connect",
    ] {
        let bridge = bridge.clone();
        let runtime = runtime.clone();
        let root = root.clone();
        config.host.handle(name, move |call| {
            let bridge = bridge.clone();
            let root = root.clone();
            runtime.spawn_blocking(move || {
                let result = (|| -> Result<serde_json::Value, String> {
                    let bridge = {
                        let mut state = bridge.lock().map_err(|e| e.to_string())?;
                        if state.is_none() {
                            *state = Some(chrome::Bridge::start(&root)?);
                        }
                        state.as_ref().expect("bridge initialized").clone()
                    };
                    match name {
                        "quickTools.chrome.list" => Ok(bridge.list()),
                        "quickTools.chrome.run" => {
                            bridge.run(
                                call.data()["key"].as_str().ok_or("Expected tab key")?,
                                call.data()["action"]
                                    .as_str()
                                    .ok_or("Expected tab action")?,
                            )?;
                            Ok(serde_json::Value::Null)
                        }
                        _ => bridge
                            .setup(&root, &std::env::current_exe().map_err(|e| e.to_string())?),
                    }
                })();
                match result {
                    Ok(value) => call.resolve(value),
                    Err(error) => call.reject(error),
                }
            });
        });
    }
}
#[cfg(not(target_os = "macos"))]
pub fn attach(_: &mut nsh_engine::EngineConfig) {}
