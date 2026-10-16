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

//! The `maka-host` script module: public service calls on one Maka Host over
//! an owned session.
//!
//! gpui-shell drives an async host function on GPUI's background executor,
//! while the Host client needs tokio. The bridge therefore owns a small tokio
//! runtime; each call runs there and returns its answer through a oneshot.
//! The session connects on the first call and is shared by later ones.
use gpui_shell::{HostArguments, HostError, HostModule, HostResult, HostValue};
use maka_host_runtime::application::{
    host::{Client, LocalCall},
    transport::wire::Reply,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const NAME: &str = "maka-host";
const ENDPOINT: &str = "MAKA_HOST_ENDPOINT";
const EPOCH: &str = "MAKA_HOST_EPOCH";
/// Largest integer a script number holds exactly (2^53 - 1).
const EXACT_INTEGER: f64 = 9_007_199_254_740_991.0;

const DECLARATIONS: &str = r#"/** Runs a query method and resolves with its result. */
export function query(endpoint: string, method: string, input?: unknown): Promise<unknown>;
/** Runs a mutation: start, then confirm; resolves with the operation reply (receipt). Never retried. */
export function mutate(endpoint: string, method: string, input?: unknown): Promise<unknown>;
/** Opens a subscription and resolves with a handle once the Host answers Subscribed. */
export function subscribe(endpoint: string, method: string, input?: unknown): Promise<number>;
/** Pulls one item; resolves with its value, or null when the subscription ended. */
export function next(subscription: number): Promise<unknown | null>;
/** Closes a subscription. */
export function close(subscription: number): Promise<void>;
"#;

/// Builds the module for the Host named by `MAKA_HOST_ENDPOINT` (socket path)
/// and `MAKA_HOST_EPOCH` (optional). gpui-shell owns the command line, so the
/// address comes from the environment. A missing address rejects each call.
pub fn module() -> Result<HostModule, String> {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let runtime = match RUNTIME.get() {
        Some(runtime) => runtime,
        None => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("maka-host")
                .enable_all()
                .build()
                .map_err(|error| format!("cannot start the Maka Host runtime: {error}"))?;
            // Never dropped: process exit must not wait on runtime shutdown.
            RUNTIME.get_or_init(|| runtime)
        }
    };
    let target = Target::from_env(std::env::var_os(ENDPOINT), std::env::var_os(EPOCH));
    Ok(register(Arc::new(Bridge::new(
        target,
        runtime.handle().clone(),
    ))))
}

fn register(bridge: Arc<Bridge>) -> HostModule {
    let (query, mutate, subscribe, next) = (
        bridge.clone(),
        bridge.clone(),
        bridge.clone(),
        bridge.clone(),
    );
    let close = bridge;
    HostModule::new(NAME)
        .declarations(DECLARATIONS)
        .async_function("query", move |arguments| {
            let (endpoint, method, input) = request(arguments)?;
            let bridge = query.clone();
            Ok(query.run(async move { bridge.query(&endpoint, method, input).await.map(to_host) }))
        })
        .async_function("mutate", move |arguments| {
            let (endpoint, method, input) = request(arguments)?;
            let bridge = mutate.clone();
            Ok(mutate
                .run(async move { bridge.mutate(&endpoint, method, input).await.map(to_host) }))
        })
        .async_function("subscribe", move |arguments| {
            let (endpoint, method, input) = request(arguments)?;
            let bridge = subscribe.clone();
            Ok(subscribe.run(async move {
                let handle = bridge.subscribe(&endpoint, method, input).await?;
                Ok(HostValue::from(handle))
            }))
        })
        .async_function("next", move |arguments| {
            let handle = arguments.integer(0)?;
            let bridge = next.clone();
            Ok(next.run(async move { bridge.next(handle).await.map(to_host) }))
        })
        .async_function("close", move |arguments| {
            let handle = arguments.integer(0)?;
            let bridge = close.clone();
            Ok(close.run(async move { bridge.close(handle).await.map(|()| HostValue::Null) }))
        })
}

fn request(arguments: &HostArguments) -> Result<(String, String, Value), HostError> {
    let endpoint = arguments.string(0)?.to_owned();
    let method = arguments.string(1)?.to_owned();
    // An omitted input is sent as null; methods with an empty input want `{}`.
    let input = match arguments.get(2) {
        Some(value) => to_json(value).map_err(HostError::new)?,
        None => Value::Null,
    };
    Ok((endpoint, method, input))
}

