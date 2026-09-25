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

//! Bounded observation transport for mounted transcripts. Semantic merging and
//! fragment assembly belong to the mount owner, which rejects retired tokens.

mod pages;
mod runner;
mod transport;

use maka_client::Client;
use maka_plugins::{
    remote::Target,
    terminal_ui::transcript::{Direction, Event, Open, Page, Read, Resource},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub const MAX_MOUNTS: usize = 4;
const DELIVERY_CAPACITY: usize = 32;

/// The token is allocated locally for the full source/route/node binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
    pub token: Uuid,
    pub package: String,
    pub session: Option<String>,
    pub parent: Target,
    pub resource: Resource,
    pub locale: String,
}

#[derive(Debug)]
pub struct Delivery {
    pub token: Uuid,
    pub output: Output,
}

#[derive(Debug)]
pub enum Output {
    Ready {
        fence: u64,
    },
    /// All pieces carry the original direction, including Continue responses.
    /// Only a page without a continuation completes the logical page.
    Page {
        direction: Direction,
        page: Page,
    },
    Event(Event),
    Failure(Failure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Busy,
    Stopped,
    Invalid,
    Binding,
    Remote,
    Ended,
    Invalidated,
    Overflow,
    Cleanup,
}

pub struct Runner {
    running: HashMap<Uuid, Running>,
    deliveries: mpsc::Sender<Delivery>,
    tasks: tokio::task::JoinSet<Result<(), Failure>>,
    cleanup_failed: bool,
}

struct Running {
    mount: Mount,
    commands: mpsc::Sender<Command>,
    busy: Arc<AtomicBool>,
    // Dropping this sender requests cancellation; the task retains cleanup.
    _stop: oneshot::Sender<()>,
}

struct Command {
    direction: Direction,
    cursor: Option<String>,
}

impl Runner {
    /// Close current and retired documents before disconnecting the Client or
    /// shutting down the runtime. Dropping this future never aborts cleanup.
    pub async fn shutdown(&mut self) -> Result<(), Failure> {
        self.stop();
        while let Some(result) = self.tasks.join_next().await {
            self.cleanup_failed |= !matches!(result, Ok(Ok(())));
        }
        if self.cleanup_failed {
            Err(Failure::Cleanup)
        } else {
            Ok(())
        }
    }

    fn reap(&mut self) {
        while let Some(result) = self.tasks.try_join_next() {
            self.cleanup_failed |= !matches!(result, Ok(Ok(())));
        }
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.stop();
        // JoinSet normally aborts on drop. A document cleanup task must retain
        // ownership even when the caller omitted explicit shutdown.
        self.tasks.detach_all();
    }
}

impl Command {
    fn new(resource: &str, direction: Direction, cursor: Option<String>) -> Result<Self, Failure> {
        if direction == Direction::Continue {
            return Err(Failure::Invalid);
        }
        Read {
            resource: resource.into(),
            fence: 0,
            direction,
            cursor: cursor.clone(),
        }
        .validate()
        .map_err(|_| Failure::Invalid)?;
        Ok(Self { direction, cursor })
    }
}

impl Mount {
    fn open(&self) -> Open {
        Open {
            resource: self.resource.id.clone(),
            route: self.resource.route.clone(),
            locale: self.locale.clone(),
        }
    }
}

async fn deliver(
    deliveries: &mpsc::Sender<Delivery>,
    token: Uuid,
    output: Output,
) -> Result<(), Failure> {
    deliveries
        .send(Delivery { token, output })
        .await
        .map_err(|_| Failure::Stopped)
}

#[cfg(test)]
mod test_peer;

#[cfg(test)]
mod tests {
    use super::*;

    use super::test_peer::mount;

    #[test]
    fn mount_admission_rejects_duplicate_rebound_and_excess_tokens() {
        let (mut runner, _deliveries) = Runner::new();
        let mount = mount();
        assert_eq!(runner.admit(std::slice::from_ref(&mount)), Ok(()));
        assert_eq!(
            runner.admit(&[mount.clone(), mount.clone()]),
            Err(Failure::Invalid)
        );
        assert_eq!(
            runner.admit(&vec![mount.clone(); MAX_MOUNTS + 1]),
            Err(Failure::Overflow)
        );
        let (commands, _receiver) = mpsc::channel(1);
        let (stop, _stopped) = oneshot::channel();
        runner.running.insert(
            mount.token,
            Running {
                mount: mount.clone(),
                commands,
                busy: Arc::new(AtomicBool::new(false)),
                _stop: stop,
            },
        );
        assert_eq!(runner.admit(std::slice::from_ref(&mount)), Ok(()));
        let mut rebound = mount;
        rebound.parent.registration = Uuid::new_v4();
        assert_eq!(runner.admit(&[rebound]), Err(Failure::Invalid));
    }

    #[test]
    fn page_admission_covers_bootstrap_active_chain_and_stopped_mount() {
        let (mut runner, _deliveries) = Runner::new();
        let mount = mount();
        let token = mount.token;
        let (commands, mut receiver) = mpsc::channel(1);
        let (stop, mut stopped) = oneshot::channel();
        let busy = Arc::new(AtomicBool::new(true));
        runner.running.insert(
            token,
            Running {
                mount,
                commands,
                busy: busy.clone(),
                _stop: stop,
            },
        );
        assert_eq!(
            runner.page(token, Direction::Tail, None),
            Err(Failure::Busy)
        );
        busy.store(false, Ordering::Release);
        assert_eq!(
            runner.page(token, Direction::Continue, Some("cursor".into())),
            Err(Failure::Invalid)
        );
        assert_eq!(
            runner.page(token, Direction::Older, None),
            Err(Failure::Invalid)
        );
        assert_eq!(
            runner.page(token, Direction::Older, Some("cursor".into())),
            Ok(())
        );
        let _active = receiver.try_recv().unwrap();
        assert_eq!(
            runner.page(token, Direction::Tail, None),
            Err(Failure::Busy)
        );
        busy.store(false, Ordering::Release);
        drop(receiver);
        assert_eq!(
            runner.page(token, Direction::Tail, None),
            Err(Failure::Stopped)
        );
        runner.stop();
        assert_eq!(
            stopped.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        );
        assert_eq!(
            runner.page(token, Direction::Tail, None),
            Err(Failure::Stopped)
        );
    }
}
