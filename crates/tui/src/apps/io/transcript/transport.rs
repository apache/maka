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

use super::*;
use futures_util::future::{BoxFuture, pending};
use maka_protocol::plugin::{RemoteBinding, RemoteKind, RemoteRequest, RemoteResult};

pub(super) struct Endpoint {
    pub binding: RemoteBinding,
    pub target: Target,
}

pub(super) async fn follow(
    client: Client,
    mount: Mount,
    deliveries: mpsc::Sender<Delivery>,
    commands: mpsc::Receiver<Command>,
    busy: Arc<AtomicBool>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<(), Failure> {
    let endpoints = tokio::select! {
        biased;
        _ = &mut stopped => return Ok(()),
        _ = deliveries.closed() => return Ok(()),
        result = bind(&client, &mount) => result,
    };
    let (read, stream) = match endpoints {
        Ok(endpoints) => endpoints,
        Err(error) => {
            let _ = deliver(&deliveries, mount.token, Output::Failure(error)).await;
            return Ok(());
        }
    };
    let document = mount.document;
    // Retain Open until its stream identity is known, even after removal.
    let opened = client
        .plugin_remote(RemoteRequest::Open {
            binding: stream.binding,
            target: stream.target,
            document,
            input: serde_json::to_value(mount.open()).map_err(|_| Failure::Invalid)?,
        })
        .await;
    let stream = match opened {
        Ok(RemoteResult::Opened { stream }) => stream,
        result => {
            let unknown = matches!(result, Err(maka_client::RequestFailure::Unknown(_)));
            let error = if unknown {
                Failure::Cleanup
            } else {
                Failure::Remote
            };
            let _ = deliver(&deliveries, mount.token, Output::Failure(error)).await;
            return if unknown {
                Err(Failure::Cleanup)
            } else {
                Ok(())
            };
        }
    };
    let result = tokio::select! {
        biased;
        _ = &mut stopped => None,
        _ = deliveries.closed() => None,
        result = observe(&client, &mount, document, &read, stream,
            &deliveries, commands, busy) => Some(result),
    };
    // A reader owns only its stream; sibling mounts retain the parent Page.
    let cleanup = match client
        .plugin_remote(RemoteRequest::Close { document, stream })
        .await
    {
        Ok(RemoteResult::Closed) => Ok(()),
        _ => Err(Failure::Cleanup),
    };
    if let Some(Err(error)) = result {
        let error = cleanup.as_ref().err().copied().unwrap_or(error);
        tokio::select! { biased; _ = &mut stopped => {}, _ = deliver(&deliveries, mount.token, Output::Failure(error)) => {} }
    }
    cleanup
}

async fn bind(client: &Client, mount: &Mount) -> Result<(Endpoint, Endpoint), Failure> {
    tokio::try_join!(
        endpoint(client, mount, &mount.resource.read, RemoteKind::Method),
        endpoint(client, mount, &mount.resource.stream, RemoteKind::Stream),
    )
}

async fn endpoint(
    client: &Client,
    mount: &Mount,
    method: &str,
    expected: RemoteKind,
) -> Result<Endpoint, Failure> {
    let binding = RemoteBinding::Package {
        package_id: mount.package.clone(),
        method: method.into(),
        session_id: mount.session.clone(),
    };
    let RemoteResult::Bound { target, handler } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .map_err(|_| Failure::Remote)?
    else {
        return Err(Failure::Binding);
    };
    if !same_owner(&mount.parent, &target)
        || !matches!(
            (expected, handler),
            (RemoteKind::Method, RemoteKind::Method) | (RemoteKind::Stream, RemoteKind::Stream)
        )
    {
        return Err(Failure::Binding);
    }
    Ok(Endpoint { binding, target })
}

fn same_owner(parent: &Target, endpoint: &Target) -> bool {
    parent.entry_id == endpoint.entry_id && parent.activation == endpoint.activation
}

#[allow(clippy::too_many_arguments)]
async fn observe(
    client: &Client,
    mount: &Mount,
    document: Uuid,
    read: &Endpoint,
    stream: Uuid,
    deliveries: &mpsc::Sender<Delivery>,
    mut commands: mpsc::Receiver<Command>,
    busy: Arc<AtomicBool>,
) -> Result<(), Failure> {
    let Event::Ready { fence } = next(client, document, stream).await? else {
        return Err(Failure::Invalid);
    };
    deliver(deliveries, mount.token, Output::Ready { fence }).await?;
    pages::read(
        client,
        mount,
        document,
        read,
        fence,
        Command {
            direction: Direction::Tail,
            cursor: None,
        },
        deliveries,
    )
    .await?;
    busy.store(false, Ordering::Release);

    // Both futures persist across select! calls. In particular a page request
    // must not drop Next: the Host can still have its single read in flight.
    let mut next = Box::pin(next(client, document, stream));
    let mut reading: BoxFuture<'_, Result<(), Failure>> = Box::pin(pending());
    let mut paging = false;
    loop {
        tokio::select! {
            command = commands.recv(), if !paging => {
                let command = command.ok_or(Failure::Stopped)?;
                reading = Box::pin(pages::read(client, mount, document, read, fence,
                    command, deliveries));
                paging = true;
            }
            result = &mut reading, if paging => {
                result?;
                reading = Box::pin(pending());
                paging = false;
                busy.store(false, Ordering::Release);
            }
            result = &mut next => {
                let event = result?;
                if matches!(event, Event::Ready { .. }) {
                    return Err(Failure::Invalid);
                }
                deliver(deliveries, mount.token, Output::Event(event)).await?;
                next = Box::pin(self::next(client, document, stream));
            }
        }
    }
}

async fn next(client: &Client, document: Uuid, stream: Uuid) -> Result<Event, Failure> {
    loop {
        match client
            .plugin_remote(RemoteRequest::Next { document, stream })
            .await
        {
            Ok(RemoteResult::Item { item }) => {
                let (event, _) = pages::decode::<Event>(item)?;
                event.validate().map_err(|_| Failure::Invalid)?;
                return match event {
                    Event::Invalidated => Err(Failure::Invalidated),
                    event => Ok(event),
                };
            }
            Ok(RemoteResult::Pending) => {}
            Ok(RemoteResult::End) => return Err(Failure::Ended),
            Ok(_) => return Err(Failure::Invalid),
            Err(_) => return Err(Failure::Remote),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_registration_is_independent_but_owner_cannot_change() {
        let parent = Target {
            entry_id: "entry".into(),
            activation: "activation".into(),
            registration: Uuid::new_v4(),
        };
        let mut resource = parent.clone();
        resource.registration = Uuid::new_v4();
        assert!(same_owner(&parent, &resource));
        resource.activation = "replacement".into();
        assert!(!same_owner(&parent, &resource));
        resource.activation.clone_from(&parent.activation);
        resource.entry_id = "other".into();
        assert!(!same_owner(&parent, &resource));
    }
}