#[derive(Debug, PartialEq)]
struct Target {
    endpoint: PathBuf,
    epoch: Option<Uuid>,
}
impl Target {
    fn from_env(endpoint: Option<OsString>, epoch: Option<OsString>) -> Result<Self, String> {
        let endpoint = endpoint.filter(|value| !value.is_empty()).ok_or_else(|| {
            format!(
                "{ENDPOINT} is not set; start the desktop with {ENDPOINT}=<Host socket path> \
                 and optionally {EPOCH}=<Host epoch>"
            )
        })?;
        let epoch = match epoch.filter(|value| !value.is_empty()) {
            None => None,
            Some(value) => Some(
                value
                    .to_str()
                    .and_then(|text| Uuid::parse_str(text).ok())
                    .ok_or_else(|| format!("{EPOCH} is not a UUID: {}", value.to_string_lossy()))?,
            ),
        };
        Ok(Self {
            endpoint: endpoint.into(),
            epoch,
        })
    }
}

struct Subscription {
    call: tokio::sync::Mutex<LocalCall>,
    /// Cancelled by `close` or when the Host ends the stream; a pending pull
    /// then resolves with null instead of holding the call.
    ended: CancellationToken,
}

/// Open subscriptions by script handle. Handles start at 1 and are not reused.
struct Handles<T> {
    last: i64,
    open: BTreeMap<i64, Arc<T>>,
}
impl<T> Default for Handles<T> {
    fn default() -> Self {
        Self {
            last: 0,
            open: BTreeMap::new(),
        }
    }
}
impl<T> Handles<T> {
    fn insert(&mut self, value: T) -> i64 {
        self.last += 1;
        self.open.insert(self.last, Arc::new(value));
        self.last
    }
    fn get(&self, handle: i64) -> Result<Arc<T>, String> {
        self.open
            .get(&handle)
            .cloned()
            .ok_or_else(|| format!("subscription {handle} is not open"))
    }
    fn remove(&mut self, handle: i64) -> Option<Arc<T>> {
        self.open.remove(&handle)
    }
}

struct Bridge {
    target: Result<Target, String>,
    runtime: tokio::runtime::Handle,
    client: tokio::sync::Mutex<Option<Arc<Client>>>,
    subscriptions: Mutex<Handles<Subscription>>,
}
impl Bridge {
    fn new(target: Result<Target, String>, runtime: tokio::runtime::Handle) -> Self {
        Self {
            target,
            runtime,
            client: tokio::sync::Mutex::new(None),
            subscriptions: Mutex::default(),
        }
    }

    /// Runs `work` on the bridge runtime. The returned future only waits for
    /// the answer, so it can be driven by GPUI's executor.
    fn run<W>(&self, work: W) -> impl Future<Output = HostResult> + Send + use<W>
    where
        W: Future<Output = Result<HostValue, String>> + Send + 'static,
    {
        let (answer, answered) = tokio::sync::oneshot::channel();
        self.runtime.spawn(async move {
            let _ = answer.send(work.await);
        });
        async move {
            answered
                .await
                .unwrap_or_else(|_| Err("the Maka Host runtime stopped before answering".into()))
                .map_err(HostError::new)
        }
    }

    fn subscriptions(&self) -> MutexGuard<'_, Handles<Subscription>> {
        self.subscriptions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn client(&self) -> Result<Arc<Client>, String> {
        let target = self.target.as_ref().map_err(Clone::clone)?;
        let mut current = self.client.lock().await;
        if let Some(client) = current.as_ref() {
            return Ok(client.clone());
        }
        let client = Client::connect(&target.endpoint, target.epoch)
            .await
            .map_err(|error| {
                format!(
                    "cannot connect to the Maka Host at {}: {error}",
                    target.endpoint.display()
                )
            })?;
        let client = Arc::new(client);
        *current = Some(client.clone());
        Ok(client)
    }

