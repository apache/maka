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

//! The connection owns reception and observations; Application owns execution.
use super::{
    catalogue::Catalogue,
    policy::{Peers, PolicyOwner},
    wire::{self, Control, Open, Reader, Reply},
};
use crate::application::Result;
use crate::application::{Client, QueryCompletion, RESOURCE_CHUNK_LIMIT, ResourceDescriptor};
use futures_util::FutureExt;
use maka_capabilities::call::Scope;
use maka_plugin_core::contract::{Interface, MethodMode};
use std::{
    collections::BTreeMap,
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite},
    sync::oneshot,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

struct Failed {
    _scope: Option<Scope>,
    reason: String,
}
/// Own this alongside the original Application and SQL Root. Close/drain this
/// first. Dropping a returned observer does not drop a running connection task.
pub struct Server {
    client: Client,
    policy: PolicyOwner,
    endpoints: Mutex<super::Endpoints>,
    stop: CancellationToken,
    tasks: TaskTracker,
    failed: Mutex<Vec<Failed>>,
    admission: Mutex<bool>,
}
impl Server {
    pub fn new(
        client: Client,
        policy: PolicyOwner,
        endpoints: impl Into<super::Endpoints>,
    ) -> Result<Arc<Self>> {
        let endpoints = endpoints.into();
        endpoints.validate()?;
        Ok(Arc::new(Self {
            client,
            policy,
            endpoints: Mutex::new(endpoints),
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
            failed: Mutex::new(Vec::new()),
            admission: Mutex::new(false),
        }))
    }
    pub fn catalogue(&self) -> Catalogue {
        Catalogue::captured(&self.endpoints.lock().unwrap())
    }
    pub fn replace_endpoints(&self, endpoints: super::Endpoints) -> Result<()> {
        endpoints.validate()?;
        let gate = self.admission.lock().unwrap();
        if *gate {
            return Err("Application transport is closing".into());
        }
        *self.endpoints.lock().unwrap() = endpoints;
        Ok(())
    }
    /// The embedding authenticates the actual private channel and chooses Peer.
    /// No incoming JSON or endpoint name constructs that approval.
    pub fn serve<R, W>(
        self: &Arc<Self>,
        reader: R,
        writer: W,
        peer: Arc<Peers>,
    ) -> Result<impl Future<Output = Result<()>> + Send + 'static>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_inner(reader, writer, peer, false)
    }
    /// The embedding has authenticated a public principal and selected its
    /// Host gateway consumers and endpoint grants. This mode records caller
    /// intents in the Host Root; incoming JSON cannot select this mode.
    pub fn serve_owned<R, W>(
        self: &Arc<Self>,
        reader: R,
        writer: W,
        peer: Arc<Peers>,
    ) -> Result<impl Future<Output = Result<()>> + Send + 'static>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_inner(reader, writer, peer, true)
    }
    fn serve_inner<R, W>(
        self: &Arc<Self>,
        reader: R,
        writer: W,
        peer: Arc<Peers>,
        owned: bool,
    ) -> Result<impl Future<Output = Result<()>> + Send + 'static>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let gate = self.admission.lock().unwrap();
        if *gate {
            return Err("Application transport is closing".into());
        }
        let server = self.clone();
        let (reply, result) = oneshot::channel();
        // Publish actual custody before returning the first-poll observer.
        self.tasks.spawn(async move {
            let mut session = Session {
                reader: Reader::new(reader),
                writer,
                scope: None,
                stop: server.stop.clone(),
                lost: false,
                pending: None,
            };
            let execution = AssertUnwindSafe(session.run(&server, peer, owned))
                .catch_unwind()
                .await;
            let panicked = execution.is_err();
            let execution =
                execution.unwrap_or_else(|_| Err("Application connection worker panicked".into()));
            let settlement = AssertUnwindSafe(async {
                match &session.scope {
                    Some(scope) => scope.finish().await.map_err(|e| e.to_string()),
                    None => Ok(()),
                }
            })
            .catch_unwind()
            .await;
            let scope = session.scope.take();
            // Each generic physical half can fail independently during Drop.
            // Keep Scope outside both unwind boundaries.
            let Session { reader, writer, .. } = session;
            let read_drop = std::panic::catch_unwind(AssertUnwindSafe(|| drop(reader)));
            let write_drop = std::panic::catch_unwind(AssertUnwindSafe(|| drop(writer)));
            let cleanup = match settlement {
                Ok(result) if !panicked && read_drop.is_ok() && write_drop.is_ok() => result,
                _ => Err("Application connection cleanup unconfirmed: worker or physical cleanup panicked".into()),
            };
            if let Err(reason) = &cleanup {
                let request_id = scope.as_ref().and_then(|scope| match &scope.identity {
                    maka_capabilities::call::Identity::Remote { request_id } => Some(tracing::field::display(request_id)),
                    _ => None,
                });
                tracing::error!(target: "maka_host_runtime::application", stage = "transport_cleanup", cause = "cleanup_unconfirmed",
                    request_id, "Host runtime failure");
                server.failed.lock().unwrap().push(Failed {
                    _scope: scope,
                    reason: reason.clone(),
                });
            }
            let _ = reply.send(execution.and(cleanup));
        });
        drop(gate);
        Ok(async move {
            result
                .await
                .map_err(|_| "Application connection owner disappeared".to_string())?
        })
    }
    /// Revoke admission and cancel original channels without acknowledging cleanup.
    pub fn request_close(&self) {
        let mut gate = self.admission.lock().unwrap();
        *gate = true;
        self.stop.cancel();
        self.tasks.close();
    }
    pub(crate) fn is_closing(&self) -> bool {
        *self.admission.lock().unwrap()
    }
    /// Observe the close request, not physical cleanup.
    pub fn wait_for_close(&self) -> impl Future<Output = ()> + Send + 'static {
        self.stop.clone().cancelled_owned()
    }
    /// Err retains failed Scope/connection custody. It never acknowledges SQL
    /// or Application cleanup, which the embedding observes independently next.
    pub async fn close(&self) -> Result<()> {
        self.request_close();
        self.tasks.wait().await;
        let failed = self.failed.lock().unwrap();
        if failed.is_empty() {
            Ok(())
        } else {
            Err(failed
                .iter()
                .map(|f| f.reason.as_str())
                .collect::<Vec<_>>()
                .join("; "))
        }
    }
}
struct Session<R, W> {
    reader: Reader<R>,
    writer: W,
    scope: Option<Scope>,
    stop: CancellationToken,
    lost: bool,
    pending: Option<Control>,
}
impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> Session<R, W> {
    async fn read<T: serde::de::DeserializeOwned>(&mut self) -> Result<T> {
        tokio::select! {biased; ()=self.stop.cancelled()=>Err("Application transport is closing".into()), result=self.reader.read()=>result}
    }
    async fn control(&mut self) -> Result<Control> {
        if let Some(control) = self.pending.take() {
            return Ok(control);
        }
        self.read().await
    }
    async fn ready(&mut self) -> Result<()> {
        // Before chunks begin, incoming bytes may be payload, not Control.
        // Peek without consuming them; BufReader preserves them for reception.
        use tokio::io::AsyncBufReadExt;
        let write = wire::write(&mut self.writer, &Reply::Ready);
        tokio::pin!(write);
        tokio::select! {biased;
            ()=self.stop.cancelled()=>Err("Application transport is closing".into()),
            bytes=self.reader.inner.fill_buf()=>{
                if bytes.map_err(|e|e.to_string())?.is_empty() {return Err("Application peer disappeared".into());}
                tokio::select! {biased; ()=self.stop.cancelled()=>Err("Application transport is closing".into()),result=&mut write=>result}
            },
            result=&mut write=>result,
        }
    }
    async fn send(&mut self, reply: &Reply) -> Result<()> {
        if self.lost {
            return Err("Application peer disappeared".into());
        }
        // The next valid successor may arrive after the peer receives bytes,
        // but before our flush resolves. Keep it for the next phase.
        let write = wire::write(&mut self.writer, reply);
        tokio::pin!(write);
        let result = tokio::select! {biased;
            ()=self.stop.cancelled()=>Err("Application transport is closing".into()),
            control=self.reader.read::<Control>()=>match control {
                Ok(control)=>{
                    if matches!(control, Control::Cancel) && let Some(scope) = &self.scope {
                        scope.cancellation.cancel();
                    }
                    self.pending=Some(control);
                    tokio::select! {biased;
                        ()=self.stop.cancelled()=>Err("Application transport is closing".into()),
                        _=self.reader.read::<Control>()=>Err("Application peer ended or pipelined before reply flush".into()),
                        result=&mut write=>result,
                    }
                },
                Err(e)=>Err(e),
            },
            result=&mut write=>result,
        };
        if result.is_err() {
            self.lost = true;
            if let Some(scope) = &self.scope {
                scope.cancellation.cancel();
            }
        }
        result
    }
    /// Never drops an admission/completion observer when EOF or cancellation
    /// wins. Await the same future after revoking the original Scope.
    async fn observe<T>(&mut self, future: impl Future<Output = T>) -> T {
        tokio::pin!(future);
        if self.lost {
            return future.await;
        }
        tokio::select! {biased;
            ()=self.stop.cancelled()=>{self.lost=true;self.scope.as_ref().unwrap().cancellation.cancel();future.await},
            control=self.reader.read::<Control>()=>{
                if matches!(control,Ok(Control::Cancel)) {
                    // The original observer may still return an accepted item.
                    // Preserve the peer's stop for the next protocol phase.
                    self.pending=Some(Control::Cancel);
                } else {self.lost=true;}
                self.scope.as_ref().unwrap().cancellation.cancel();future.await
            },
            result=&mut future=>result,
        }
    }
    async fn finish(&mut self, mut reply: Reply) -> Result<()> {
        let cleanup = self
            .scope
            .as_ref()
            .unwrap()
            .finish()
            .await
            .map_err(|e| e.to_string());
        match &mut reply {
            Reply::Finished {
                cleanup: current, ..
            }
            | Reply::Mutation {
                cleanup: current, ..
            }
            | Reply::Aborted {
                cleanup: current, ..
            }
            | Reply::BindingRetired {
                cleanup: current, ..
            } => *current = current.clone().and(cleanup),
            _ => unreachable!("terminal reply"),
        }
        self.send(&reply).await
    }
    async fn abort(&mut self, reason: String) -> Result<()> {
        if self.scope.is_some() {
            self.finish(Reply::Aborted {
                reason,
                cleanup: Ok(()),
            })
            .await
        } else {
            self.send(&Reply::Aborted {
                reason,
                cleanup: Ok(()),
            })
            .await
        }
    }
    async fn reject(
        &mut self,
        binding: &crate::application::Binding,
        reason: String,
    ) -> Result<()> {
        if binding.retired() {
            self.finish(Reply::BindingRetired {
                reason,
                cleanup: Ok(()),
            })
            .await
        } else {
            self.abort(reason).await
        }
    }
    async fn query(&mut self, completion: QueryCompletion) -> Result<()> {
        self.finish(Reply::Finished {
            result: completion.result,
            cleanup: completion.cleanup,
        })
        .await
    }
    async fn run(&mut self, server: &Server, peer: Arc<Peers>, owned: bool) -> Result<()> {
        let open: Open = self.read().await?;
        let descriptors: BTreeMap<String, ResourceDescriptor> = self.read().await?;
        let Some(endpoint) = server
            .endpoints
            .lock()
            .unwrap()
            .get(&open.endpoint)
            .cloned()
        else {
            return self
                .abort("Application endpoint is not granted".into())
                .await;
        };
        if endpoint.binding.registration_epoch() != open.registration_epoch {
            return self
                .abort("original Host registration is no longer available".into())
                .await;
        }
        if owned && &open.source.consumer != endpoint.binding.consumer().instance() {
            return self
                .abort("caller differs from the selected Host gateway".into())
                .await;
        }
        let scope = match server.policy.scope(
            &peer,
            open.source.clone(),
            endpoint.clone(),
            self.stop.clone(),
        ) {
            Ok(scope) => scope,
            Err(e) => return self.abort(e).await,
        };
        self.scope = Some(scope.clone());
        let Interface::Service { methods } = &endpoint.binding.contract().interface else {
            unreachable!()
        };
        let mode = match methods
            .get(&open.method)
            .filter(|_| endpoint.grant.methods.contains(&open.method))
        {
            Some(method) => method.mode,
            None => return self.abort("Application method is not granted".into()).await,
        };
        let mut capture = match server
            .client
            .capture_resources(scope.clone(), descriptors.clone())
        {
            Ok(c) => c,
            Err(e) => return self.abort(e).await,
        };
        self.ready().await?;
        let mut chunk = [0u8; RESOURCE_CHUNK_LIMIT];
        for (slot, descriptor) in descriptors {
            let mut offset = 0u64;
            while offset < descriptor.length {
                let length = tokio::select! {biased; ()=self.stop.cancelled()=>return Err("Application transport is closing".into()), result=self.reader.inner.read_u32()=>result.map_err(|e|e.to_string())?}
                    as usize;
                if length == 0
                    || length > RESOURCE_CHUNK_LIMIT
                    || length as u64 > descriptor.length - offset
                {
                    return Err("invalid Application resource chunk length".into());
                }
                tokio::select! {biased; ()=self.stop.cancelled()=>return Err("Application transport is closing".into()), result=self.reader.inner.read_exact(&mut chunk[..length])=>result.map_err(|e|e.to_string())?};
                capture.write(&slot, offset, &chunk[..length])?;
                offset += length as u64;
            }
        }
        let resources = capture.finish()?;
        match mode {
            MethodMode::Query => {
                let admission = server.client.start(
                    endpoint.binding.clone(),
                    open.method,
                    open.input,
                    scope,
                    resources,
                );
                match self.observe(admission).await {
                    Ok(accepted) => {
                        let completion = self.observe(accepted.completion()).await;
                        self.query(completion).await
                    }
                    Err(e) => self.reject(&endpoint.binding, e).await,
                }
            }
            MethodMode::Mutation => {
                let admission = server.client.prepare_mutation(
                    endpoint.binding.clone(),
                    open.method,
                    open.input,
                    scope,
                    open.source.request,
                    resources,
                );
                let prepared = match self.observe(admission).await {
                    Ok(p) => p,
                    Err(e) => return self.reject(&endpoint.binding, e).await,
                };
                if self.lost {
                    drop(prepared);
                    return Err("Application peer disappeared during preparation".into());
                }
                self.send(&Reply::Prepared {
                    reference: Box::new(prepared.reference().clone()),
                })
                .await?;
                let control = self.control().await?;
                match control {
                    Control::Cancel => {
                        drop(prepared);
                        self.abort("mutation preparation cancelled".into()).await
                    }
                    control @ (Control::Commit { .. } | Control::Confirm)
                        if matches!(
                            (&control, owned),
                            (Control::Commit { .. }, false) | (Control::Confirm, true)
                        ) =>
                    {
                        let reference = prepared.reference().clone();
                        let admission = async {
                            match control {
                                Control::Commit { intent } => {
                                    server.client.mutate_from_peer(prepared, *intent).await
                                }
                                Control::Confirm => server.client.mutate_owned(prepared).await,
                                _ => unreachable!(),
                            }
                        };
                        let completion = match self.observe(admission).await {
                            Ok(mut accepted) => {
                                while let Some(value) = self.observe(accepted.recv()).await {
                                    // A disconnected observer still drains the original owner.
                                    // Progress never substitutes for its final receipt or cleanup.
                                    let _ = self.send(&Reply::Progress { value }).await;
                                }
                                self.observe(accepted.completion()).await
                            }
                            Err(diagnostic) => crate::application::MutationCompletion {
                                reply: maka_plugin_core::operation::OperationReply {
                                    reference,
                                    receipt: maka_plugin_core::operation::Receipt::Unavailable {
                                        diagnostic,
                                    },
                                },
                                cleanup: Ok(()),
                            },
                        };
                        self.finish(Reply::Mutation {
                            reply: Box::new(completion.reply),
                            cleanup: completion.cleanup,
                        })
                        .await
                    }
                    _ => {
                        drop(prepared);
                        self.abort("mutation requires caller commit or cancellation".into())
                            .await
                    }
                }
            }
            MethodMode::Subscription => {
                let admission = server.client.subscribe(
                    endpoint.binding.clone(),
                    open.method,
                    open.input,
                    scope,
                    resources,
                );
                let mut stream = match self.observe(admission).await {
                    Ok(stream) => stream,
                    Err(e) => return self.reject(&endpoint.binding, e).await,
                };
                if self.send(&Reply::Subscribed).await.is_err() {
                    stream.cancel();
                }
                loop {
                    if self.lost {
                        stream.cancel();
                        break;
                    }
                    match self.control().await {
                        Ok(Control::Pull) => {
                            let item = self.observe(stream.recv()).await;
                            if let Some(value) = item {
                                if self.send(&Reply::Item { value }).await.is_err() {
                                    stream.cancel();
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                        Ok(Control::Cancel) => {
                            stream.cancel();
                            break;
                        }
                        _ => {
                            self.lost = true;
                            stream.cancel();
                            break;
                        }
                    }
                }
                let completion = self.observe(stream.completion()).await;
                self.query(completion).await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Poll, Waker},
    };
    use tokio::{io::DuplexStream, sync::Semaphore};
    struct Gate {
        entered: Semaphore,
        release: AtomicBool,
        waker: Mutex<Option<Waker>>,
    }
    struct FlushGate {
        inner: DuplexStream,
        gate: Arc<Gate>,
    }
    impl AsyncWrite for FlushGate {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Pin::new(&mut self.inner).poll_write(cx, bytes)
        }
        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            if self.gate.release.load(Ordering::SeqCst) {
                return Poll::Ready(Ok(()));
            }
            *self.gate.waker.lock().unwrap() = Some(cx.waker().clone());
            self.gate.entered.add_permits(1);
            Poll::Pending
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }
    fn scope() -> Scope {
        maka_capabilities::call::Issuer::default()
            .issue(
                maka_capabilities::call::Identity::Remote {
                    request_id: uuid::Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap()
    }
    #[tokio::test]
    async fn cancellation_during_reply_flush_keeps_the_same_channel_for_cleanup() {
        let (input, mut command) = tokio::io::duplex(128);
        let (output, reply) = tokio::io::duplex(128);
        let mut reply = Reader::new(reply);
        let gate = Arc::new(Gate {
            entered: Semaphore::new(0),
            release: AtomicBool::new(false),
            waker: Mutex::new(None),
        });
        let scope = scope();
        let observed = scope.clone();
        let task = tokio::spawn({
            let gate = gate.clone();
            async move {
                let mut session = Session {
                    reader: Reader::new(input),
                    writer: FlushGate {
                        inner: output,
                        gate,
                    },
                    scope: Some(scope),
                    stop: CancellationToken::new(),
                    lost: false,
                    pending: None,
                };
                session.send(&Reply::Subscribed).await.unwrap();
                assert!(!session.lost);
                assert!(matches!(session.control().await.unwrap(), Control::Cancel));
                session.abort("cancelled".into()).await.unwrap();
            }
        });
        gate.entered.acquire().await.unwrap().forget();
        assert!(matches!(
            reply.read::<Reply>().await.unwrap(),
            Reply::Subscribed
        ));
        wire::write(&mut command, &Control::Cancel).await.unwrap();
        observed.cancellation.cancelled().await;
        gate.release.store(true, Ordering::SeqCst);
        gate.waker.lock().unwrap().take().unwrap().wake();
        assert!(matches!(
            reply.read::<Reply>().await.unwrap(),
            Reply::Aborted {
                cleanup: Ok(()),
                ..
            }
        ));
        task.await.unwrap();
        observed.finish().await.unwrap();
    }
    #[tokio::test]
    async fn cancellation_while_receiving_a_queued_item_survives_until_cleanup() {
        let (input, mut command) = tokio::io::duplex(128);
        let (output, reply) = tokio::io::duplex(1024);
        let mut reply = Reader::new(reply);
        let scope = scope();
        let mut resource = scope.resources.reserve().unwrap();
        resource.start();
        let (mut items, emitter) = crate::application::subscriptions::items(
            Arc::new(jsonschema::validator_for(&serde_json::json!({})).unwrap()),
            scope.cancellation.clone(),
        );
        let value = serde_json::json!("already accepted");
        emitter.emit(value.clone()).await.unwrap();
        let mut session = Session {
            reader: Reader::new(input),
            writer: output,
            scope: Some(scope.clone()),
            stop: CancellationToken::new(),
            lost: false,
            pending: None,
        };
        // Both are ready on the same poll: cancellation wins observation,
        // but the real subscription queue still returns its accepted item.
        wire::write(&mut command, &Control::Cancel).await.unwrap();
        assert_eq!(session.observe(items.recv()).await, Some(value.clone()));
        assert!(scope.cancellation.is_cancelled());
        assert!(!session.lost);
        session
            .send(&Reply::Item {
                value: value.clone(),
            })
            .await
            .unwrap();
        assert!(matches!(
            reply.read::<Reply>().await.unwrap(),
            Reply::Item { value: received } if received == value
        ));
        // The peer has already sent its one Cancel and now only reads.
        assert!(matches!(
            session.control().now_or_never(),
            Some(Ok(Control::Cancel))
        ));
        let finish = session.finish(Reply::Finished {
            result: Ok(serde_json::Value::Null),
            cleanup: Ok(()),
        });
        tokio::pin!(finish);
        assert!(finish.as_mut().now_or_never().is_none());
        resource.complete(Ok(()));
        finish.await.unwrap();
        assert!(matches!(
            reply.read::<Reply>().await.unwrap(),
            Reply::Finished {
                cleanup: Ok(()),
                ..
            }
        ));
        scope.finish().await.unwrap();
    }
    #[tokio::test]
    async fn eof_revokes_but_does_not_drop_the_same_admission_observer() {
        let (input, peer) = tokio::io::duplex(64);
        let scope = scope();
        let observed = scope.clone();
        let release = Arc::new(Semaphore::new(0));
        let task = tokio::spawn({
            let release = release.clone();
            async move {
                let mut session = Session {
                    reader: Reader::new(input),
                    writer: tokio::io::sink(),
                    scope: Some(scope),
                    stop: CancellationToken::new(),
                    lost: false,
                    pending: None,
                };
                let value = session
                    .observe(async {
                        release.acquire().await.unwrap().forget();
                        17
                    })
                    .await;
                assert!(session.lost);
                value
            }
        });
        drop(peer);
        observed.cancellation.cancelled().await;
        assert!(!task.is_finished());
        release.add_permits(1);
        assert_eq!(task.await.unwrap(), 17);
        observed.finish().await.unwrap();
    }
}
