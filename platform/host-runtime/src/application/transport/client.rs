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

//! Caller-side physical custody. Errors never imply remote cleanup.
use super::{
    Selection,
    wire::{self, Control, Open, Reader, Reply, Source},
};
use crate::application::Result;
use crate::application::{RESOURCE_CHUNK_LIMIT, ResourceDescriptor};
use maka_capabilities::call::Attachments;
use maka_capabilities::call::ResourceEncoding;
use maka_event_log::applications::intents::RecordedIntent;
use maka_plugin_core::operation::RecoveryRef;
use serde_json::Value;
use std::collections::BTreeMap;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// Keep this original owner after an I/O error. It retains the actual caller
/// SQL token and local immutable inputs until this invocation's cleanup ack.
/// A recovered business receipt does not close this request or replay it.
pub struct Call<R, W> {
    connection: Connection<R, W>,
    source: Source,
    resources: Attachments,
    reference: Option<RecoveryRef>,
    recorded: Option<RecordedIntent>,
    phase: Phase,
    cancel_sent: bool,
    binding_retired: bool,
}
struct Channel<R, W> {
    reader: Reader<R>,
    writer: W,
}
enum Connection<R, W> {
    Connected {
        channel: Channel<R, W>,
        access: Access,
    },
    Disconnected,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Writable,
    SettlementOnly,
    Unconfirmed,
}
impl<R, W> Connection<R, W> {
    fn access(&self) -> Option<Access> {
        match self {
            Self::Connected { access, .. } => Some(*access),
            Self::Disconnected => None,
        }
    }
    fn unconfirm(&mut self) {
        if let Self::Connected { access, .. } = self {
            *access = Access::Unconfirmed;
        }
    }
}
#[expect(
    clippy::large_enum_variant,
    reason = "Keep the original opening inline without allocating for every call"
)]
enum Phase {
    New(Open),
    Inert,
    Opening,
    Open,
    Streaming,
    Prepared,
    Dispatched,
    Closed,
}
impl Phase {
    fn receives(&self) -> bool {
        matches!(
            self,
            Self::Open | Self::Streaming | Self::Prepared | Self::Dispatched
        )
    }
}
impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> Call<R, W> {
    /// Constructs inert custody. The connector, not Source, authenticates the
    /// actual physical endpoint; NativeService adapters derive Source from the
    /// checked ServiceRequest rather than from guest-provided JSON.
    pub fn new(
        reader: R,
        writer: W,
        endpoint: Selection,
        source: Source,
        method: String,
        input: Value,
        resources: Attachments,
    ) -> Self {
        let open = Open {
            registration_epoch: endpoint
                .description
                .registration_epoch
                .expect("Selection requires an actual registration"),
            endpoint: endpoint.endpoint,
            source: source.clone(),
            method,
            input,
        };
        Self {
            connection: Connection::Connected {
                channel: Channel {
                    reader: Reader::new(reader),
                    writer,
                },
                access: Access::Writable,
            },
            source,
            resources,
            reference: None,
            recorded: None,
            phase: Phase::New(open),
            cancel_sent: false,
            binding_retired: false,
        }
    }
    pub fn reference(&self) -> Option<&RecoveryRef> {
        self.reference.as_ref()
    }
    pub fn cleanup_confirmed(&self) -> bool {
        matches!(self.phase, Phase::Closed)
    }
    pub fn holds_caller_intent(&self) -> bool {
        self.recorded.is_some()
    }
    pub fn binding_retired(&self) -> bool {
        self.binding_retired
    }
    /// The original physical call has not begun a confirmation or transferred caller custody.
    pub fn awaiting_confirmation(&self) -> bool {
        matches!(self.phase, Phase::Prepared)
            && self.recorded.is_none()
            && self.connection.access() == Some(Access::Writable)
    }
    /// Disconnects only the physical channel, retaining this invocation's
    /// unconfirmed token and immutable inputs. Remote EOF requests cancellation;
    /// it is not an acknowledgement of remote execution cleanup.
    pub fn disconnect(&mut self) {
        if let Connection::Connected {
            channel: Channel { reader, writer },
            ..
        } = std::mem::replace(&mut self.connection, Connection::Disconnected)
        {
            // Drop both halves even if an embedding's destructor panics. Keep
            // original custody outside these unwind boundaries.
            let input = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(reader)));
            let output = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(writer)));
            if let Err(panic) = input.and(output) {
                std::panic::resume_unwind(panic);
            }
        }
    }
    /// Transfer descriptor observations, then chunks only after original Host
    /// reservation. No whole-payload clone or socket-backed ReadResource exists.
    pub async fn start(&mut self) -> Result<()> {
        self.start_unless(|| false).await
    }
    pub async fn start_unless(&mut self, cancelled: impl Fn() -> bool) -> Result<()> {
        if !matches!(self.phase, Phase::New(_) | Phase::Inert)
            || self.connection.access() != Some(Access::Writable)
        {
            return Err("remote call is not new".into());
        }
        let Phase::New(open) = std::mem::replace(&mut self.phase, Phase::Inert) else {
            return Err("remote opening already observed".into());
        };
        let mut descriptors = BTreeMap::new();
        for (slot, resource) in &self.resources {
            descriptors.insert(
                slot.clone(),
                ResourceDescriptor {
                    encoding: resource.encoding(),
                    resource: resource.resource_type(),
                    length: resource.bytes() as u64,
                    metadata: resource.metadata(),
                },
            );
        }
        // Native resource observations can synchronously hold real custody.
        // Cancellation during them still precedes every wire byte. Preserve the
        // original inert boundary until the first write can actually begin.
        if cancelled() {
            return Err("remote opening cancelled before dispatch".into());
        }
        self.phase = Phase::Opening;
        let Connection::Connected { channel, access } = &mut self.connection else {
            unreachable!("a new request retains its original channel")
        };
        *access = Access::Unconfirmed;
        wire::write(&mut channel.writer, &open).await?;
        wire::write(&mut channel.writer, &descriptors).await?;
        let reply = channel.reader.read::<Reply>().await?;
        if !matches!(reply, Reply::Ready) {
            self.accept_reply(&reply)?;
            return match reply {
                Reply::Aborted { reason, .. } | Reply::BindingRetired { reason, .. } => Err(reason),
                _ => Err("remote call did not reserve resources".into()),
            };
        }
        let Connection::Connected { channel, access } = &mut self.connection else {
            unreachable!("an opening request retains its original channel")
        };
        for (slot, descriptor) in descriptors {
            let resource = &self.resources[&slot];
            let mut offset = 0usize;
            let length =
                usize::try_from(descriptor.length).map_err(|_| "invalid remote resource length")?;
            while offset < length {
                let mut end = length.min(offset + RESOURCE_CHUNK_LIMIT);
                let mut value = resource.read(offset..end);
                // Native UTF-8 resources reject interior byte boundaries. A
                // transport chunk may end at the preceding scalar boundary.
                if descriptor.encoding == ResourceEncoding::Utf8 {
                    for _ in 0..3 {
                        if value.is_ok() {
                            break;
                        }
                        end -= 1;
                        if end <= offset {
                            break;
                        }
                        value = resource.read(offset..end);
                    }
                }
                let value = value?;
                if value.len() != end - offset || value.is_empty() {
                    return Err("resource returned a different byte range".into());
                }
                channel
                    .writer
                    .write_u32(value.len() as u32)
                    .await
                    .map_err(|e| e.to_string())?;
                channel
                    .writer
                    .write_all(&value)
                    .await
                    .map_err(|e| e.to_string())?;
                offset = end;
            }
        }
        channel.writer.flush().await.map_err(|e| e.to_string())?;
        *access = Access::Writable;
        self.phase = Phase::Open;
        Ok(())
    }
    /// Query completion or original mutation preparation. This is an observer;
    /// dropping its future does not establish cleanup or permit request replay.
    pub async fn receive(&mut self) -> Result<Reply> {
        if !self.phase.receives() || self.connection.access() != Some(Access::Writable) {
            return Err("remote call cannot receive in this phase".into());
        }
        let Connection::Connected { channel, .. } = &mut self.connection else {
            unreachable!("a receivable request retains its original channel")
        };
        let reply = match channel.reader.read::<Reply>().await {
            Ok(reply) => reply,
            Err(e) => {
                self.connection.unconfirm();
                return Err(e);
            }
        };
        if let Err(e) = self.accept_reply(&reply) {
            self.connection.unconfirm();
            return Err(e);
        }
        Ok(reply)
    }
    /// One demand successor; no background socket reader prefetches items.
    pub async fn pull(&mut self) -> Result<Reply> {
        if !matches!(self.phase, Phase::Streaming)
            || self.cancel_sent
            || self.connection.access() != Some(Access::Writable)
        {
            return Err("remote call cannot pull in this phase".into());
        }
        let Connection::Connected { channel, access } = &mut self.connection else {
            unreachable!("a streaming request retains its original channel")
        };
        *access = Access::SettlementOnly;
        wire::write(&mut channel.writer, &Control::Pull).await?;
        *access = Access::Writable;
        self.receive().await
    }
    /// Transfers real caller custody synchronously, before the dispatch observer
    /// is first polled. Dropping that observer cannot drop the confirmed token.
    pub fn commit(&mut self, recorded: RecordedIntent) -> impl Future<Output = Result<Reply>> + '_ {
        let validation = if matches!(self.phase, Phase::Closed) || self.recorded.is_some() {
            Err("remote mutation is not awaiting caller confirmation".to_string())
        } else {
            // A concurrent close can lose this channel before an already
            // confirmed dispatch observer is polled. Rejection must retain its
            // real token until original cleanup, even when no write is allowed.
            self.recorded = Some(recorded);
            let intent = self.recorded.as_ref().unwrap().intent();
            if !matches!(self.phase, Phase::Prepared)
                || self.connection.access() != Some(Access::Writable)
                || self.cancel_sent
                || intent.caller != self.source.deployment
                || intent.consumer != self.source.consumer
                || self.reference.as_ref() != Some(&intent.reference)
            {
                Err("caller token differs from the original remote preparation".to_string())
            } else {
                Ok(Control::Commit {
                    intent: Box::new(intent.confirmation()),
                })
            }
        };
        async move {
            let control = validation?;
            self.phase = Phase::Dispatched;
            let Connection::Connected { channel, access } = &mut self.connection else {
                unreachable!("a confirmed request retains its original channel")
            };
            *access = Access::SettlementOnly;
            wire::write(&mut channel.writer, &control).await?;
            *access = Access::Writable;
            self.receive().await
        }
    }
    /// Confirm a mutation whose caller intent belongs to the authenticated
    /// public Host gateway. Private peer channels reject this control.
    pub async fn confirm(&mut self) -> Result<Reply> {
        if !matches!(self.phase, Phase::Prepared)
            || self.connection.access() != Some(Access::Writable)
            || self.cancel_sent
            || self.recorded.is_some()
        {
            return Err("remote mutation is not awaiting Host confirmation".into());
        }
        self.phase = Phase::Dispatched;
        let Connection::Connected { channel, access } = &mut self.connection else {
            unreachable!("a prepared request retains its original channel")
        };
        *access = Access::SettlementOnly;
        wire::write(&mut channel.writer, &Control::Confirm).await?;
        *access = Access::Writable;
        self.receive().await
    }
    /// Drain cancellation on this same channel. A reply item or preparation is
    /// not terminal cleanup; retain it and await the original terminal reply.
    pub async fn close(&mut self) -> Result<()> {
        match self.drain().await? {
            Some(reply) => reply.cleanup().expect("terminal reply").clone(),
            None => Ok(()),
        }
    }
    pub async fn drain(&mut self) -> Result<Option<Reply>> {
        if matches!(self.phase, Phase::Closed) {
            return Ok(None);
        }
        match self.connection.access() {
            Some(Access::Writable) if matches!(self.phase, Phase::New(_) | Phase::Inert) => {
                self.phase = Phase::Inert;
                self.resources.clear();
                self.recorded.take();
                self.phase = Phase::Closed;
                return Ok(None);
            }
            Some(Access::Unconfirmed) | None => {
                return Err("remote cleanup remains unconfirmed".into());
            }
            _ => {}
        }
        let mut reply = if self.connection.access() == Some(Access::SettlementOnly) {
            self.read_settlement().await?
        } else {
            self.cancel().await?
        };
        loop {
            if reply.cleanup().is_some() {
                return Ok(Some(reply));
            }
            reply = if self.connection.access() == Some(Access::SettlementOnly) {
                self.read_settlement().await?
            } else {
                self.receive().await?
            };
        }
    }
    /// Cancel asks the same owner to settle. EOF/error retains unconfirmed custody.
    pub async fn cancel(&mut self) -> Result<Reply> {
        if !self.phase.receives() || self.connection.access() != Some(Access::Writable) {
            return Err("remote call cannot cancel in this phase".into());
        }
        if self.cancel_sent {
            return self.receive().await;
        }
        let Connection::Connected { channel, access } = &mut self.connection else {
            unreachable!("a cancellable request retains its original channel")
        };
        *access = Access::SettlementOnly;
        if wire::write(&mut channel.writer, &Control::Cancel)
            .await
            .is_err()
        {
            // The original Host may have already sent its terminal reply and
            // closed its reader. Delivery failure cannot erase that evidence.
            // Poison further writes, half-close and read only this same channel.
            return self.read_settlement().await;
        }
        *access = Access::Writable;
        self.cancel_sent = true;
        self.receive().await
    }
    async fn read_settlement(&mut self) -> Result<Reply> {
        let Connection::Connected {
            channel,
            access: Access::SettlementOnly,
        } = &mut self.connection
        else {
            return Err("remote cleanup remains unconfirmed".into());
        };
        let reply = tokio::select! {
            reply = channel.reader.read::<Reply>() => reply?,
            _ = channel.writer.shutdown() => channel.reader.read::<Reply>().await?,
        };
        if let Err(reason) = self.accept_reply(&reply) {
            self.connection.unconfirm();
            return Err(reason);
        }
        Ok(reply)
    }
    fn accept_reply(&mut self, reply: &Reply) -> Result<()> {
        match reply {
            Reply::BindingRetired { .. } => self.binding_retired = true,
            Reply::Subscribed if matches!(self.phase, Phase::Open) => self.phase = Phase::Streaming,
            Reply::Subscribed => return Err("unexpected subscription acceptance".into()),
            Reply::Item { .. } if !matches!(self.phase, Phase::Streaming) => {
                return Err("unexpected subscription item".into());
            }
            Reply::Finished { .. } if !matches!(self.phase, Phase::Open | Phase::Streaming) => {
                return Err("unexpected query completion".into());
            }
            Reply::Progress { .. } if !matches!(self.phase, Phase::Dispatched) => {
                return Err("unexpected mutation progress".into());
            }
            Reply::Mutation { .. } if !matches!(self.phase, Phase::Dispatched) => {
                return Err("unexpected mutation completion".into());
            }
            Reply::Prepared { reference } => {
                reference.validate().map_err(|e| e.to_string())?;
                if !matches!(self.phase, Phase::Open) || reference.operation != self.source.request
                {
                    self.connection.unconfirm();
                    return Err("remote preparation changed original operation".into());
                }
                self.reference = Some(*reference.clone());
                self.phase = Phase::Prepared;
            }
            Reply::Mutation { reply, .. } if self.reference.as_ref() != Some(&reply.reference) => {
                self.connection.unconfirm();
                return Err("remote completion changed original reference".into());
            }
            Reply::Ready => {
                self.connection.unconfirm();
                return Err("unexpected resource reservation reply".into());
            }
            _ => {}
        }
        if let Some(cleanup) = reply.cleanup() {
            if cleanup.is_ok() {
                self.recorded.take();
                self.resources.clear();
                self.phase = Phase::Closed;
            } else {
                self.connection.unconfirm();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        sync::{Arc, Mutex},
        task::{Context, Poll},
    };
    struct Partial {
        written: Arc<Mutex<Vec<u8>>>,
        released: Arc<std::sync::atomic::AtomicBool>,
    }
    impl AsyncWrite for Partial {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            let mut written = self.written.lock().unwrap();
            if !written.is_empty() {
                if !self.released.load(std::sync::atomic::Ordering::SeqCst) {
                    return Poll::Pending;
                }
                written.extend_from_slice(bytes);
                return Poll::Ready(Ok(bytes.len()));
            }
            written.extend_from_slice(&bytes[..2]);
            Poll::Ready(Ok(2))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }
    fn source() -> Source {
        Source {
            deployment: maka_plugin_core::deployment::DeploymentRef {
                state_domain: "root".into(),
                deployment: uuid::Uuid::new_v4(),
                revision: 1,
            },
            consumer: maka_plugin_core::composition::InstanceId(vec![uuid::Uuid::new_v4()]),
            mount: uuid::Uuid::new_v4(),
            request: uuid::Uuid::new_v4(),
        }
    }
    fn call<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
        reader: R,
        writer: W,
        source: Source,
    ) -> Call<R, W> {
        let endpoint = Selection {
            endpoint: "endpoint".into(),
            description: super::super::Description {
                provider: source.consumer.clone(),
                export: "Service".into(),
                registration_epoch: Some(uuid::Uuid::new_v4()),
                contract: maka_plugin_core::operation::receipt_reader_contract(),
            },
        };
        Call::new(
            reader,
            writer,
            endpoint,
            source,
            "method".into(),
            Value::Null,
            Attachments::new(),
        )
    }
    async fn replies(values: &[Reply]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for reply in values {
            wire::write(&mut bytes, reply).await.unwrap();
        }
        bytes
    }
    struct CallerFixture {
        _directory: tempfile::TempDir,
        log: maka_event_log::root_store::RootStore,
        source: Source,
        reference: RecoveryRef,
        recorded: RecordedIntent,
    }
    async fn caller_fixture() -> CallerFixture {
        use maka_event_log::root::{RootNamespaces, RootOwner};
        use maka_plugin_core::{
            composition::{Configuration, Input, InstanceId, Node, PackageUse},
            contract::Transport,
            operation::{RecoveryContract, RecoveryProtocol},
            package::{Declaration, EntryDeclaration, Implementation},
        };
        let directory = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let root =
            Arc::new(RootOwner::create(&directory.path().join("root"), &namespaces).unwrap());
        let log = maka_event_log::root_store::RootStore::open(root)
            .await
            .unwrap();
        let declaration = Declaration {
            host: Some(EntryDeclaration {
                implementation: Implementation::Native {
                    implementation: "test.caller".into(),
                },
                configuration: serde_json::json!({"type":"object"}).into(),
                imports: BTreeMap::new(),
                exports: BTreeMap::new(),
            }),
            ui: None,
            composition: None,
        };
        let package = maka_packages::Package::new(BTreeMap::from([(
            maka_packages::MANIFEST_FILE.into(),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion":1,"id":"caller","application":declaration
            }))
            .unwrap(),
        )]))
        .unwrap();
        let key = uuid::Uuid::new_v4();
        let caller = log
            .commit_application(
                uuid::Uuid::new_v4(),
                0,
                Input {
                    base: None,
                    ui: None,
                    instances: BTreeMap::from([(
                        "caller".into(),
                        Node {
                            key,
                            package: package.application_ref().into(),
                            use_package: PackageUse::Host,
                            configuration: Configuration::default(),
                            parameters: Configuration::default(),
                            bindings: BTreeMap::new(),
                            disabled: false,
                            overrides: vec![],
                        },
                    )]),
                },
                vec![],
                vec![package],
            )
            .await
            .unwrap();
        let consumer = InstanceId(vec![key]);
        let reference = RecoveryRef {
            source: caller.clone(),
            namespace: consumer.clone(),
            export: "Service".into(),
            method: "change".into(),
            operation: uuid::Uuid::new_v4(),
            fingerprint: format!("sha256-{}", "b".repeat(64)),
            contract: RecoveryContract {
                name: "test.Change".into(),
                version: 1,
                transport: Transport::Remote,
                digest: format!("sha256-{}", "c".repeat(64)),
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        let recorded = log
            .record_application_intent(
                caller.clone(),
                consumer.clone(),
                reference.clone(),
                Value::Null,
            )
            .await
            .unwrap();
        CallerFixture {
            _directory: directory,
            log,
            source: Source {
                deployment: caller,
                consumer,
                mount: uuid::Uuid::new_v4(),
                request: reference.operation,
            },
            reference,
            recorded,
        }
    }
    #[tokio::test]
    async fn dropping_a_partial_control_write_cannot_append_a_second_frame() {
        for control in ["pull", "cancel", "confirm"] {
            let written = Arc::new(Mutex::new(Vec::new()));
            let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let replies = replies(&[Reply::Aborted {
                reason: "original request cancelled".into(),
                cleanup: Ok(()),
            }])
            .await;
            let mut call = call(
                replies.as_slice(),
                Partial {
                    written: written.clone(),
                    released: released.clone(),
                },
                source(),
            );
            call.phase = if control == "pull" {
                Phase::Streaming
            } else {
                Phase::Prepared
            };
            assert_eq!(call.awaiting_confirmation(), control != "pull");
            if control == "pull" {
                let mut future = Box::pin(call.pull());
                assert!(futures_util::poll!(&mut future).is_pending());
                drop(future);
            } else if control == "confirm" {
                let mut future = Box::pin(call.confirm());
                assert!(futures_util::poll!(&mut future).is_pending());
                drop(future);
            } else {
                let mut future = Box::pin(call.cancel());
                assert!(futures_util::poll!(&mut future).is_pending());
                drop(future);
            }
            assert_eq!(written.lock().unwrap().len(), 2);
            assert!(!call.awaiting_confirmation());
            released.store(true, std::sync::atomic::Ordering::SeqCst);
            assert!(call.cancel().await.is_err());
            assert!(call.receive().await.is_err());
            assert_eq!(written.lock().unwrap().len(), 2);
            assert!(!call.cleanup_confirmed());
            assert!(matches!(
                call.drain().await.unwrap(),
                Some(Reply::Aborted { .. })
            ));
            assert!(call.cleanup_confirmed());
            assert_eq!(written.lock().unwrap().len(), 2);
        }
    }

    #[tokio::test]
    async fn only_a_pre_wire_opening_can_confirm_cleanup_without_a_reply() {
        for partial in [false, true] {
            let written = Arc::new(Mutex::new(Vec::new()));
            let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut call = call(
                tokio::io::empty(),
                Partial {
                    written: written.clone(),
                    released: released.clone(),
                },
                source(),
            );
            if partial {
                let mut opening = Box::pin(call.start());
                assert!(futures_util::poll!(&mut opening).is_pending());
                drop(opening);
                released.store(true, std::sync::atomic::Ordering::SeqCst);
                assert!(call.close().await.is_err());
                assert!(!call.cleanup_confirmed());
                assert_eq!(written.lock().unwrap().len(), 2);
            } else {
                assert!(call.start_unless(|| true).await.is_err());
                assert!(call.start().await.is_err());
                call.close().await.unwrap();
                assert!(call.cleanup_confirmed());
                assert!(written.lock().unwrap().is_empty());
            }
        }
    }

    #[tokio::test]
    async fn a_failed_cancel_write_preserves_the_original_terminal_reply() {
        for confirmed in [false, true] {
            let (client, mut server) = tokio::io::duplex(4096);
            let (reader, writer) = tokio::io::split(client);
            let mut call = call(reader, writer, source());
            let cleanup = if confirmed {
                Ok(())
            } else {
                Err("original cleanup is unknown".into())
            };
            let terminal = Reply::Finished {
                result: Ok(serde_json::json!(42)),
                cleanup: cleanup.clone(),
            };
            let peer = async move {
                let mut input = Reader::new(&mut server);
                let _: Open = input.read().await.unwrap();
                let _: BTreeMap<String, ResourceDescriptor> = input.read().await.unwrap();
                drop(input);
                wire::write(&mut server, &Reply::Ready).await.unwrap();
                wire::write(&mut server, &terminal).await.unwrap();
            };
            let (started, ()) = tokio::join!(call.start(), peer);
            started.unwrap();
            match call.cancel().await.unwrap() {
                Reply::Finished {
                    result,
                    cleanup: actual,
                } => {
                    assert_eq!(result.unwrap(), serde_json::json!(42));
                    assert_eq!(actual, cleanup);
                }
                other => panic!("original terminal reply was lost: {other:?}"),
            }
            assert_eq!(call.cleanup_confirmed(), confirmed);
        }
    }

    #[tokio::test]
    async fn caller_custody_survives_unpolled_partial_and_rejected_commits() {
        for mode in ["unpolled", "partial", "wrong_phase", "disconnected"] {
            let CallerFixture {
                _directory,
                log,
                source,
                reference,
                recorded,
            } = caller_fixture().await;
            let replies = replies(&[
                Reply::Ready,
                Reply::Prepared {
                    reference: Box::new(reference),
                },
                Reply::Aborted {
                    reason: "original request cancelled".into(),
                    cleanup: Ok(()),
                },
            ])
            .await;
            let written = Arc::new(Mutex::new(Vec::new()));
            let released = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let mut call = call(
                replies.as_slice(),
                Partial {
                    written: written.clone(),
                    released: released.clone(),
                },
                source,
            );
            call.start().await.unwrap();
            if mode != "wrong_phase" {
                assert!(matches!(
                    call.receive().await.unwrap(),
                    Reply::Prepared { .. }
                ));
                assert!(call.awaiting_confirmation());
            }
            if mode == "disconnected" {
                call.disconnect();
            }
            if mode == "partial" {
                written.lock().unwrap().clear();
                released.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            let before = written.lock().unwrap().len();
            let committing = call.commit(recorded);
            if mode == "unpolled" {
                drop(committing);
            } else if mode == "partial" {
                let mut committing = Box::pin(committing);
                assert!(futures_util::poll!(&mut committing).is_pending());
                drop(committing);
            } else {
                assert!(committing.await.is_err());
            }
            assert!(call.holds_caller_intent());
            assert!(!call.awaiting_confirmation());
            assert_eq!(
                written.lock().unwrap().len(),
                if mode == "partial" { 2 } else { before }
            );
            if mode == "partial" {
                released.store(true, std::sync::atomic::Ordering::SeqCst);
                assert!(call.cancel().await.is_err());
                assert!(call.receive().await.is_err());
            }
            if mode == "wrong_phase" || mode == "partial" {
                call.close().await.unwrap();
                assert!(!call.holds_caller_intent());
                assert!(call.cleanup_confirmed());
                if mode == "partial" {
                    assert_eq!(written.lock().unwrap().len(), 2);
                }
            } else {
                call.disconnect();
                assert!(call.close().await.is_err());
                assert!(call.holds_caller_intent());
                assert!(!call.cleanup_confirmed());
            }
            drop(call);
            log.close().await.unwrap();
        }
    }
}