    /// Opens one call. A refused call channel means the session is gone (the
    /// Host exited or dropped it), so the next call connects again.
    async fn open(
        &self,
        endpoint: &str,
        method: String,
        input: Value,
    ) -> Result<LocalCall, String> {
        let client = self.client().await?;
        client
            .catalogue()
            .select(endpoint)
            .map_err(|error| format!("{error}: `{endpoint}`"))?;
        match client
            .call(endpoint, method, input, Default::default())
            .await
        {
            Ok(call) => Ok(call),
            Err(error) => {
                let mut current = self.client.lock().await;
                if current
                    .as_ref()
                    .is_some_and(|held| Arc::ptr_eq(held, &client))
                {
                    *current = None;
                }
                Err(format!("the Maka Host session is gone: {error}"))
            }
        }
    }

    async fn query(&self, endpoint: &str, method: String, input: Value) -> Result<Value, String> {
        let mut call = self.open(endpoint, method, input).await?;
        call.start().await?;
        match call.receive().await? {
            Reply::Finished { result, cleanup } => {
                let value = result?;
                cleanup?;
                Ok(value)
            }
            Reply::Aborted { reason, .. } => Err(reason),
            other => Err(refuse(call, other, "query").await),
        }
    }

    /// Confirms exactly once. A lost reply is reported, never resent: only the
    /// original call and its receipt can tell whether the mutation ran.
    async fn mutate(&self, endpoint: &str, method: String, input: Value) -> Result<Value, String> {
        let mut call = self.open(endpoint, method, input).await?;
        call.start().await?;
        match call.receive().await? {
            Reply::Prepared { .. } => {}
            Reply::Aborted { reason, .. } => return Err(reason),
            other => return Err(refuse(call, other, "mutation").await),
        }
        let mut reply = call.confirm().await?;
        loop {
            match reply {
                Reply::Progress { .. } => reply = call.receive().await?,
                Reply::Mutation { reply, cleanup } => {
                    cleanup?;
                    return serde_json::to_value(&*reply).map_err(|error| error.to_string());
                }
                Reply::Aborted { reason, .. } => return Err(reason),
                other => {
                    return Err(format!(
                        "the Host answered a confirmed mutation with {}",
                        kind(&other)
                    ));
                }
            }
        }
    }

    async fn subscribe(&self, endpoint: &str, method: String, input: Value) -> Result<i64, String> {
        let mut call = self.open(endpoint, method, input).await?;
        call.start().await?;
        match call.receive().await? {
            Reply::Subscribed => Ok(self.subscriptions().insert(Subscription {
                call: tokio::sync::Mutex::new(call),
                ended: CancellationToken::new(),
            })),
            Reply::Finished {
                result: Err(error), ..
            }
            | Reply::Aborted { reason: error, .. } => Err(error),
            other => Err(refuse(call, other, "subscription").await),
        }
    }

    async fn next(&self, handle: i64) -> Result<Value, String> {
        let subscription = self.subscriptions().get(handle)?;
        let mut call = subscription.call.lock().await;
        let reply = tokio::select! {
            biased;
            () = subscription.ended.cancelled() => return Ok(Value::Null),
            reply = call.pull() => reply,
        };
        if let Ok(Reply::Item { value }) = reply {
            return Ok(value);
        }
        self.subscriptions().remove(handle);
        subscription.ended.cancel();
        match reply {
            Ok(Reply::Finished {
                result: Ok(_),
                cleanup,
            }) => cleanup.map(|()| Value::Null),
            Ok(Reply::Finished {
                result: Err(error), ..
            })
            | Ok(Reply::Aborted { reason: error, .. })
            | Err(error) => Err(error),
            Ok(other) => Err(format!("the Host answered a pull with {}", kind(&other))),
        }
    }

    /// Closing an ended or unknown handle does nothing.
    async fn close(&self, handle: i64) -> Result<(), String> {
        let Some(subscription) = self.subscriptions().remove(handle) else {
            return Ok(());
        };
        subscription.ended.cancel();
        subscription.call.lock().await.close().await
    }
}

/// Cancels a call whose method has another mode than the one requested, and
/// names the function that fits it.
async fn refuse(mut call: LocalCall, reply: Reply, requested: &str) -> String {
    let fits = match reply {
        Reply::Finished { .. } => "a query; use query()",
        Reply::Prepared { .. } => "a mutation; use mutate()",
        Reply::Subscribed => "a subscription; use subscribe()",
        _ => return format!("the Host answered a {requested} with {}", kind(&reply)),
    };
    let closed = call.close().await;
    let mut message = format!("this method is {fits}");
    if let Err(error) = closed {
        message.push_str(&format!(" (closing it failed: {error})"));
    }
    message
}

