/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
use super::panel::Request;
use nsh_engine::{HostCall, JsonValue};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

pub fn start(
    runtime: &tokio::runtime::Handle,
    directory: PathBuf,
    events: mpsc::Sender<Request>,
) -> mpsc::Sender<HostCall> {
    let (send, mut calls) = mpsc::channel::<HostCall>(16);
    runtime.spawn(async move {
        let mut pending: HashMap<String, HostCall> = HashMap::new();
        let result = async {
            let helper = std::env::var_os("MAKA_QUICK_NATIVE").ok_or_else(|| std::io::Error::other("Native shortcut helper is missing"))?;
            let mut child = tokio::process::Command::new(helper).arg("shortcuts")
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).kill_on_drop(true).spawn()?;
            let mut stdin = child.stdin.take().expect("helper stdin");
            let file = directory.join("default/quick-tools/shortcuts.json");
            let bindings = match tokio::fs::read(&file).await {
                Ok(bytes) => serde_json::from_slice::<JsonValue>(&bytes).map_err(std::io::Error::other)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({"toggle":"Alt+Space"}),
                Err(e) => return Err(e),
            };
            stdin.write_all(format!("{}\n",json!({"request":"startup","bindings":bindings})).as_bytes()).await?;
            let mut lines = BufReader::new(child.stdout.take().expect("helper stdout")).lines();
            loop {
                tokio::select! {
                    line = lines.next_line() => {
                        let Some(line) = line? else { break; };
                        if line.len() > 64 * 1024 { break; }
                        let message: JsonValue = serde_json::from_str(&line).map_err(std::io::Error::other)?;
                        match message["type"].as_str() {
                            Some("shortcut") => { if events.send(Request::Shortcut(message)).await.is_err() { break; } }
                            Some("modifiers") => { let _ = events.try_send(Request::Modifiers(message)); }
                            Some("configured") => {
                                let id = message["request"].as_str().unwrap_or_default();
                                if let Some(call) = pending.remove(id) {
                                    if message["ok"] == true { call.resolve(JsonValue::Null); }
                                    else { call.reject(message["error"].as_str().unwrap_or("Shortcut registration failed")); }
                                } else if message["ok"] == false {
                                    let _ = events.send(Request::Error(message["error"].clone())).await;
                                }
                            }
                            _ => (),
                        }
                    }
                    call = calls.recv() => {
                        let Some(call) = call else { break; };
                        let valid = call.data().as_object().is_some_and(|bindings| bindings.len() <= 128 && bindings.iter().all(|(key,value)| key.len() <= 4096 && value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 100)));
                        if !valid || pending.len() >= 16 { call.reject("Invalid or excessive shortcut bindings"); continue; }
                        let id = uuid::Uuid::new_v4().to_string();
                        let bytes = format!("{}\n", json!({"request":id,"bindings":call.data()}));
                        pending.insert(id,call);
                        stdin.write_all(bytes.as_bytes()).await?;
                    }
                }
            }
            Err::<(), std::io::Error>(std::io::Error::other("Shortcut helper stopped"))
        }.await;
        if let Err(error) = result {
            let _ = events.send(Request::Error(json!(error.to_string()))).await;
            for (_, call) in pending { call.reject(error.to_string()); }
            while let Some(call) = calls.recv().await { call.reject(error.to_string()); }
        }
    });
    send
}
