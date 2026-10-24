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

//! Authenticate actual HTTP/WebSocket channels before creating application authority.
#[allow(dead_code)]
mod support;
use futures_util::{SinkExt, StreamExt};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        NativeRegistry,
        host::{Client, Host, Pairing, websocket::WebSocketListener},
        transport::{Grant, HostEndpoint, wire},
    },
    ipc::LocalListener,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
use uuid::Uuid;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
async fn socket(
    address: &str,
    pairing: &Pairing,
    origin: Option<&str>,
) -> Result<Socket, tokio_tungstenite::tungstenite::Error> {
    let mut request = address.into_client_request().unwrap();
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", pairing.credential).parse().unwrap(),
    );
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| socket)
}
async fn send(socket: &mut Socket, value: Value) {
    let mut frame = Vec::new();
    wire::write(&mut frame, &value).await.unwrap();
    socket.send(Message::Binary(frame.into())).await.unwrap();
}
async fn receive(socket: &mut Socket) -> Value {
    receive_result(socket).await.unwrap()
}
async fn receive_result(socket: &mut Socket) -> Result<Value, String> {
    let mut bytes = Vec::new();
    loop {
        match socket
            .next()
            .await
            .ok_or("WebSocket ended before reply")?
            .map_err(|error| error.to_string())?
        {
            Message::Binary(chunk) => bytes.extend_from_slice(&chunk),
            Message::Ping(_) | Message::Pong(_) => continue,
            _ => return Err("WebSocket closed before application reply".into()),
        }
        if bytes.len() >= 4 {
            let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            if bytes.len() >= length + 4 {
                if bytes.len() != length + 4 {
                    return Err("application frame body length differs from prefix".into());
                }
                return wire::Reader::new(bytes.as_slice()).read().await;
            }
        }
    }
}

