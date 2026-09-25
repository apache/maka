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

impl Runner {
    pub fn new() -> (Self, mpsc::Receiver<Delivery>) {
        let (deliveries, receiver) = mpsc::channel(DELIVERY_CAPACITY);
        (
            Self {
                running: HashMap::new(),
                deliveries,
                tasks: tokio::task::JoinSet::new(),
                cleanup_failed: false,
            },
            receiver,
        )
    }

    /// A completed or failed token never restarts implicitly. A fresh read
    /// needs a new token; an unchanged View refresh retains the existing task.
    pub fn reconcile(&mut self, client: &Client, wanted: Vec<Mount>) -> Result<(), Failure> {
        self.reap();
        if let Err(error) = self.admit(&wanted) {
            self.stop();
            return Err(error);
        }
        self.running
            .retain(|token, _| wanted.iter().any(|mount| mount.token == *token));
        for mount in wanted {
            if self.running.contains_key(&mount.token) {
                continue;
            }
            let (commands, receiver) = mpsc::channel(1);
            let (stop, stopped) = oneshot::channel();
            let busy = Arc::new(AtomicBool::new(true));
            self.running.insert(
                mount.token,
                Running {
                    mount: mount.clone(),
                    commands,
                    busy: busy.clone(),
                    _stop: stop,
                },
            );
            // Never abort this task: a stream Open may complete after removal.
            self.tasks.spawn(transport::follow(
                client.clone(),
                mount,
                self.deliveries.clone(),
                receiver,
                busy,
                stopped,
            ));
        }
        Ok(())
    }

    pub fn page(
        &self,
        token: Uuid,
        direction: Direction,
        cursor: Option<String>,
    ) -> Result<(), Failure> {
        let running = self.running.get(&token).ok_or(Failure::Stopped)?;
        let command = Command::new(&running.mount.resource.id, direction, cursor)?;
        if running.commands.is_closed() {
            return Err(Failure::Stopped);
        }
        running
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Failure::Busy)?;
        if let Err(error) = running.commands.try_send(command) {
            running.busy.store(false, Ordering::Release);
            return Err(match error {
                mpsc::error::TrySendError::Full(_) => Failure::Busy,
                mpsc::error::TrySendError::Closed(_) => Failure::Stopped,
            });
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        self.running.clear();
    }

