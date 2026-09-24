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

use crate::Error;
use maka_client::Client;
use maka_protocol::subscription::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

#[derive(Clone, Default)]
pub(crate) struct Routes(Arc<Mutex<HashMap<String, mpsc::Sender<ObservationFrame>>>>);
impl Routes {
    pub fn dispatch(&self, frame: ObservationFrame) -> Result<(), Error> {
        let routes = self.0.lock().unwrap();
        if let Some(route) = routes.get(frame.envelope().subscription_id) {
            route
                .try_send(frame)
                .map_err(|_| "ACP observation consumer fell behind")?;
        }
        Ok(())
    }
}

pub(crate) struct Subscription {
    pub id: String,
    pub through: Option<u64>,
    pub snapshot: SessionObservationSnapshot,
    pub receiver: mpsc::Receiver<ObservationFrame>,
    client: Client,
    routes: Routes,
    closed: bool,
}
impl Subscription {
    pub async fn open(client: &Client, routes: &Routes, session: &str) -> Result<Self, Error> {
        let opened = client
            .open_subscription(SubscriptionOpenInput {
                session_id: session.into(),
                transcript: TranscriptPolicy::Tail { max_bytes: 16384 },
            })
            .await?;
        let (tx, receiver) = mpsc::channel(64);
        routes
            .0
            .lock()
            .unwrap()
            .insert(opened.subscription_id.clone(), tx);
        let subscription = Self {
            through: opened
                .transcript
                .as_ref()
                .and_then(|page| page.durable.through_sequence),
            id: opened.subscription_id,
            snapshot: opened.snapshot,
            receiver,
            client: client.clone(),
            routes: routes.clone(),
            closed: false,
        };
        client.ready_subscription(&subscription.id).await?;
        Ok(subscription)
    }
    pub fn observe(&mut self, frame: &ObservationFrame) {
        match frame {
            ObservationFrame::Projection(frame) => {
                let SessionProjectionFrame::SessionProjection { snapshot, .. } = frame.as_ref();
                self.snapshot = snapshot.clone();
            }
            ObservationFrame::Transcript(TranscriptAdvancedFrame::TranscriptAdvanced {
                through_sequence,
                ..
            }) => {
                self.through = Some(self.through.unwrap_or(0).max(*through_sequence));
            }
            _ => {}
        }
    }
    pub async fn close(mut self) -> Result<(), Error> {
        self.routes.0.lock().unwrap().remove(&self.id);
        self.closed = true;
        self.client.close_subscription(&self.id).await?;
        Ok(())
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if !self.closed {
            self.routes.0.lock().unwrap().remove(&self.id);
            let client = self.client.clone();
            let id = self.id.clone();
            tokio::spawn(async move {
                let _ = client.close_subscription(&id).await;
            });
        }
    }
}