fn opening(epoch: Uuid, client: &str, request: Value) -> Value {
    json!({"version":1,"epoch":epoch,"client_instance":client,"request":request})
}
async fn finalized(address: &str, pairing: &Pairing, epoch: Uuid, client: &str) {
    let mut socket = socket(address, pairing, None).await.unwrap();
    send(
        &mut socket,
        opening(epoch, client, json!({"kind":"finalize_access"})),
    )
    .await;
    assert_eq!(
        receive(&mut socket).await,
        json!({"kind":"finalized","value":{"Ok":null}})
    );
}
async fn connected(address: &str, pairing: &Pairing, epoch: Uuid, client: &str) -> (Socket, Value) {
    let mut socket = socket(address, pairing, None).await.unwrap();
    socket
        .send(Message::Ping(b"application".as_slice().into()))
        .await
        .unwrap();
    send(
        &mut socket,
        opening(epoch, client, json!({"kind":"connect"})),
    )
    .await;
    let value = receive(&mut socket).await;
    assert_eq!(value["kind"], "connected");
    (socket, value["value"].clone())
}
async fn rejected(mut socket: Socket, request: Value) {
    send(&mut socket, request).await;
    assert!(!matches!(socket.next().await, Some(Ok(Message::Binary(_)))));
}
async fn read_counter(
    address: &str,
    pairing: &Pairing,
    epoch: Uuid,
    client: &str,
    session: &Value,
) -> Value {
    let mut socket = socket(address, pairing, None).await.unwrap();
    send(
        &mut socket,
        opening(
            epoch,
            client,
            json!({"kind":"call","session":session["session"]}),
        ),
    )
    .await;
    assert_eq!(receive(&mut socket).await["kind"], "accepted");
    send(&mut socket, json!({
        "endpoint":"business", "registration_epoch":session["catalogue"]["endpoints"]["business"]["registration_epoch"],
        "source":{"deployment":session["source"],"consumer":session["consumers"]["business"],"mount":session["session"],"request":Uuid::new_v4()},
        "method":"read", "input":null,
    })).await;
    send(&mut socket, json!({})).await;
    assert_eq!(receive(&mut socket).await["kind"], "ready");
    let result = receive(&mut socket).await;
    assert_eq!(result["kind"], "finished");
    assert_eq!(result["cleanup"], json!({"Ok":null}));
    result["result"]["Ok"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_pairing_binds_client_source_and_session_and_revokes_original_channels() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        maka_event_log::root::private_directory(directory.path()).unwrap();
        let namespaces = RootNamespaces { ownership: directory.path().join("owners"), control: directory.path().join("control") };
        let root = directory.path().join("root");
        let store = Arc::new(support::setup(RootStore::open(Arc::new(RootOwner::create(&root, &namespaces).unwrap()))).await.unwrap());
        let deployment = Uuid::new_v4();
        let (input, packages) = support::host();
        store.commit_application(deployment, 0, input, vec![], packages).await.unwrap();
        let selections = BTreeMap::from([("business".into(), HostEndpoint { consumer: support::identity(13), import: "business".into(), grant: Grant { methods: ["read".into(), "write".into()].into(), recovery: false } })]);
        let host = Host::open(store.clone(), deployment, NativeRegistry::default(), Some(maka_host_js::factory(Default::default())), selections.clone(), vec![]).await.unwrap();
        #[cfg(unix)]
        let local = directory.path().join("host.sock");
        #[cfg(windows)]
        let local = std::path::PathBuf::from(format!(r"\\.\pipe\maka-remote-test-{}", Uuid::new_v4()));
        let listener = LocalListener::bind(&local).unwrap();
        let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![]).await.unwrap();
        let address = format!("ws://{}/runtime-host", websocket.local_addr().unwrap());
        let stop = tokio_util::sync::CancellationToken::new();
        let serving = tokio::spawn({ let host = host.clone(); let stop = stop.clone(); async move { host.serve(listener, Some(websocket), stop).await } });
        assert!(tokio_tungstenite::connect_async(&address).await.is_err());
        let first = Client::prepare_access(&local, host.epoch(), "first".into()).await.unwrap();
        assert!(socket(&address, &first, Some("https://untrusted.example")).await.is_err());
        rejected(socket(&address, &first, None).await.unwrap(), opening(host.epoch(), "client-one", json!({"kind":"connect"}))).await;
        finalized(&address, &first, host.epoch(), "client-one").await;
        rejected(socket(&address, &first, None).await.unwrap(), opening(host.epoch(), "client-two", json!({"kind":"connect"}))).await;
        let (mut first_anchor, first_session) = connected(&address, &first, host.epoch(), "client-one").await;
        assert_eq!(read_counter(&address, &first, host.epoch(), "client-one", &first_session).await["effects"], 0);
        // A real remote mutation uses the Host's original caller intent, too.
        let mut write = socket(&address, &first, None).await.unwrap();
        send(&mut write, opening(host.epoch(), "client-one", json!({"kind":"call","session":first_session["session"]}))).await;
        assert_eq!(receive(&mut write).await["kind"], "accepted");
        let operation = Uuid::new_v4();
        send(&mut write, json!({
            "endpoint":"business", "registration_epoch":first_session["catalogue"]["endpoints"]["business"]["registration_epoch"],
            "source":{"deployment":first_session["source"],"consumer":first_session["consumers"]["business"],"mount":first_session["session"],"request":operation},
            "method":"write", "input":null,
        })).await;
        send(&mut write, json!({})).await;
        assert_eq!(receive(&mut write).await["kind"], "ready");
        let prepared = receive(&mut write).await;
        assert_eq!(prepared["kind"], "prepared");
        assert!(store.application_intent(deployment, support::identity(13), operation).await.unwrap().is_none());
        send(&mut write, json!({"kind":"confirm"})).await;
        let completed = receive(&mut write).await;
        assert_eq!(completed["kind"], "mutation");
        assert_eq!(completed["reply"]["receipt"]["outcome"]["value"]["effects"], 1);
        let recorded = store.application_intent(deployment, support::identity(13), operation).await.unwrap().unwrap();
        assert_eq!(serde_json::to_value(recorded.reference).unwrap(), prepared["reference"]);
        // Even an authenticated remote owner cannot use native lifecycle or credential controls.
        rejected(socket(&address, &first, None).await.unwrap(), opening(host.epoch(), "client-one", json!({"kind":"retire"}))).await;
        rejected(socket(&address, &first, None).await.unwrap(), opening(host.epoch(), "client-one", json!({"kind":"prepare_access","principal":"intruder"}))).await;
        rejected(socket(&address, &first, None).await.unwrap(), opening(host.epoch(), "client-one", json!({
            "kind":"connect_peer", "source":host.source(), "consumers":[support::identity(13)], "endpoints":selections,
        }))).await;
        let second = Client::prepare_access(&local, host.epoch(), "second".into()).await.unwrap();
        finalized(&address, &second, host.epoch(), "client-two").await;
        let (mut second_anchor, second_session) = connected(&address, &second, host.epoch(), "client-two").await;
        rejected(socket(&address, &second, None).await.unwrap(), opening(host.epoch(), "client-two", json!({"kind":"call","session":first_session["session"]}))).await;
        assert!(Client::revoke_access(&local, host.epoch(), first.credential_id.clone()).await.unwrap());
        assert_eq!(receive(&mut first_anchor).await["kind"], "closed");
        assert!(socket(&address, &first, None).await.is_err());
        assert_eq!(read_counter(&address, &second, host.epoch(), "client-two", &second_session).await["effects"], 1);
        send(&mut second_anchor, json!({"kind":"close"})).await;
        assert_eq!(receive(&mut second_anchor).await["kind"], "closed");
        stop.cancel();
        serving.await.unwrap().unwrap();
        drop((host, store));
        // A changed published grant set never silently reinterprets an old credential.
        let store = Arc::new(support::setup(RootStore::open(Arc::new(RootOwner::open(&root, &namespaces).unwrap()))).await.unwrap());
        let mut selections = selections;
        selections.get_mut("business").unwrap().grant.methods.remove("write");
        let host = Host::open(store.clone(), deployment, NativeRegistry::default(), Some(maka_host_js::factory(Default::default())), selections, vec![]).await.unwrap();
        let listener = LocalListener::bind(&local).unwrap();
        let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![]).await.unwrap();
        let address = format!("ws://{}/runtime-host", websocket.local_addr().unwrap());
        let stop = tokio_util::sync::CancellationToken::new();
        let serving = tokio::spawn({ let host = host.clone(); let stop = stop.clone(); async move { host.serve(listener, Some(websocket), stop).await } });
        assert!(socket(&address, &second, None).await.is_err());
        stop.cancel();
        serving.await.unwrap().unwrap();
        drop((host, store));
        drop(RootOwner::open(&root, &namespaces).unwrap());
    }).await.unwrap();
}