    pub(super) fn admit(&self, wanted: &[Mount]) -> Result<(), Failure> {
        if wanted.len() > MAX_MOUNTS {
            return Err(Failure::Overflow);
        }
        let mut tokens = HashSet::new();
        for mount in wanted {
            if !tokens.insert(mount.token)
                || self
                    .running
                    .get(&mount.token)
                    .is_some_and(|running| running.mount != *mount)
            {
                return Err(Failure::Invalid);
            }
            mount.resource.validate().map_err(|_| Failure::Invalid)?;
            mount.open().validate().map_err(|_| Failure::Invalid)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_peer::{Peer, mount, receive};
    use super::*;
    use maka_protocol::plugin::RemoteResult;
    use serde_json::json;

    #[tokio::test]
    async fn bootstrap_pages_precede_live_and_paging_preserves_pending_next() {
        let (client, mut peer) = Peer::connect().await;
        let mount = mount();
        let (mut runner, mut deliveries) = Runner::new();
        runner.reconcile(&client, vec![mount.clone()]).unwrap();
        let (document, opening) = peer.opening(&mount).await;
        let stream = Uuid::new_v4();
        peer.reply(&opening, RemoteResult::Opened { stream }).await;
        let ready = peer.read().await;
        assert_eq!(ready["input"]["kind"], "next");
        peer.reply(
            &ready,
            RemoteResult::Item {
                item: json!({"kind":"ready","fence":4}),
            },
        )
        .await;
        let tail = peer.read().await;
        assert_eq!(tail["input"]["kind"], "call");
        assert_eq!(tail["input"]["input"]["direction"], "tail");
        assert_eq!(tail["input"]["input"]["mount"], mount.token.to_string());
        peer.reply(
            &tail,
            RemoteResult::Value {
                value: json!({"fence":4,"records":[],"continuation":"part2"}),
            },
        )
        .await;
        let continuation = peer.read().await;
        assert_eq!(continuation["input"]["kind"], "call");
        assert_eq!(continuation["input"]["input"]["direction"], "continue");
        assert_eq!(continuation["input"]["input"]["fence"], 4);
        assert_eq!(
            continuation["input"]["input"]["mount"],
            mount.token.to_string()
        );
        peer.reply(
            &continuation,
            RemoteResult::Value {
                value: json!({"fence":4,"records":[],"older":"older"}),
            },
        )
        .await;
        assert!(matches!(
            receive(&mut deliveries).await.output,
            Output::Ready { fence: 4 }
        ));
        for _ in 0..2 {
            let delivery = receive(&mut deliveries).await;
            assert_eq!(delivery.token, mount.token);
            assert!(matches!(
                delivery.output,
                Output::Page {
                    direction: Direction::Tail,
                    ..
                }
            ));
        }
        let live = peer.read().await;
        assert_eq!(live["input"]["kind"], "next");
        runner
            .page(mount.token, Direction::Older, Some("older".into()))
            .unwrap();
        let history = peer.read().await;
        assert_eq!(history["input"]["kind"], "call");
        assert_eq!(history["input"]["input"]["direction"], "older");
        assert_eq!(history["input"]["input"]["fence"], 4);
        assert_eq!(history["input"]["input"]["mount"], mount.token.to_string());
        // Finish the original Next while the page call is still pending.
        peer.reply(
            &live,
            RemoteResult::Item {
                item: json!({"kind":"remove","base":4,"revision":5,
            "key":{"turn":"turn","message":"message","part":"text"}}),
            },
        )
        .await;
        assert!(matches!(
            receive(&mut deliveries).await.output,
            Output::Event(Event::Remove { revision: 5, .. })
        ));
        let next = peer.read().await;
        assert_eq!(next["input"]["kind"], "next");
        assert_ne!(live["requestId"], next["requestId"]);
        // Removing a reader closes its stream without closing the parent page.
        runner.stop();
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close");
        assert_eq!(close["input"]["document"], document.to_string());
        let mut shutdown = Box::pin(runner.shutdown());
        assert!(futures_util::poll!(&mut shutdown).is_pending());
        peer.reply(&close, RemoteResult::Closed).await;
        shutdown.await.unwrap();
        client.disconnect();
    }

    #[tokio::test]
    async fn removal_during_open_keeps_stream_cleanup_owned() {
        let (client, mut peer) = Peer::connect().await;
        let mount = mount();
        let (mut runner, _deliveries) = Runner::new();
        runner.reconcile(&client, vec![mount.clone()]).unwrap();
        let (document, opening) = peer.opening(&mount).await;
        runner.stop();
        let stream = Uuid::new_v4();
        // A late Open response is closed without starting Next.
        peer.reply(&opening, RemoteResult::Opened { stream }).await;
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close");
        assert_eq!(close["input"]["document"], document.to_string());
        assert_eq!(close["input"]["stream"], stream.to_string());
        let mut shutdown = Box::pin(runner.shutdown());
        assert!(futures_util::poll!(&mut shutdown).is_pending());
        peer.reply(&close, RemoteResult::Closed).await;
        shutdown.await.unwrap();
        client.disconnect();
    }

    #[tokio::test]
    async fn two_mounts_borrow_one_document_and_close_independently() {
        let (client, mut peer) = Peer::connect().await;
        let first = mount();
        let second = Mount {
            token: Uuid::new_v4(),
            ..first.clone()
        };
        let (mut runner, _deliveries) = Runner::new();
        runner.reconcile(&client, vec![first.clone()]).unwrap();
        let (_, opening) = peer.opening(&first).await;
        let first_stream = Uuid::new_v4();
        peer.reply(
            &opening,
            RemoteResult::Opened {
                stream: first_stream,
            },
        )
        .await;
        let first_next = peer.read().await;
        assert_eq!(first_next["input"]["kind"], "next");
        runner
            .reconcile(&client, vec![first.clone(), second.clone()])
            .unwrap();
        let (_, opening) = peer.opening(&second).await;
        let second_stream = Uuid::new_v4();
        peer.reply(
            &opening,
            RemoteResult::Opened {
                stream: second_stream,
            },
        )
        .await;
        let second_next = peer.read().await;
        assert_eq!(second_next["input"]["stream"], second_stream.to_string());
        runner.reconcile(&client, vec![second]).unwrap();
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close");
        assert_eq!(close["input"]["stream"], first_stream.to_string());
        assert_eq!(close["input"]["document"], first.document.to_string());
        peer.reply(&close, RemoteResult::Closed).await;
        runner.stop();
        let close = peer.read().await;
        assert_eq!(close["input"]["kind"], "close");
        assert_eq!(close["input"]["stream"], second_stream.to_string());
        peer.reply(&close, RemoteResult::Closed).await;
        runner.shutdown().await.unwrap();
        client.disconnect();
    }
}
