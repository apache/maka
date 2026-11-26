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
use super::Session;
use crate::{
    Error,
    client::{Client, Subscription},
    presentation::Completion,
    transport::Peer,
};
use maka_agent_api::contract::{DeliveryFact, DeliveryPage, Observation, SessionActivity};
use serde_json::json;
use std::sync::Arc;
use tokio::{
    sync::{Mutex, OwnedMutexGuard},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

pub(crate) struct Follow {
    publish: Arc<Mutex<()>>,
    stop: CancellationToken,
    task: JoinHandle<Result<(), Error>>,
}

impl Session {
    // Keep the old stream and cursor intact until the replacement snapshot commits.
    pub(super) async fn pause_following(&self) -> Option<OwnedMutexGuard<()>> {
        let publish = self.follow.lock().unwrap().as_ref()?.publish.clone();
        Some(publish.lock_owned().await)
    }

    // The session gate orders replacement, close and handoff to a local foreground.
    pub(crate) async fn replace_following(&self, next: Option<Follow>) -> Result<(), Error> {
        let follow = std::mem::replace(&mut *self.follow.lock().unwrap(), next);
        if let Some(follow) = follow {
            follow.stop.cancel();
            follow.task.await??;
        }
        Ok(())
    }
}

impl Follow {
    pub(super) async fn resume(
        client: &Client,
        peer: &Peer,
        observation: Observation,
        replayed: bool,
    ) -> Result<Option<Self>, Error> {
        let session = observation.session;
        let activity = session.activity;
        if !peer.is_v2() || activity == SessionActivity::Idle {
            peer.synchronize(&session, replayed)?;
            return Ok(None);
        }
        let mut watch = client
            .subscribe(
                "agent",
                "watch",
                json!({"sessionId":session.id, "after":observation.through}),
            )
            .await?;
        if let Err(error) = peer.synchronize(&session, replayed) {
            watch.close().await?;
            return Err(error);
        }
        let id = session.id;
        let client = client.clone();
        let peer = peer.clone();
        let stop = peer.stop.child_token();
        let cancel = stop.clone();
        let publish = Arc::<Mutex<()>>::default();
        let output = publish.clone();
        let task = tokio::spawn(async move {
            let result =
                until_idle(&client, &peer, &id, &mut watch, activity, &cancel, &output).await;
            let closed = watch.close().await;
            if result.is_err() || closed.is_err() {
                peer.stop.cancel();
            }
            closed?;
            result
        });
        Ok(Some(Self {
            publish,
            stop,
            task,
        }))
    }
}

async fn until_idle(
    client: &Client,
    peer: &Peer,
    id: &str,
    watch: &mut Subscription,
    mut activity: SessionActivity,
    cancel: &CancellationToken,
    output: &Mutex<()>,
) -> Result<(), Error> {
    loop {
        let page = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(()),
            page = watch.next::<DeliveryPage>() => page?,
        };
        // Interactions include an initial cut. Token and preview updates don't
        // change aggregate activity; only re-read it on a possible transition.
        match page {
            DeliveryPage::Interactions { .. } => {}
            DeliveryPage::Events { events, .. }
                if events
                    .iter()
                    .any(|e| matches!(e.fact, DeliveryFact::Ended { .. })) => {}
            _ => continue,
        }
        let current: Observation = client
            .query("agent", "observe", json!({"sessionId":id}))
            .await?;
        if activity == current.session.activity {
            continue;
        }
        let _publish = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Ok(()),
            guard = output.lock() => guard,
        };
        activity = current.session.activity;
        if activity == SessionActivity::Idle && current.last_completed_turn_id.is_some() {
            return peer.complete(id, Ok(Completion::Completed)).await;
        }
        peer.state(id, activity)?;
        if activity == SessionActivity::Idle {
            return Ok(());
        }
    }
}
