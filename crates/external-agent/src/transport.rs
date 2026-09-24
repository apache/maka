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

use agent_client_protocol::{self as sdk, ConnectTo};
use futures_util::{sink, stream};
use maka_plugins::{
    call::Scope,
    host::Services,
    process::{Command, Handle, Id, Process, Stream},
};
use std::{
    io,
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};

mod client;
pub(crate) use client::{Event, Peer};
const MAX_LINE: usize = 1024 * 1024;

pub struct Connection {
    pub(crate) owner: Arc<Owner>,
    pub(crate) events: mpsc::Receiver<Event>,
    pub(crate) run: sdk::BoxFuture<'static, sdk::Result<()>>,
    pub(crate) peer: Option<Peer>,
}

impl Connection {
    pub fn new(
        host: Services,
        scope: Scope,
        command: Command,
        handle: Handle,
        files: bool,
    ) -> Self {
        let (binding, _) = watch::channel(handle.io);
        let owner = Arc::new(Owner {
            host,
            scope,
            command,
            binding,
            state: Mutex::new(OwnerState {
                id: handle.id,
                first: true,
            }),
        });
        let (send, events) = mpsc::channel(32);
        let run = Box::pin(client::connect(send.clone(), files, {
            let owner = owner.clone();
            move || HostTransport {
                owner: owner.clone(),
                send: send.clone(),
            }
        }));
        Self {
            owner,
            events,
            run,
            peer: None,
        }
    }
    pub fn id(&self) -> Id {
        self.owner.state.lock().unwrap().id.clone()
    }
    pub fn rebind(&mut self, handle: Handle) -> Result<(), crate::Error> {
        if handle.id != self.id() {
            return Err(crate::Error::Invalid(
                "cannot rebind a different external process",
            ));
        }
        self.owner.binding.send_replace(handle.io);
        Ok(())
    }
    pub fn request<R: sdk::JsonRpcRequest>(&self, request: R) -> sdk::SentRequest<R::Response> {
        match self.peer.as_ref().expect("initialized SDK connection") {
            Peer::V1(peer, _) => peer.send_request(request),
            Peer::V2(peer, _) => peer.send_request(request),
        }
    }
}

struct OwnerState {
    id: Id,
    first: bool,
}
pub(crate) struct Owner {
    host: Services,
    scope: Scope,
    command: Command,
    state: Mutex<OwnerState>,
    binding: watch::Sender<Arc<dyn Process>>,
}
struct HostTransport {
    owner: Arc<Owner>,
    send: mpsc::Sender<Event>,
}

impl Owner {
    pub async fn close(&self) -> Result<(), crate::Error> {
        let id = self.state.lock().unwrap().id.clone();
        self.host.processes.close(id).await?;
        Ok(())
    }
}

impl ConnectTo<sdk::Client> for HostTransport {
    async fn connect_to(self, client: impl ConnectTo<sdk::Agent>) -> sdk::Result<()> {
        let previous = {
            let mut state = self.owner.state.lock().unwrap();
            if state.first {
                state.first = false;
                None
            } else {
                Some(state.id.clone())
            }
        };
        if let Some(previous) = previous {
            // SDK fallback requests a fresh transport when initialization differs.
            // Settle the probe process before creating the v1 process through Host.
            self.owner
                .host
                .processes
                .close(previous)
                .await
                .map_err(sdk_error)?;
            let handle = self
                .owner
                .host
                .processes
                .spawn(self.owner.scope.clone(), self.owner.command.clone())
                .await
                .map_err(sdk_error)?;
            self.owner.state.lock().unwrap().id = handle.id;
            self.owner.binding.send_replace(handle.io);
        }
        let reader = Reader {
            binding: self.owner.binding.subscribe(),
            line: vec![],
            chunk: vec![],
            offset: 0,
            send: self.send,
        };
        let incoming = stream::try_unfold(reader, |mut reader| async move {
            reader
                .next()
                .await
                .map(|line| line.map(|line| (line, reader)))
        });
        let outgoing = sink::unfold(
            self.owner.binding.subscribe(),
            |binding, mut line: String| async move {
                if line.len() > MAX_LINE {
                    return Err(io::Error::other("ACP output frame exceeds 1 MiB"));
                }
                line.push('\n');
                let process = binding.borrow().clone();
                for chunk in line.as_bytes().chunks(64 * 1024) {
                    process
                        .write(chunk.to_vec())
                        .await
                        .map_err(io::Error::other)?;
                }
                Ok::<_, io::Error>(binding)
            },
        );
        sdk::ConnectTo::<sdk::Client>::connect_to(sdk::Lines::new(outgoing, incoming), client).await
    }
}

struct Reader {
    binding: watch::Receiver<Arc<dyn Process>>,
    line: Vec<u8>,
    chunk: Vec<u8>,
    offset: usize,
    send: mpsc::Sender<Event>,
}
impl Reader {
    async fn next(&mut self) -> io::Result<Option<String>> {
        loop {
            if self.offset < self.chunk.len() {
                let remaining = &self.chunk[self.offset..];
                let newline = remaining.iter().position(|byte| *byte == b'\n');
                let len = newline.unwrap_or(remaining.len());
                if self.line.len().saturating_add(len) > MAX_LINE {
                    return Err(io::Error::other("ACP input frame exceeds 1 MiB"));
                }
                self.line.extend_from_slice(&remaining[..len]);
                self.offset += len + usize::from(newline.is_some());
                if newline.is_some() {
                    return String::from_utf8(std::mem::take(&mut self.line))
                        .map(Some)
                        .map_err(io::Error::other);
                }
            }
            self.chunk.clear();
            self.offset = 0;
            let process = self.binding.borrow_and_update().clone();
            let chunk = tokio::select! {
                biased;
                changed = self.binding.changed() => { changed.map_err(io::Error::other)?; continue; },
                chunk = process.next() => chunk.map_err(io::Error::other)?,
            };
            let Some(chunk) = chunk else {
                if !self.line.is_empty() {
                    return Err(io::Error::other("ACP input ended within a frame"));
                }
                return Ok(None);
            };
            if chunk.bytes.len() > MAX_LINE {
                return Err(io::Error::other("ACP process chunk exceeds 1 MiB"));
            }
            match chunk.stream {
                Stream::Stdout => self.chunk = chunk.bytes,
                Stream::Stderr => self
                    .send
                    .send(Event::Stderr(chunk.bytes))
                    .await
                    .map_err(|error| io::Error::other(error.to_string()))?,
            }
        }
    }
}
pub(crate) fn sdk_error(error: impl std::fmt::Display) -> sdk::Error {
    sdk::Error::internal_error().data(error.to_string())
}
