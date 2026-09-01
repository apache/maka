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

use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::Duration,
};

use bytes::BytesMut;
use futures::{
    AsyncRead, AsyncWrite, FutureExt, Sink, SinkExt as _, Stream, StreamExt as _,
    channel::{mpsc, oneshot},
    future::BoxFuture,
    ready,
    stream::FuturesUnordered,
};
use libp2p::core::muxing::{StreamMuxer, StreamMuxerEvent};
use libp2p_webrtc_utils::{DropListener, Stream as Libp2pWebRtcStream};
use tokio::sync::OwnedSemaphorePermit;
use webrtc::{
    data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState},
    peer_connection::{PeerConnection, RTCPeerConnectionState},
};

const DATA_CHANNEL_QUEUE_CAPACITY: usize = 16;
const MAX_DATA_CHANNEL_MESSAGE_BYTES: usize = 16 * 1024;

pub(crate) type ReadySubstream = (WebRtcSubstream, DropListener<MessageIo>);

pub struct WebRtcConnection {
    peer_connection: Arc<dyn PeerConnection>,
    incoming: mpsc::Receiver<Result<ReadySubstream, io::Error>>,
    states: mpsc::Receiver<RTCPeerConnectionState>,
    outbound: Option<BoxFuture<'static, Result<ReadySubstream, io::Error>>>,
    closing: Option<BoxFuture<'static, Result<(), io::Error>>>,
    drop_listeners: FuturesUnordered<DropListener<MessageIo>>,
    no_drop_listener_waker: Option<Waker>,
}

impl WebRtcConnection {
    pub(crate) fn new(
        peer_connection: Arc<dyn PeerConnection>,
        incoming: mpsc::Receiver<Result<ReadySubstream, io::Error>>,
        states: mpsc::Receiver<RTCPeerConnectionState>,
    ) -> Self {
        Self {
            peer_connection,
            incoming,
            states,
            outbound: None,
            closing: None,
            drop_listeners: FuturesUnordered::new(),
            no_drop_listener_waker: None,
        }
    }

    fn track_substream(&mut self, (stream, listener): ReadySubstream) -> WebRtcSubstream {
        self.drop_listeners.push(listener);
        if let Some(waker) = self.no_drop_listener_waker.take() {
            waker.wake();
        }
        stream
    }

    pub(crate) fn close_in_background(self) {
        let peer_connection = Arc::clone(&self.peer_connection);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = peer_connection.close().await;
            });
        }
    }
}

impl StreamMuxer for WebRtcConnection {
    type Substream = WebRtcSubstream;
    type Error = io::Error;

    fn poll_inbound(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Self::Substream, Self::Error>> {
        match ready!(self.incoming.poll_next_unpin(cx)) {
            Some(Ok(stream)) => Poll::Ready(Ok(self.track_substream(stream))),
            Some(Err(error)) => Poll::Ready(Err(error)),
            None => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "WebRTC inbound stream channel closed",
            ))),
        }
    }

    fn poll_outbound(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<Self::Substream, Self::Error>> {
        let peer_connection = Arc::clone(&self.peer_connection);
        let future = self.outbound.get_or_insert_with(|| {
            async move {
                let channel = peer_connection
                    .create_data_channel("", None)
                    .await
                    .map_err(webrtc_io_error)?;
                data_channel_diagnostic("created", channel.id(), Some("outbound"));
                ready_substream(channel, "outbound", None).await
            }
            .boxed()
        });
        match ready!(future.poll_unpin(cx)) {
            Ok(stream) => {
                self.outbound = None;
                Poll::Ready(Ok(self.track_substream(stream)))
            }
            Err(error) => {
                self.outbound = None;
                Poll::Ready(Err(error))
            }
        }
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let peer_connection = Arc::clone(&self.peer_connection);
        let future = self.closing.get_or_insert_with(|| {
            async move { peer_connection.close().await.map_err(webrtc_io_error) }.boxed()
        });
        future.poll_unpin(cx)
    }

    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<StreamMuxerEvent, Self::Error>> {
        loop {
            match self.states.poll_next_unpin(cx) {
                Poll::Ready(Some(RTCPeerConnectionState::Failed))
                | Poll::Ready(Some(RTCPeerConnectionState::Closed)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "WebRTC peer connection closed",
                    )));
                }
                Poll::Ready(Some(_)) => continue,
                Poll::Ready(None) | Poll::Pending => break,
            }
        }

        loop {
            match self.drop_listeners.poll_next_unpin(cx) {
                Poll::Ready(Some(Ok(()))) => continue,
                Poll::Ready(Some(Err(error))) => {
                    muxer_diagnostic("substream-reset-failed", Some(&error.to_string()));
                    continue;
                }
                Poll::Ready(None) => {
                    self.no_drop_listener_waker = Some(cx.waker().clone());
                    return Poll::Pending;
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

pub struct WebRtcSubstream {
    inner: Libp2pWebRtcStream<MessageIo>,
    _inbound_permit: Option<OwnedSemaphorePermit>,
}

impl AsyncRead for WebRtcSubstream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_read(cx, buffer)
    }
}

impl AsyncWrite for WebRtcSubstream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_close(cx)
    }
}

