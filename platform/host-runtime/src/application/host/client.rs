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

//! Public application caller: an anchored authenticated session, no legacy operations.
use super::{
    Configuration, Publication, Status, VERSION,
    protocol::{Connected, Opening, Request, Response, SessionControl},
};
use crate::{
    application::{
        Result,
        transport::{Call, Catalogue, HostEndpoint, Peer, Source, wire},
    },
    ipc::{self, LocalStream},
};
use maka_capabilities::call::Attachments;
use maka_plugin_core::{composition::InstanceId, deployment::DeploymentRef};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use tokio::io::{AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use uuid::Uuid;

pub type LocalCall = Call<ReadHalf<BufReader<LocalStream>>, WriteHalf<BufReader<LocalStream>>>;
#[derive(PartialEq)]
enum Phase {
    Ready,
    Lost,
    Closing,
    Closed,
}
pub struct Client {
    address: PathBuf,
    connected: Connected,
    anchor: wire::Reader<LocalStream>,
    phase: Phase,
    peer: Option<DeploymentRef>,
}
impl Client {
    pub async fn connect(address: &Path, epoch: Option<Uuid>) -> Result<Self> {
        let anchor = ipc::connect(address)
            .await
            .map_err(|error| error.to_string())?;
        Self::connect_stream(address, epoch, anchor).await
    }
    pub async fn connect_stream(
        address: &Path,
        epoch: Option<Uuid>,
        anchor: LocalStream,
    ) -> Result<Self> {
        Self::open(address, epoch, anchor, Request::Connect).await
    }
    /// Only a trusted current-account launcher may approve an external UI source.
    pub async fn connect_peer(
        address: &Path,
        epoch: Option<Uuid>,
        source: DeploymentRef,
        consumers: BTreeSet<InstanceId>,
        endpoints: BTreeMap<String, HostEndpoint>,
    ) -> Result<Self> {
        let request = Request::ConnectPeer {
            source,
            consumers,
            endpoints,
        };
        let anchor = ipc::connect(address)
            .await
            .map_err(|error| error.to_string())?;
        Self::open(address, epoch, anchor, request).await
    }
    async fn open(
        address: &Path,
        epoch: Option<Uuid>,
        mut anchor: LocalStream,
        request: Request,
    ) -> Result<Self> {
        let peer = match &request {
            Request::ConnectPeer {
                source, consumers, ..
            } => {
                Peer::new(source.clone(), consumers.clone())?;
                Some(source.clone())
            }
            _ => None,
        };
        wire::write(
            &mut anchor,
            &Opening {
                client_instance: None,
                version: VERSION,
                epoch,
                request,
            },
        )
        .await?;
        let mut anchor = wire::Reader::new(anchor);
        let Response::Connected(connected) = anchor.read().await? else {
            return Err("Host did not establish an application session".into());
        };
        if connected.version != VERSION
            || connected.epoch.is_nil()
            || connected.session.is_nil()
            || epoch.is_some_and(|epoch| connected.epoch != epoch)
        {
            return Err("Host protocol or incarnation changed".into());
        }
        connected.source.validate()?;
        connected.catalogue.validate()?;
        connected
            .catalogue
            .check_names(connected.consumers.keys())?;
        Ok(Self {
            address: address.into(),
            connected,
            anchor,
            phase: Phase::Ready,
            peer,
        })
    }
    pub fn catalogue(&self) -> &Catalogue {
        &self.connected.catalogue
    }
    pub fn epoch(&self) -> Uuid {
        self.connected.epoch
    }
    pub fn source(&self) -> &DeploymentRef {
        &self.connected.source
    }
    /// Open inert custody for one exact captured endpoint. A caller retains this
    /// Call through errors; reconnection never retries an unconfirmed mutation.
    pub async fn call(
        &self,
        endpoint: &str,
        method: String,
        input: Value,
        resources: Attachments,
    ) -> Result<LocalCall> {
        if self.peer.is_some() {
            return Err("UI peer calls require the original checked caller and journal".into());
        }
        let selection = self.connected.catalogue.select(endpoint)?;
        let consumer = self
            .connected
            .consumers
            .get(endpoint)
            .ok_or("Host endpoint missing")?
            .clone();
        let (reader, output) = tokio::io::split(self.open_call_channel().await?);
        Ok(Call::new(
            reader,
            output,
            selection,
            Source {
                deployment: self.connected.source.clone(),
                consumer,
                mount: self.connected.session,
                request: Uuid::new_v4(),
            },
            method,
            input,
            resources,
        ))
    }
    /// Establish only the authenticated session channel. The native adapter retains
    /// its original checked Source, Call and caller-side RecordedIntent.
    pub async fn open_call_channel(&self) -> Result<BufReader<LocalStream>> {
        self.call_channel_opener()?.open().await
    }
    /// Freeze only this already authenticated session's physical target. It owns
    /// no anchor, caller approval, source, or operation token and cannot reconnect.
    pub fn call_channel_opener(&self) -> Result<CallChannelOpener> {
        if self.phase != Phase::Ready {
            return Err("Host session control is not ready".into());
        }
        Ok(CallChannelOpener {
            address: self.address.clone(),
            epoch: self.connected.epoch,
            session: self.connected.session,
        })
    }
    fn ready_peer(&self) -> Result<&DeploymentRef> {
        if self.phase != Phase::Ready {
            return Err("Host session control is not ready".into());
        }
        self.peer
            .as_ref()
            .ok_or("Host-owned session cannot approve peer sources".into())
    }
    async fn control(&mut self, command: SessionControl) -> Result<Response> {
        if self.phase != Phase::Ready {
            return Err("Host session control is not ready".into());
        }
        wire::encode_bounded(&command, usize::MAX)?;
        // Cancellation or a partial frame permanently fences further commands.
        self.phase = Phase::Lost;
        wire::write(&mut self.anchor.inner, &command).await?;
        self.anchor.read().await
    }
    pub async fn epochs(&mut self) -> Result<BTreeMap<String, Option<Uuid>>> {
        self.ready_peer()?;
        match self.control(SessionControl::Epochs).await? {
            Response::Epochs(result) => {
                self.phase = Phase::Ready;
                result
            }
            _ => Err("Host endpoint observation response mismatch".into()),
        }
    }
    pub async fn capture(&mut self) -> Result<Catalogue> {
        self.ready_peer()?;
        match self.control(SessionControl::Capture).await? {
            Response::Captured(result) => match result {
                Ok(catalogue) => {
                    catalogue.validate()?;
                    catalogue.check_names(self.connected.consumers.keys())?;
                    self.phase = Phase::Ready;
                    Ok(catalogue)
                }
                Err(error) => {
                    self.phase = Phase::Ready;
                    Err(error)
                }
            },
            _ => Err("Host capture response mismatch".into()),
        }
    }
    pub fn check_approval(
        &self,
        source: &DeploymentRef,
        consumers: &BTreeSet<InstanceId>,
        retain: &BTreeSet<u64>,
        captured: &Option<Catalogue>,
    ) -> Result<()> {
        let peer = self.ready_peer()?;
        source.validate()?;
        if source.state_domain != peer.state_domain || source.deployment != peer.deployment {
            return Err("foreign approval deployment".into());
        }
        if !consumers.is_empty() {
            Peer::new(source.clone(), consumers.clone())?;
        }
        if consumers.is_empty() != captured.is_none() {
            return Err("approval requires its captured endpoints".into());
        }
        if let Some(catalogue) = captured {
            catalogue.validate()?;
            catalogue.check_names(self.connected.consumers.keys())?;
        }
        wire::encode_bounded(
            &SessionControl::Approve {
                source: source.clone(),
                consumers: consumers.clone(),
                retain: retain.clone(),
                captured: captured.clone(),
            },
            usize::MAX,
        )?;
        Ok(())
    }
    pub async fn approve(
        &mut self,
        source: DeploymentRef,
        consumers: BTreeSet<InstanceId>,
        retain: BTreeSet<u64>,
        captured: Option<Catalogue>,
    ) -> Result<()> {
        self.check_approval(&source, &consumers, &retain, &captured)?;
        match self
            .control(SessionControl::Approve {
                source: source.clone(),
                consumers,
                retain,
                captured: captured.clone(),
            })
            .await?
        {
            Response::Approved {
                source: actual,
                result,
            } if actual == source => {
                if result.is_ok()
                    && let Some(catalogue) = captured
                {
                    self.connected.catalogue = catalogue;
                }
                self.phase = Phase::Ready;
                result
            }
            _ => Err("Host approval response mismatch".into()),
        }
    }
    /// After a lost control observation, shut down this anchor without appending
    /// a frame. Unix can still read its original cleanup acknowledgement; Windows
    /// closes the whole pipe and returns an error unless that acknowledgement was
    /// already buffered. EOF alone never confirms cleanup.
    pub async fn close(&mut self) -> Result<()> {
        if self.phase == Phase::Closed {
            return Ok(());
        }
        if self.phase == Phase::Ready {
            self.phase = Phase::Lost;
            if wire::write(&mut self.anchor.inner, &SessionControl::Close)
                .await
                .is_ok()
            {
                self.phase = Phase::Closing;
            }
        }
        if self.phase == Phase::Lost {
            self.anchor
                .inner
                .shutdown()
                .await
                .map_err(|error| error.to_string())?;
            self.phase = Phase::Closing;
        }
        loop {
            match self.anchor.read::<Response>().await? {
                Response::Closed => {
                    self.phase = Phase::Closed;
                    return Ok(());
                }
                // A cancelled control observer may have left its acknowledgement
                // buffered. None substitutes for the final session cleanup.
                Response::Epochs(_) | Response::Captured(_) | Response::Approved { .. } => {}
                _ => return Err("Host session cleanup remains unconfirmed".into()),
            }
        }
    }
    /// Close this local session and stop its Host when no other session remains.
    /// A separate epoch-pinned channel also works after losing a control observer;
    /// a partial frame on the original anchor must never receive another command.
    pub async fn quit(&mut self) -> Result<()> {
        if self.phase == Phase::Closed {
            return Ok(());
        }
        self.phase = Phase::Lost;
        match control(
            &self.address,
            Some(self.connected.epoch),
            Request::Quit {
                session: self.connected.session,
            },
        )
        .await?
        {
            Response::Closed => {
                self.phase = Phase::Closed;
                Ok(())
            }
            _ => Err("Host quit cleanup remains unconfirmed".into()),
        }
    }
    /// Read this incarnation's live publication and its current source CAS witness.
    pub async fn publication(&self) -> Result<Publication> {
        if self.phase != Phase::Ready || self.peer.is_some() {
            return Err("Host publication requires a ready local owner session".into());
        }
        match control(
            &self.address,
            Some(self.connected.epoch),
            Request::Publication,
        )
        .await?
        {
            Response::Publication(result) => result,
            _ => Err("Host publication response mismatch".into()),
        }
    }

    /// Persist trusted configuration and apply it to this same Host incarnation.
    /// A lost response must be retried with the same source and desired value.
    /// Explicitly narrowed or rebound endpoints must clear their product method ownership.
    pub async fn configure(
        &self,
        source: DeploymentRef,
        previous: Configuration,
        configuration: Configuration,
    ) -> Result<()> {
        if self.phase != Phase::Ready || self.peer.is_some() {
            return Err("Host configuration requires a ready local owner session".into());
        }
        match control(
            &self.address,
            Some(self.connected.epoch),
            Request::Configure {
                source,
                previous,
                configuration,
            },
        )
        .await?
        {
            Response::Configured(result) => result,
            _ => Err("Host configuration response mismatch".into()),
        }
    }
    pub async fn prepare_access(
        address: &Path,
        epoch: Uuid,
        principal: String,
    ) -> Result<super::Pairing> {
        match control(address, Some(epoch), Request::PrepareAccess { principal }).await? {
            Response::Pairing(result) => result,
            _ => Err("Host pairing response mismatch".into()),
        }
    }
    pub async fn revoke_access(address: &Path, epoch: Uuid, credential: String) -> Result<bool> {
        match control(address, Some(epoch), Request::RevokeAccess { credential }).await? {
            Response::Revoked(result) => result,
            _ => Err("Host revocation response mismatch".into()),
        }
    }
    pub async fn status(address: &Path, epoch: Option<Uuid>) -> Result<Status> {
        let stream = ipc::connect(address)
            .await
            .map_err(|error| error.to_string())?;
        Self::status_stream(stream, epoch).await
    }
    pub async fn status_stream(stream: LocalStream, epoch: Option<Uuid>) -> Result<Status> {
        match control_stream(stream, epoch, Request::Status).await? {
            Response::Status(status) => Ok(status),
            _ => Err("Host status response mismatch".into()),
        }
    }
    pub async fn retire(address: &Path, epoch: Uuid) -> Result<bool> {
        Self::retire_with_options(address, epoch, false, true).await
    }
    /// True confirms the retirement decision; force retirement can still be
    /// cleaning up. The original Root lease remains held through actual drain.
    pub async fn retire_with_options(
        address: &Path,
        epoch: Uuid,
        interrupt: bool,
        allow_idle_connections: bool,
    ) -> Result<bool> {
        match control(
            address,
            Some(epoch),
            Request::Retire {
                interrupt,
                allow_idle_connections,
            },
        )
        .await?
        {
            Response::Retired(result) => result,
            _ => Err("Host retirement response mismatch".into()),
        }
    }
}
/// An immutable physical target captured from an authenticated Client. The
/// embedding must fence native calls before detaching that Client's anchor.
#[derive(Clone)]
pub struct CallChannelOpener {
    address: PathBuf,
    epoch: Uuid,
    session: Uuid,
}
impl CallChannelOpener {
    pub async fn open(&self) -> Result<BufReader<LocalStream>> {
        let mut stream = ipc::connect(&self.address)
            .await
            .map_err(|error| error.to_string())?;
        wire::write(
            &mut stream,
            &Opening {
                client_instance: None,
                version: VERSION,
                epoch: Some(self.epoch),
                request: Request::Call {
                    session: self.session,
                },
            },
        )
        .await?;
        let mut reader = wire::Reader::new(stream);
        if !matches!(reader.read::<Response>().await?, Response::Accepted) {
            return Err("Host did not accept application channel".into());
        }
        Ok(reader.inner)
    }
}
async fn control(address: &Path, epoch: Option<Uuid>, request: Request) -> Result<Response> {
    let stream = ipc::connect(address)
        .await
        .map_err(|error| error.to_string())?;
    control_stream(stream, epoch, request).await
}
async fn control_stream(
    mut stream: LocalStream,
    epoch: Option<Uuid>,
    request: Request,
) -> Result<Response> {
    wire::write(
        &mut stream,
        &Opening {
            client_instance: None,
            version: VERSION,
            epoch,
            request,
        },
    )
    .await?;
    wire::Reader::new(stream).read().await
}