fn kind(reply: &Reply) -> &'static str {
    match reply {
        Reply::Ready => "Ready",
        Reply::Subscribed => "Subscribed",
        Reply::Prepared { .. } => "Prepared",
        Reply::Item { .. } => "Item",
        Reply::Finished { .. } => "Finished",
        Reply::Progress { .. } => "Progress",
        Reply::Mutation { .. } => "Mutation",
        Reply::Aborted { .. } => "Aborted",
    }
}

/// Script numbers are doubles, but Host inputs such as `after` or a revision
/// are integers; a whole number in the exact range crosses as an integer.
fn to_json(value: &HostValue) -> Result<Value, String> {
    Ok(match value {
        HostValue::Null => Value::Null,
        HostValue::Bool(flag) => Value::Bool(*flag),
        HostValue::Number(number) if !number.is_finite() => {
            return Err(format!("{number} cannot be sent to the Host"));
        }
        HostValue::Number(number) if number.fract() == 0.0 && number.abs() <= EXACT_INTEGER => {
            if *number < 0.0 {
                Value::from(*number as i64)
            } else {
                Value::from(*number as u64)
            }
        }
        HostValue::Number(number) => Value::from(*number),
        HostValue::Str(text) => Value::String(text.clone()),
        HostValue::Array(values) => {
            Value::Array(values.iter().map(to_json).collect::<Result<_, _>>()?)
        }
        HostValue::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), to_json(value)?)))
                .collect::<Result<_, String>>()?,
        ),
    })
}