pub(crate) async fn ready_substream(
    data_channel: Arc<dyn DataChannel>,
    origin: &'static str,
    inbound_permit: Option<OwnedSemaphorePermit>,
) -> Result<ReadySubstream, io::Error> {
    let (outgoing, outgoing_receiver) = mpsc::channel(DATA_CHANNEL_QUEUE_CAPACITY);
    let (incoming_sender, incoming) = mpsc::channel(DATA_CHANNEL_QUEUE_CAPACITY);
    let io = MessageIo::new(outgoing, incoming);
    let (ready_sender, ready_receiver) = oneshot::channel();
    tokio::spawn(drive_data_channel(
        data_channel,
        outgoing_receiver,
        incoming_sender,
        ready_sender,
        origin,
    ));
    ready_receiver
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::ConnectionAborted, "data channel stopped"))??;
    let (stream, listener) = Libp2pWebRtcStream::new(io);
    Ok((
        WebRtcSubstream {
            inner: stream,
            _inbound_permit: inbound_permit,
        },
        listener,
    ))
}

pub(crate) fn keep_init_channel(
    data_channel: Arc<dyn DataChannel>,
    mut opened: mpsc::Sender<Result<(), io::Error>>,
) {
    tokio::spawn(async move {
        data_channel_diagnostic("waiting", data_channel.id(), Some("init"));
        let result = wait_for_data_channel_open(&data_channel).await;
        let is_open = result.is_ok();
        data_channel_diagnostic(
            if is_open { "opened" } else { "open-failed" },
            data_channel.id(),
            Some("init"),
        );
        let _ = opened.try_send(result);
        if is_open {
            // Keep the initial channel allocated for the connection lifetime. Closing it lets
            // current native WebRTC stacks reuse its SCTP stream id before both peers have
            // retired it, causing the first real libp2p substream to fail immediately.
            while data_channel.poll().await.is_some() {}
        }
    });
}

async fn drive_data_channel(
    data_channel: Arc<dyn DataChannel>,
    mut outgoing: mpsc::Receiver<BytesMut>,
    mut incoming: mpsc::Sender<Result<BytesMut, io::Error>>,
    ready: oneshot::Sender<Result<(), io::Error>>,
    origin: &'static str,
) {
    data_channel_diagnostic("waiting", data_channel.id(), Some(origin));
    if let Err(error) = wait_for_data_channel_open(&data_channel).await {
        data_channel_diagnostic("open-failed", data_channel.id(), Some(origin));
        let _ = ready.send(Err(error));
        return;
    }
    data_channel_diagnostic("opened", data_channel.id(), Some(origin));
    let _ = ready.send(Ok(()));

    let mut pending_incoming = None;
    loop {
        if pending_incoming.is_some() {
            tokio::select! {
                ready = futures::future::poll_fn(|context| {
                    Pin::new(&mut incoming).poll_ready(context)
                }) => {
                    if ready.is_err() {
                        let _ = data_channel.close().await;
                        return;
                    }
                    let message = pending_incoming.take().expect("pending message exists");
                    if Pin::new(&mut incoming).start_send(Ok(message)).is_err() {
                        let _ = data_channel.close().await;
                        return;
                    }
                }
                message = outgoing.next() => {
                    if !send_outgoing_message(&data_channel, message).await {
                        return;
                    }
                }
            }
            continue;
        }
        tokio::select! {
            event = data_channel.poll() => {
                match event {
                    Some(DataChannelEvent::OnMessage(message)) => {
                        data_channel_diagnostic(
                            "received",
                            data_channel.id(),
                            Some(&message.data.len().to_string()),
                        );
                        pending_incoming = Some(message.data);
                    }
                    Some(DataChannelEvent::OnClose) => {
                        data_channel_diagnostic("closed", data_channel.id(), Some(origin));
                        return;
                    }
                    Some(DataChannelEvent::OnError) => {
                        data_channel_diagnostic("error", data_channel.id(), Some(origin));
                        send_channel_reset(&mut incoming, "WebRTC data channel failed").await;
                        return;
                    }
                    None => {
                        data_channel_diagnostic("stopped", data_channel.id(), Some(origin));
                        send_channel_reset(&mut incoming, "WebRTC data channel stopped").await;
                        return;
                    }
                    _ => {}
                }
            }
            message = outgoing.next() => {
                if !send_outgoing_message(&data_channel, message).await {
                    return;
                }
            }
        }
    }
}