#[derive(Default)]
struct RemoteEcho {
    calls: std::sync::Mutex<Vec<Value>>,
    closed: std::sync::atomic::AtomicUsize,
}
impl maka_host_runtime::application::Handler for RemoteEcho {
    fn call(
        &self,
        _: String,
        input: Value,
        _: maka_host_runtime::application::Context,
    ) -> futures_util::future::BoxFuture<'static, Result<Value, String>> {
        self.calls.lock().unwrap().push(input.clone());
        Box::pin(async move { Ok(input) })
    }
}
impl maka_host_runtime::application::NativeOwner for RemoteEcho {
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
        self.closed
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_pairing_preserves_large_original_query_and_cleanup() {
    tokio::time::timeout(Duration::from_secs(30),async {
        let expected=json!({"head":"原始","text":"中🙂\"\\\n\0".repeat(160_000),"tail":"尾"});
        assert!(serde_json::to_vec(&expected).unwrap().len()>2*1024*1024);
        let directory=tempfile::tempdir().unwrap();
        maka_event_log::root::private_directory(directory.path()).unwrap();
        let namespaces=RootNamespaces { ownership:directory.path().join("owners"),control:directory.path().join("control") };
        let root=directory.path().join("root");
        let store=Arc::new(support::setup(RootStore::open(Arc::new(RootOwner::create(&root,&namespaces).unwrap()))).await.unwrap());
        let deployment=Uuid::new_v4();
        let (input,packages)=support::native_host("remote.echo");
        let provider=Arc::new(RemoteEcho::default());
        let mut native=NativeRegistry::default();
        native.insert("remote.echo".into(),Arc::new({ let provider=provider.clone();move |_,_| {
            let provider=provider.clone();Box::pin(async move { maka_host_runtime::application::NativeActivation {
                exports:Ok(BTreeMap::from([("Counter".into(),maka_plugin_core::runtime::Published { contract:support::business(),value:provider.clone() as Arc<dyn maka_host_runtime::application::Handler> })])),owner:provider,
            } })
        } })).unwrap();
        store.commit_application(deployment,0,input,vec![],packages).await.unwrap();
        let host=Host::open(store.clone(),deployment,native,Some(maka_host_js::factory(Default::default())),BTreeMap::from([
            ("business".into(),HostEndpoint { consumer:support::identity(13),import:"business".into(),grant:Grant { methods:["read".into()].into(),recovery:false } }),
        ]),vec![]).await.unwrap();
        #[cfg(unix)] let local=directory.path().join("large.sock");
        #[cfg(windows)] let local=std::path::PathBuf::from(format!(r"\\.\pipe\maka-large-remote-{}",Uuid::new_v4()));
        let listener=LocalListener::bind(&local).unwrap();
        let websocket=WebSocketListener::bind("127.0.0.1:0".parse().unwrap(),vec![]).await.unwrap();
        let address=format!("ws://{}/runtime-host",websocket.local_addr().unwrap());
        let stop=tokio_util::sync::CancellationToken::new();
        let serving=tokio::spawn({ let host=host.clone();let stop=stop.clone();async move { host.serve(listener,Some(websocket),stop).await } });
        let pairing=Client::prepare_access(&local,host.epoch(),"large".into()).await.unwrap();
        finalized(&address,&pairing,host.epoch(),"large-client").await;
        let (mut anchor,session)=connected(&address,&pairing,host.epoch(),"large-client").await;
        let mut channel=socket(&address,&pairing,None).await.unwrap();
        send(&mut channel,opening(host.epoch(),"large-client",json!({"kind":"call","session":session["session"]}))).await;
        assert_eq!(receive(&mut channel).await["kind"],"accepted");
        let open=json!({"endpoint":"business","registration_epoch":session["catalogue"]["endpoints"]["business"]["registration_epoch"],
            "source":{"deployment":session["source"],"consumer":session["consumers"]["business"],"mount":session["session"],"request":Uuid::new_v4()},
            "method":"read","input":expected});
        // A real peer sends one complete WebSocket message. Use the unchanged
        // u32 Application prefix directly so old local writer policy cannot
        // conceal the server's independent WebSocket ingress refusal.
        let body=serde_json::to_vec(&open).unwrap();
        let length=u32::try_from(body.len()).unwrap();
        let mut frame=length.to_be_bytes().to_vec();frame.extend_from_slice(&body);
        let exchange:Result<Value,String>=async {
            channel.send(Message::Binary(frame.into())).await.map_err(|error|error.to_string())?;
            let mut descriptors=Vec::new();wire::write(&mut descriptors,&json!({})).await?;
            channel.send(Message::Binary(descriptors.into())).await.map_err(|error|error.to_string())?;
            let ready=receive_result(&mut channel).await?;
            if ready["kind"]!="ready" { return Err("large query did not become ready".into()); }
            receive_result(&mut channel).await
        }.await;
        let channel_close=channel.close(None).await;
        send(&mut anchor,json!({"kind":"close"})).await;
        let session_close=receive_result(&mut anchor).await;
        stop.cancel();serving.await.unwrap().unwrap();
        drop((channel,anchor,host,store));
        drop(RootOwner::open(&root,&namespaces).unwrap());
        eprintln!("remote large query bytes={length} error={:?} channel_close_ok={} session_close_ok={}",exchange.as_ref().err(),channel_close.is_ok(),session_close.is_ok());
        let completed=exchange.expect("large paired WebSocket query must complete");
        assert_eq!(completed["kind"],"finished");
        assert!(completed["result"]["Ok"]==expected,"remote echo changed original Unicode/escaped input");
        assert_eq!(completed["cleanup"],json!({"Ok":null}));
        assert_eq!(session_close.unwrap()["kind"],"closed");
        assert!(*provider.calls.lock().unwrap()==vec![expected],"remote original input/call count changed");
        assert_eq!(provider.closed.load(std::sync::atomic::Ordering::SeqCst),1);
    }).await.unwrap();
}
