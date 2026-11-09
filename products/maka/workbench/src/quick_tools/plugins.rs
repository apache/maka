/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
//! Each installed plugin gets a bounded VM with only its declared service bridge.
use maka_js_runtime::plugin::{Captured, Error, Limits, RequestBridge, Vm};
use nsh_engine::{EngineConfig, HostChannel};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::oneshot;
use uuid::Uuid;
const SOURCE: &str = include_str!("plugin_worker.js");
type Reply = oneshot::Sender<Result<Value, Error>>;
struct Bridge {
    worker: Uuid,
    plugin: String,
    permissions: Vec<String>,
    host: Weak<HostChannel>,
    pending: Arc<Mutex<HashMap<Uuid, Reply>>>,
}
impl RequestBridge for Bridge {
    fn invoke(
        &self,
        input: Value,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
        let name = input["name"].as_str().unwrap_or_default().to_owned();
        let allowed = ["storage.read", "storage.write", "window.hide"].contains(&name.as_str())
            || self.permissions.contains(&name);
        let worker = self.worker;
        let plugin = self.plugin.clone();
        let host = self.host.clone();
        let pending = self.pending.clone();
        Box::pin(async move {
            let host = host
                .upgrade()
                .ok_or_else(|| Error("Plugin surface has closed".into()))?;
            if !allowed {
                return Err(Error(format!("Undeclared permission: {name}")));
            }
            let token = Uuid::new_v4();
            let (reply, receive) = oneshot::channel();
            {
                let mut pending = pending.lock().map_err(|e| Error(e.to_string()))?;
                if pending.len() >= 64 {
                    return Err(Error("Too many plugin service requests".into()));
                }
                pending.insert(token, reply);
            }
            let result = async {
                host.send("quickTools.plugin.service", json!({"worker":worker,"plugin":plugin,"token":token,"name":name,"input":input["input"]})).map_err(Error)?;
                tokio::time::timeout(Duration::from_secs(30), receive).await.map_err(|_| Error("Plugin service timed out".into()))?.map_err(|_| Error("Plugin service closed".into()))?
            }.await;
            pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&token);
            result
        })
    }
}
struct Worker {
    vm: Vm,
    callbacks: Captured,
    bridge: Arc<Bridge>,
    serial: tokio::sync::Mutex<()>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.vm.terminate("Quick Tools plugin retired");
    }
}
struct PluginScope {
    _host: Arc<HostChannel>,
    workers: Arc<Mutex<HashMap<Uuid, Arc<Worker>>>>,
}
impl Drop for PluginScope {
    fn drop(&mut self) {
        for worker in self
            .workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, worker)| worker)
        {
            worker.vm.terminate("Plugin surface closed");
        }
    }
}
pub fn attach(config: &mut EngineConfig) {
    let workers = Arc::new(Mutex::new(HashMap::<Uuid, Arc<Worker>>::new()));
    let channel = Arc::new(config.host.clone());
    let weak_channel = Arc::downgrade(&channel);
    config.context = config.context.clone().with(PluginScope {
        _host: channel,
        workers: workers.clone(),
    });
    let pending = Arc::new(Mutex::new(HashMap::<Uuid, Reply>::new()));
    let replies = pending.clone();
    config.host.handle("quickTools.plugin.reply", move |call| {
        let token = call.data()["token"]
            .as_str()
            .and_then(|id| id.parse::<Uuid>().ok());
        let reply = token.and_then(|token| {
            replies
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&token)
        });
        if let Some(reply) = reply {
            let value = match call.data()["error"].as_str() {
                Some(error) => Err(Error(error.chars().take(1000).collect())),
                None => Ok(call.data()["value"].clone()),
            };
            let _ = reply.send(value);
        }
        call.resolve(Value::Null);
    });
    for method in [
        "quickTools.plugin.load",
        "quickTools.plugin.invoke",
        "quickTools.plugin.unload",
        "quickTools.plugin.validate",
        "quickTools.plugin.cancel",
    ] {
        let workers = workers.clone();
        let pending = pending.clone();
        let host = weak_channel.clone();
        let runtime = config.runtime.clone().expect("native runtime");
        config.host.handle(method, move |call| {
            let workers = workers.clone();
            let pending = pending.clone();
            let host = host.clone();
            runtime.spawn(async move {
                let result = async {
                    if method.ends_with("validate") || method.ends_with("load") {
                        let code = call.data()["code"]
                            .as_str()
                            .ok_or_else(|| Error("Expected plugin code".into()))?;
                        if code.len() > 8 * 1024 * 1024 {
                            return Err(Error("Plugin code exceeds 8 MiB".into()));
                        }
                        let vm = Vm::scoped(Limits {
                            heap_bytes: 64 * 1024 * 1024,
                            synchronous_slice: Duration::from_secs(2),
                        })?;
                        let module = vm.load("quick-tools-plugin.mjs".into(), SOURCE.into())?;
                        let valid = module
                            .call(vec!["validate".into()], vec![json!(code)])
                            .await;
                        if let Err(error) = valid {
                            vm.terminate("Invalid plugin");
                            return Err(error);
                        }
                        if method.ends_with("validate") {
                            vm.shutdown().await;
                            return Ok(json!(true));
                        }
                        let manifest = &call.data()["manifest"];
                        let id = manifest["id"]
                            .as_str()
                            .ok_or_else(|| Error("Expected plugin ID".into()))?;
                        if [
                            "host",
                            "preferences",
                            "input-history",
                            "trace",
                            "shortcuts",
                            "extensions",
                            "launcher-shortcut",
                            "undelivered",
                        ]
                        .contains(&id)
                            || !id
                                .bytes()
                                .next()
                                .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                            || id.len() > 100
                            || !id.bytes().all(|c| {
                                c.is_ascii_lowercase()
                                    || c.is_ascii_digit()
                                    || c == b'.'
                                    || c == b'-'
                            })
                        {
                            vm.terminate("Invalid ID");
                            return Err(Error("Invalid plugin ID".into()));
                        }
                        let permissions: Vec<String> =
                            serde_json::from_value(manifest["permissions"].clone())
                                .map_err(|e| Error(e.to_string()))?;
                        let token = Uuid::new_v4();
                        let worker = Arc::new(Worker {
                            callbacks: module
                                .capture(vec![], vec!["invoke".into(), "cancel".into()])
                                .await?,
                            vm,
                            bridge: Arc::new(Bridge {
                                worker: token,
                                plugin: id.into(),
                                permissions,
                                host,
                                pending,
                            }),
                            serial: tokio::sync::Mutex::new(()),
                        });
                        {
                            let mut workers = workers.lock().map_err(|e| Error(e.to_string()))?;
                            if workers.len() >= 64 {
                                return Err(Error("Too many active plugins".into()));
                            }
                            workers.insert(token, worker);
                        }
                        return Ok(json!(token));
                    }
                    let token = call.data()["token"]
                        .as_str()
                        .and_then(|s| s.parse::<Uuid>().ok())
                        .ok_or_else(|| Error("Invalid plugin handle".into()))?;
                    if method.ends_with("unload") {
                        if let Some(worker) = workers
                            .lock()
                            .map_err(|e| Error(e.to_string()))?
                            .remove(&token)
                        {
                            worker.vm.terminate("Plugin unloaded");
                        }
                        return Ok(Value::Null);
                    }
                    let worker = workers
                        .lock()
                        .map_err(|e| Error(e.to_string()))?
                        .get(&token)
                        .cloned()
                        .ok_or_else(|| Error("Plugin has retired".into()))?;
                    if method.ends_with("cancel") {
                        return worker
                            .callbacks
                            .call("cancel", vec![call.data()["id"].clone()])
                            .await;
                    }
                    let _guard = worker.serial.lock().await;
                    let mut request = call.data()["request"].clone();
                    request["uuids"] = json!(
                        (0..256)
                            .map(|_| Uuid::new_v4().to_string())
                            .collect::<Vec<_>>()
                    );
                    let result = tokio::time::timeout(
                        Duration::from_secs(35),
                        worker.callbacks.call_with_context(
                            "invoke",
                            vec![request],
                            worker.bridge.clone(),
                        ),
                    )
                    .await;
                    match result {
                        Ok(result) => result,
                        Err(_) => {
                            worker.vm.terminate("Plugin operation timed out");
                            Err(Error("Plugin operation timed out".into()))
                        }
                    }
                }
                .await;
                match result {
                    Ok(value) => call.resolve(value),
                    Err(error) => call.reject(error.to_string()),
                }
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn surface_scope_drops_even_when_the_host_channel_is_retained() {
        let mut config = EngineConfig::new(nsh_engine::Bundle::source(String::new()));
        config.runtime = Some(tokio::runtime::Handle::current());
        attach(&mut config);
        let channel = config.host.clone();
        let scope = Arc::downgrade(&config.context.get::<PluginScope>().unwrap());
        drop(config);
        assert!(
            scope.upgrade().is_none(),
            "host handlers must not retain the surface scope"
        );
        drop(channel);
    }
    struct Memory(Mutex<Value>);
    impl RequestBridge for Memory {
        fn invoke(
            &self,
            input: Value,
        ) -> futures_util::future::BoxFuture<'static, Result<Value, Error>> {
            let value = match input["name"].as_str() {
                Some("storage.read") => Ok(self.0.lock().unwrap().clone()),
                Some("storage.write") => {
                    *self.0.lock().unwrap() = input["input"].clone();
                    Ok(Value::Null)
                }
                _ => Err(Error("Undeclared permission".into())),
            };
            Box::pin(async move { value })
        }
    }
    #[tokio::test]
    async fn cjs_plugin_uses_scoped_services_and_tracks_locale_without_ambient_node() {
        let vm = Vm::scoped(Limits::default()).unwrap();
        let module = vm.load("test.mjs".into(), SOURCE.into()).unwrap();
        let code = r#"module.exports.default=async ctx=>{
            let state=await ctx.storage.read({});
            return {search:()=>[{id:'x',name:ctx.locale+':'+state.name}],run:async(action)=>{
                if(action==='forbidden') return ctx.call('system.open','https://example.com');
                state={name:'saved'};await ctx.storage.write(state);ctx.changed();
            }};
        };"#;
        module
            .call(vec!["validate".into()], vec![json!(code)])
            .await
            .unwrap();
        let callbacks = module.capture(vec![], vec!["invoke".into()]).await.unwrap();
        let memory = Arc::new(Memory(Mutex::new(json!({"name":"original"}))));
        let call = |method: &str, args: Value, locale: &str| json!({"method":method,"args":args,"locale":locale,"uuids":[],"code":code});
        callbacks
            .call_with_context(
                "invoke",
                vec![call("start", json!([]), "en")],
                memory.clone(),
            )
            .await
            .unwrap();
        let result = callbacks
            .call_with_context(
                "invoke",
                vec![call("search", json!([""]), "en")],
                memory.clone(),
            )
            .await
            .unwrap();
        assert_eq!(result["value"][0]["name"], "en:original");
        assert!(
            callbacks
                .call_with_context(
                    "invoke",
                    vec![call("run", json!(["forbidden", null, {}]), "en")],
                    memory.clone()
                )
                .await
                .is_err()
        );
        let result = callbacks
            .call_with_context(
                "invoke",
                vec![call("run", json!(["save", null, {}]), "zh-CN")],
                memory.clone(),
            )
            .await
            .unwrap();
        assert_eq!(result["changed"], true);
        assert_eq!(*memory.0.lock().unwrap(), json!({"name":"saved"}));
        let result = callbacks
            .call_with_context("invoke", vec![call("search", json!([""]), "zh-CN")], memory)
            .await
            .unwrap();
        assert_eq!(result["value"][0]["name"], "zh-CN:saved");
        vm.shutdown().await;
    }
    #[tokio::test]
    async fn package_preview_parses_without_running_the_package() {
        let vm = Vm::pure(Limits::default()).unwrap();
        let module = vm.load("preview.mjs".into(), SOURCE.into()).unwrap();
        assert_eq!(
            module
                .call(
                    vec!["validate".into()],
                    vec![json!("throw Error('must not execute');")]
                )
                .await
                .unwrap(),
            true
        );
        assert!(
            module
                .call(vec!["validate".into()], vec![json!("function {")])
                .await
                .is_err()
        );
        vm.shutdown().await;
    }
}
