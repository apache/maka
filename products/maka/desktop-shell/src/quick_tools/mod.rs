/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
#[cfg(target_os = "macos")]
pub mod chrome;
#[cfg(target_os = "macos")]
pub mod panel;
#[cfg(target_os = "macos")]
mod dismiss;
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