/// Integers above 2^53 lose precision, as they would in `JSON.parse`.
fn to_host(value: Value) -> HostValue {
    match value {
        Value::Null => HostValue::Null,
        Value::Bool(flag) => HostValue::Bool(flag),
        Value::Number(number) => HostValue::Number(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => HostValue::Str(text),
        Value::Array(values) => HostValue::Array(values.into_iter().map(to_host).collect()),
        Value::Object(fields) => HostValue::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name, to_host(value)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn module_without(target: Result<Target, String>) -> (tokio::runtime::Runtime, HostModule) {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let module = register(Arc::new(Bridge::new(target, runtime.handle().clone())));
        (runtime, module)
    }

    fn call(
        runtime: &tokio::runtime::Runtime,
        module: &HostModule,
        function: &str,
        arguments: Vec<HostValue>,
    ) -> HostResult {
        let work = module.begin(function, &HostArguments::new(arguments))?;
        runtime.block_on(work)
    }

    #[test]
    fn declarations_name_exactly_the_registered_functions() {
        let (_runtime, module) = module_without(Err("unused".into()));
        module.validate().unwrap();
        assert_eq!(
            module.function_names(),
            ["close", "mutate", "next", "query", "subscribe"]
        );
        assert!(
            ["query", "mutate", "subscribe", "next", "close"]
                .iter()
                .all(|name| module.is_async(name))
        );
    }

    #[test]
    fn whole_numbers_cross_as_integers() {
        let after = to_json(&HostValue::Number(42.0)).unwrap();
        assert_eq!(after, json!(42));
        assert_eq!(serde_json::from_value::<u64>(after).unwrap(), 42);
        assert_eq!(to_json(&HostValue::Number(-3.0)).unwrap(), json!(-3));
        assert_eq!(to_json(&HostValue::Number(-0.0)).unwrap(), json!(0));
        assert_eq!(to_json(&HostValue::Number(1.5)).unwrap(), json!(1.5));
        let inexact = to_json(&HostValue::Number(EXACT_INTEGER + 3.0)).unwrap();
        assert!(inexact.is_f64(), "{inexact}");
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(to_json(&HostValue::Number(number)).is_err());
        }
    }

    #[test]
    fn nested_values_cross_both_ways() {
        let input = HostValue::Object(vec![
            ("sessionId".into(), HostValue::from("s1")),
            ("after".into(), HostValue::Number(7.0)),
            (
                "position".into(),
                HostValue::Object(vec![("kind".into(), HostValue::from("start"))]),
            ),
            (
                "labels".into(),
                HostValue::Array(vec![HostValue::Null, HostValue::Bool(true)]),
            ),
        ]);
        let value = to_json(&input).unwrap();
        assert_eq!(
            value,
            json!({"sessionId":"s1","after":7,"position":{"kind":"start"},"labels":[null,true]})
        );
        let back = to_host(value);
        assert_eq!(back.get("after"), Some(&HostValue::Number(7.0)));
        assert_eq!(
            back.get("position")
                .and_then(|position| position.get("kind")),
            Some(&HostValue::from("start"))
        );
        assert_eq!(
            back.get("labels"),
            Some(&HostValue::Array(vec![
                HostValue::Null,
                HostValue::Bool(true)
            ]))
        );
        assert_eq!(
            to_json(&HostValue::Array(vec![HostValue::Number(f64::NAN)])).unwrap_err(),
            "NaN cannot be sent to the Host"
        );
    }

    #[test]
    fn the_address_comes_from_the_environment() {
        let missing = Target::from_env(None, None).unwrap_err();
        assert!(
            missing.contains("MAKA_HOST_ENDPOINT is not set"),
            "{missing}"
        );
        assert_eq!(
            Target::from_env(Some("".into()), None).unwrap_err(),
            missing
        );
        let epoch = Uuid::new_v4();
        assert_eq!(
            Target::from_env(Some("/run/h.sock".into()), Some(epoch.to_string().into())),
            Ok(Target {
                endpoint: "/run/h.sock".into(),
                epoch: Some(epoch),
            })
        );
        assert_eq!(
            Target::from_env(Some("/run/h.sock".into()), Some("".into())),
            Ok(Target {
                endpoint: "/run/h.sock".into(),
                epoch: None,
            })
        );
        assert_eq!(
            Target::from_env(Some("/run/h.sock".into()), Some("latest".into())).unwrap_err(),
            "MAKA_HOST_EPOCH is not a UUID: latest"
        );
    }

    #[test]
    fn handles_count_up_and_are_not_reused() {
        let mut handles = Handles::default();
        assert_eq!(handles.insert("first"), 1);
        assert_eq!(handles.insert("second"), 2);
        assert_eq!(*handles.get(2).unwrap(), "second");
        assert_eq!(handles.remove(1).as_deref(), Some(&"first"));
        assert!(handles.remove(1).is_none());
        assert_eq!(handles.get(1).unwrap_err(), "subscription 1 is not open");
        assert_eq!(handles.insert("third"), 3);
        assert_eq!(handles.get(0).unwrap_err(), "subscription 0 is not open");
    }

    #[test]
    fn calls_reject_without_a_host_address() {
        let (runtime, module) = module_without(Target::from_env(None, None));
        let args = vec![
            HostValue::from("agent"),
            HostValue::from("list"),
            HostValue::Object(vec![("filter".into(), HostValue::from("all"))]),
        ];
        for function in ["query", "mutate", "subscribe"] {
            let error = call(&runtime, &module, function, args.clone()).unwrap_err();
            assert!(
                error.message().contains("MAKA_HOST_ENDPOINT is not set"),
                "{function}: {}",
                error.message()
            );
        }
        // An argument of the wrong type is refused before any work starts.
        let error = module
            .begin("query", &HostArguments::new([HostValue::from("agent")]))
            .err()
            .unwrap();
        assert_eq!(error.message(), "argument 2 is missing; 1 were passed");
    }

    #[test]
    fn unknown_subscriptions_reject_next_and_ignore_close() {
        let (runtime, module) = module_without(Target::from_env(None, None));
        let error = call(&runtime, &module, "next", vec![HostValue::Number(7.0)]).unwrap_err();
        assert_eq!(error.message(), "subscription 7 is not open");
        assert_eq!(
            call(&runtime, &module, "close", vec![HostValue::Number(7.0)]).unwrap(),
            HostValue::Null
        );
    }

    #[test]
    fn an_unreachable_host_rejects_with_the_connect_error() {
        let endpoint =
            std::env::temp_dir().join(format!("maka-host-missing-{}.sock", Uuid::new_v4()));
        let (runtime, module) = module_without(Target::from_env(Some(endpoint.into()), None));
        let error = call(
            &runtime,
            &module,
            "query",
            vec![HostValue::from("agent"), HostValue::from("list")],
        )
        .unwrap_err();
        assert!(
            error
                .message()
                .starts_with("cannot connect to the Maka Host at "),
            "{}",
            error.message()
        );
    }
}
