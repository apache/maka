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
    channel: Option<Channel<R, W>>,
    open: Option<Open>,
    source: Source,
    resources: Attachments,
    reference: Option<RecoveryRef>,
    recorded: Option<RecordedIntent>,
    phase: Phase,
    cancel_sent: bool,
    settlement_phase: Option<Phase>,
    binding_retired: bool,
}
struct Channel<R, W> {
    reader: Reader<R>,
    writer: W,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    New,
    Open,
    Streaming,
    Prepared,
    Dispatched,
    Closed,
    Lost,
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
            channel: Some(Channel {
                reader: Reader::new(reader),
                writer,
            }),
            open: Some(open),
            source,
            resources,
            reference: None,
            recorded: None,
            phase: Phase::New,
            cancel_sent: false,
            settlement_phase: None,
            binding_retired: false,
        }
    }
    pub fn reference(&self) -> Option<&RecoveryRef> {
        self.reference.as_ref()
    }
    pub fn cleanup_confirmed(&self) -> bool {
        self.phase == Phase::Closed
    }
    pub fn holds_caller_intent(&self) -> bool {
        self.recorded.is_some()
    }
    pub fn binding_retired(&self) -> bool {
        self.binding_retired
    }
    /// The original physical call has not begun a confirmation or transferred caller custody.
    pub fn awaiting_confirmation(&self) -> bool {
        self.phase == Phase::Prepared && self.recorded.is_none() && self.settlement_phase.is_none()
    }
    /// Disconnects only the physical channel, retaining this invocation's
    /// unconfirmed token and immutable inputs. Remote EOF requests cancellation;
    /// it is not an acknowledgement of remote execution cleanup.
    pub fn disconnect(&mut self) {
        if self.phase != Phase::Closed {
            self.phase = Phase::Lost;
            self.settlement_phase = None;
        }
        if let Some(Channel { reader, writer }) = self.channel.take() {
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
        if self.phase != Phase::New {
            return Err("remote call is not new".into());
        }
        let open = self.open.take().ok_or("remote opening already observed")?;
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
        self.phase = Phase::Lost;
        let channel = self.channel.as_mut().expect("new channel");
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
        let channel = self.channel.as_mut().expect("open channel");
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
        self.phase = Phase::Open;
        Ok(())
    }
    /// Query completion or original mutation preparation. This is an observer;
    /// dropping its future does not establish cleanup or permit request replay.
    pub async fn receive(&mut self) -> Result<Reply> {
        if self.phase == Phase::New || self.phase == Phase::Closed || self.phase == Phase::Lost {
            return Err("remote call cannot receive in this phase".into());
        }
        let channel = self.channel.as_mut().expect("active channel");
        let reply = match channel.reader.read::<Reply>().await {
            Ok(reply) => reply,
            Err(e) => {
                self.phase = Phase::Lost;
                return Err(e);
            }
        };
        if let Err(e) = self.accept_reply(&reply) {
            self.phase = Phase::Lost;
            return Err(e);
        }
        Ok(reply)
    }
    /// One demand successor; no background socket reader prefetches items.
    pub async fn pull(&mut self) -> Result<Reply> {
        if self.phase != Phase::Streaming || self.cancel_sent {
            return Err("remote call cannot pull in this phase".into());
        }
        self.phase = Phase::Lost;
        self.settlement_phase = Some(Phase::Streaming);
        let channel = self.channel.as_mut().expect("streaming channel");
        if let Err(e) = wire::write(&mut channel.writer, &Control::Pull).await {
            self.phase = Phase::Lost;
            return Err(e);
        }
        self.phase = Phase::Streaming;
        self.settlement_phase = None;
        self.receive().await
    }
    /// Transfers real caller custody synchronously, before the dispatch observer
    /// is first polled. Dropping that observer cannot drop the confirmed token.
    pub fn commit(&mut self, recorded: RecordedIntent) -> impl Future<Output = Result<Reply>> + '_ {
        let validation = if self.phase == Phase::Closed || self.recorded.is_some() {
            Err("remote mutation is not awaiting caller confirmation".to_string())
        } else {
            // A concurrent close can lose this channel before an already
            // confirmed dispatch observer is polled. Rejection must retain its
            // real token until original cleanup, even when no write is allowed.
            self.recorded = Some(recorded);
            let intent = self.recorded.as_ref().unwrap().intent();
            if self.phase != Phase::Prepared
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
            self.phase = Phase::Lost;
            self.settlement_phase = Some(Phase::Dispatched);
            let channel = self.channel.as_mut().expect("prepared channel");
            wire::write(&mut channel.writer, &control).await?;
            self.phase = Phase::Dispatched;
            self.settlement_phase = None;
            self.receive().await
        }
    }
    /// Confirm a mutation whose caller intent belongs to the authenticated
    /// public Host gateway. Private peer channels reject this control.
    pub async fn confirm(&mut self) -> Result<Reply> {
        if self.phase != Phase::Prepared || self.cancel_sent || self.recorded.is_some() {
            return Err("remote mutation is not awaiting Host confirmation".into());
        }
        self.phase = Phase::Lost;
        self.settlement_phase = Some(Phase::Dispatched);
        let channel = self.channel.as_mut().expect("prepared channel");
        wire::write(&mut channel.writer, &Control::Confirm).await?;
        self.phase = Phase::Dispatched;
        self.settlement_phase = None;
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
        match self.phase {
            Phase::Closed => return Ok(None),
            Phase::New => {
                self.open.take();
                self.resources.clear();
                self.recorded.take();
                self.phase = Phase::Closed;
                return Ok(None);
            }
            Phase::Lost if self.settlement_phase.is_none() => {
                return Err("remote cleanup remains unconfirmed".into());
            }
            _ => {}
        }
        let mut reply = if self.phase == Phase::Lost {
            self.read_settlement().await?
        } else {
            self.cancel().await?
        };
        loop {
            if reply.cleanup().is_some() {
                return Ok(Some(reply));
            }
            reply = if self.phase == Phase::Lost {
                self.read_settlement().await?
            } else {
                self.receive().await?
            };
        }
    }
    /// Cancel asks the same owner to settle. EOF/error retains unconfirmed custody.
    pub async fn cancel(&mut self) -> Result<Reply> {
        if matches!(self.phase, Phase::New | Phase::Closed | Phase::Lost) {
            return Err("remote call cannot cancel in this phase".into());
        }
        if self.cancel_sent {
            return self.receive().await;
        }
        let phase = std::mem::replace(&mut self.phase, Phase::Lost);
        self.settlement_phase = Some(phase);
        let channel = self.channel.as_mut().expect("active channel");
        if wire::write(&mut channel.writer, &Control::Cancel)
            .await
            .is_err()
        {
            // The original Host may have already sent its terminal reply and
            // closed its reader. Delivery failure cannot erase that evidence.
            // Poison further writes, half-close and read only this same channel.
            return self.read_settlement().await;
        }
        self.phase = phase;
        self.settlement_phase = None;
        self.cancel_sent = true;
        self.receive().await
    }
    async fn read_settlement(&mut self) -> Result<Reply> {
        let expected = self
            .settlement_phase
            .ok_or("remote cleanup remains unconfirmed")?;
        let channel = self
            .channel
            .as_mut()
            .ok_or("original physical channel is gone")?;
        let reply = tokio::select! {
            reply = channel.reader.read::<Reply>() => reply?,
            _ = channel.writer.shutdown() => channel.reader.read::<Reply>().await?,
        };
        self.phase = expected;
        if let Err(reason) = self.accept_reply(&reply) {
            self.phase = Phase::Lost;
            self.settlement_phase = None;
            return Err(reason);
        }
        if reply.cleanup().is_some() {
            self.settlement_phase = None;
        } else {
            self.settlement_phase = Some(self.phase);
            self.phase = Phase::Lost;
        }
        Ok(reply)
    }
    fn accept_reply(&mut self, reply: &Reply) -> Result<()> {
        match reply {
            Reply::BindingRetired { .. } => self.binding_retired = true,
            Reply::Subscribed if self.phase == Phase::Open => self.phase = Phase::Streaming,
            Reply::Subscribed => return Err("unexpected subscription acceptance".into()),
            Reply::Item { .. } if self.phase != Phase::Streaming => {
                return Err("unexpected subscription item".into());
            }
            Reply::Finished { .. } if !matches!(self.phase, Phase::Open | Phase::Streaming) => {
                return Err("unexpected query completion".into());
            }
            Reply::Progress { .. } if self.phase != Phase::Dispatched => {
                return Err("unexpected mutation progress".into());
            }
            Reply::Mutation { .. } if self.phase != Phase::Dispatched => {
                return Err("unexpected mutation completion".into());
            }
            Reply::Prepared { reference } => {
                reference.validate().map_err(|e| e.to_string())?;
                if self.phase != Phase::Open || reference.operation != self.source.request {
                    self.phase = Phase::Lost;
                    return Err("remote preparation changed original operation".into());
                }
                self.reference = Some(*reference.clone());
                self.phase = Phase::Prepared;
            }
            Reply::Mutation { reply, .. } if self.reference.as_ref() != Some(&reply.reference) => {
                self.phase = Phase::Lost;
                return Err("remote completion changed original reference".into());
            }
            Reply::Ready => {
                self.phase = Phase::Lost;
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
                self.phase = Phase::Lost;
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
    #[tokio::test]
    async fn dropping_a_partial_control_write_cannot_append_a_second_frame() {
        for control in ["pull", "cancel", "confirm"] {
            let written = Arc::new(Mutex::new(Vec::new()));
            let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut call = Call::new(
                tokio::io::empty(),
                Partial {
                    written: written.clone(),
                    released: released.clone(),
                },
                Selection {
                    endpoint: "endpoint".into(),
                    description: super::super::Description {
                        provider: source().consumer,
                        export: "Service".into(),
                        registration_epoch: Some(uuid::Uuid::new_v4()),
                        contract: maka_plugin_core::operation::receipt_reader_contract(),
                    },
                },
                source(),
                "method".into(),
                Value::Null,
                Attachments::new(),
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
        }
    }
}
