// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

use super::sdk_error;
use agent_client_protocol::{
    self as sdk, Responder,
    schema::{ProtocolVersion, v1, v2},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::mpsc;

pub(super) async fn connect<C: sdk::ConnectTo<sdk::Client>>(
    send: mpsc::Sender<Event>,
    files: bool,
    mut transport: impl FnMut() -> C + Clone + Send + 'static,
) -> sdk::Result<()> {
    let retry = Arc::new(AtomicBool::new(false));
    let result = sdk::Client
        .protocol_connector()
        .with_v1({
            let send = send.clone();
            move || v1(send.clone(), files)
        })
        .with_v2({
            let send = send.clone();
            let retry = retry.clone();
            move || v2(send.clone(), retry.clone())
        })
        .connect_to(transport.clone())
        .await;
    if result.is_err() && retry.load(Ordering::Acquire) {
        // Some legacy peers echo version 2 with a v1 response envelope. The
        // failed typed initialize authorizes one fresh, native v1 attempt only.
        // No response is rewritten and no business request has been sent.
        return sdk::ConnectTo::<sdk::Client>::connect_to(transport(), v1(send, files)).await;
    }
    result
}

pub(crate) enum Peer {
    V1(sdk::ConnectionTo<sdk::Agent>, v1::InitializeResponse),
    V2(sdk::V2ConnectionTo<sdk::Agent>, v2::InitializeResponse),
}

pub(crate) enum Event {
    Initialized(Box<Peer>),
    V1Update(Box<v1::SessionNotification>),
    V2Update(Box<v2::UpdateSessionNotification>),
    Read(
        Box<v1::ReadTextFileRequest>,
        Responder<v1::ReadTextFileResponse>,
    ),
    Write(
        Box<v1::WriteTextFileRequest>,
        Responder<v1::WriteTextFileResponse>,
    ),
    V1Permission(
        Box<v1::RequestPermissionRequest>,
        Responder<v1::RequestPermissionResponse>,
    ),
    V2Permission(
        Box<v2::RequestPermissionRequest>,
        Responder<v2::RequestPermissionResponse>,
    ),
    Stderr(Vec<u8>),
}

impl Event {
    pub fn is_callback(&self) -> bool {
        matches!(
            self,
            Self::Read(..) | Self::Write(..) | Self::V1Permission(..) | Self::V2Permission(..)
        )
    }

    pub fn reject_busy(self) -> sdk::Result<()> {
        self.reject_with(sdk::Error::new(
            -32000,
            "Another ACP client callback is pending",
        ))
    }

    pub fn reject(self) -> sdk::Result<()> {
        let error = sdk::Error::method_not_found().data("Client callback unavailable during setup");
        self.reject_with(error)
    }

    fn reject_with(self, error: sdk::Error) -> sdk::Result<()> {
        match self {
            Self::Read(_, reply) => reply.respond_with_error(error),
            Self::Write(_, reply) => reply.respond_with_error(error),
            Self::V1Permission(_, reply) => reply.respond_with_error(error),
            Self::V2Permission(_, reply) => reply.respond_with_error(error),
            _ => Ok(()),
        }
    }
}

pub(super) fn v1(send: mpsc::Sender<Event>, files: bool) -> impl sdk::ConnectTo<sdk::Agent> {
    let (updates, reads, writes, permissions) =
        (send.clone(), send.clone(), send.clone(), send.clone());
    sdk::Client
        .builder()
        .name("maka-external-v1")
        .on_receive_notification(
            async move |input: v1::SessionNotification, _| {
                updates
                    .send(Event::V1Update(Box::new(input)))
                    .await
                    .map_err(sdk_error)
            },
            sdk::on_receive_notification!(),
        )
        .on_receive_request(
            async move |input: v1::ReadTextFileRequest, reply, _| {
                reads
                    .send(Event::Read(Box::new(input), reply))
                    .await
                    .map_err(sdk_error)
            },
            sdk::on_receive_request!(),
        )
        .on_receive_request(
            async move |input: v1::WriteTextFileRequest, reply, _| {
                writes
                    .send(Event::Write(Box::new(input), reply))
                    .await
                    .map_err(sdk_error)
            },
            sdk::on_receive_request!(),
        )
        .on_receive_request(
            async move |input: v1::RequestPermissionRequest, reply, _| {
                permissions
                    .send(Event::V1Permission(Box::new(input), reply))
                    .await
                    .map_err(sdk_error)
            },
            sdk::on_receive_request!(),
        )
        .with_spawned(async move |peer| {
            let initialized = peer
                .send_request(
                    v1::InitializeRequest::new(ProtocolVersion::V1)
                        .client_info(v1::Implementation::new("maka", env!("CARGO_PKG_VERSION")))
                        .client_capabilities(
                            v1::ClientCapabilities::new().fs(v1::FileSystemCapabilities::new()
                                .read_text_file(files)
                                .write_text_file(files)),
                        ),
                )
                .block_task()
                .await?;
            if initialized.protocol_version != ProtocolVersion::V1 {
                return Err(sdk_error("unsupported negotiated ACP version"));
            }
            send.send(Event::Initialized(Box::new(Peer::V1(peer, initialized))))
                .await
                .map_err(sdk_error)?;
            std::future::pending::<sdk::Result<()>>().await
        })
}

pub(super) fn v2(
    send: mpsc::Sender<Event>,
    retry: Arc<AtomicBool>,
) -> impl sdk::ConnectTo<sdk::Agent> {
    let (updates, permissions) = (send.clone(), send.clone());
    sdk::Client
        .v2()
        .name("maka-external-v2")
        .on_receive_notification(
            async move |input: v2::UpdateSessionNotification, _| {
                updates
                    .send(Event::V2Update(Box::new(input)))
                    .await
                    .map_err(sdk_error)
            },
            sdk::on_receive_notification!(),
        )
        .on_receive_request(
            async move |input: v2::RequestPermissionRequest, reply, _| {
                permissions
                    .send(Event::V2Permission(Box::new(input), reply))
                    .await
                    .map_err(sdk_error)
            },
            sdk::on_receive_request!(),
        )
        .with_spawned(async move |peer| {
            let initialized = peer
                .send_request(v2::InitializeRequest::new(
                    ProtocolVersion::V2,
                    v2::Implementation::new("maka", env!("CARGO_PKG_VERSION")),
                ))
                .block_task()
                .await;
            let initialized = initialized.inspect_err(|error| {
                retry.store(error.code == sdk::ErrorCode::ParseError, Ordering::Release);
            })?;
            send.send(Event::Initialized(Box::new(Peer::V2(peer, initialized))))
                .await
                .map_err(sdk_error)?;
            std::future::pending::<sdk::Result<()>>().await
        })
}