async fn send_outgoing_message(
    data_channel: &Arc<dyn DataChannel>,
    message: Option<BytesMut>,
) -> bool {
    let Some(message) = message else {
        drain_data_channel(data_channel).await;
        let _ = data_channel.close().await;
        return false;
    };
    let message_bytes = message.len().to_string();
    if message.len() > MAX_DATA_CHANNEL_MESSAGE_BYTES || data_channel.send(message).await.is_err() {
        let _ = data_channel.close().await;
        return false;
    }
    data_channel_diagnostic("sent", data_channel.id(), Some(&message_bytes));
    true
}

async fn send_channel_reset(
    incoming: &mut mpsc::Sender<Result<BytesMut, io::Error>>,
    message: &'static str,
) {
    let _ = incoming
        .send(Err(io::Error::new(io::ErrorKind::ConnectionReset, message)))
        .await;
}

async fn drain_data_channel(data_channel: &Arc<dyn DataChannel>) {
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match data_channel.outstanding_bytes().await {
                Ok(0) | Err(_) => return,
                Ok(_) => tokio::time::sleep(Duration::from_millis(1)).await,
            }
        }
    })
    .await;
}

async fn wait_for_data_channel_open(data_channel: &Arc<dyn DataChannel>) -> Result<(), io::Error> {
    match data_channel.ready_state().await.map_err(webrtc_io_error)? {
        RTCDataChannelState::Open => return Ok(()),
        RTCDataChannelState::Closing | RTCDataChannelState::Closed => {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "data channel closed before opening",
            ));
        }
        RTCDataChannelState::Unspecified | RTCDataChannelState::Connecting => {}
        _ => {}
    }

    while let Some(event) = data_channel.poll().await {
        match event {
            DataChannelEvent::OnOpen => return Ok(()),
            DataChannelEvent::OnClose | DataChannelEvent::OnError => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "data channel failed to open",
                ));
            }
            _ => {}
        }
    }
    Err(io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "data channel stopped before opening",
    ))
}

#[derive(Clone)]
pub(crate) struct MessageIo {
    inner: Arc<Mutex<MessageIoInner>>,
}

struct MessageIoInner {
    outgoing: mpsc::Sender<BytesMut>,
    incoming: mpsc::Receiver<Result<BytesMut, io::Error>>,
    read_buffer: BytesMut,
}

impl MessageIo {
    fn new(
        outgoing: mpsc::Sender<BytesMut>,
        incoming: mpsc::Receiver<Result<BytesMut, io::Error>>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MessageIoInner {
                outgoing,
                incoming,
                read_buffer: BytesMut::new(),
            })),
        }
    }
}

impl AsyncRead for MessageIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let mut inner = self.inner.lock().expect("message I/O mutex poisoned");
        if inner.read_buffer.is_empty() {
            match ready!(Pin::new(&mut inner.incoming).poll_next(cx)) {
                Some(Ok(message)) => inner.read_buffer = message,
                Some(Err(error)) => return Poll::Ready(Err(error)),
                None => return Poll::Ready(Ok(0)),
            }
        }
        let length = buffer.len().min(inner.read_buffer.len());
        buffer[..length].copy_from_slice(&inner.read_buffer.split_to(length));
        Poll::Ready(Ok(length))
    }
}

impl AsyncWrite for MessageIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buffer.len() > MAX_DATA_CHANNEL_MESSAGE_BYTES {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "data channel message exceeds the 16 KiB libp2p limit",
            )));
        }
        let mut inner = self.inner.lock().expect("message I/O mutex poisoned");
        ready!(Pin::new(&mut inner.outgoing).poll_ready(cx))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "data channel closed"))?;
        Pin::new(&mut inner.outgoing)
            .start_send(BytesMut::from(buffer))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "data channel closed"))?;
        Poll::Ready(Ok(buffer.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut inner = self.inner.lock().expect("message I/O mutex poisoned");
        Pin::new(&mut inner.outgoing)
            .poll_flush(cx)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "data channel closed"))
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let mut inner = self.inner.lock().expect("message I/O mutex poisoned");
        Pin::new(&mut inner.outgoing)
            .poll_close(cx)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "data channel closed"))
    }
}

fn webrtc_io_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

pub(crate) fn data_channel_diagnostic(event: &str, channel: usize, detail: Option<&str>) {
    if std::env::var_os("MAKA_WEBRTC_DIAGNOSTICS").is_none() {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "dataChannel": event,
            "channel": channel,
            "detail": detail,
        })
    );
}

fn muxer_diagnostic(event: &str, detail: Option<&str>) {
    if std::env::var_os("MAKA_WEBRTC_DIAGNOSTICS").is_none() {
        return;
    }
    eprintln!(
        "{}",
        serde_json::json!({
            "webRtcMuxer": event,
            "detail": detail,
        })
    );
}
