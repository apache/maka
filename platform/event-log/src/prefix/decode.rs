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

//! Join both stages before the caller commits, rolls back, or fences its owner.
use crate::{StoreError, canonical::PreparedEvent, context::evidence::RootDigest};
use futures_util::FutureExt;
use maka_agent_facts::event::StoredEvent;
use std::{future::Future, panic::AssertUnwindSafe, sync::mpsc};
use tokio::task::JoinHandle;

pub(super) enum Produced {
    Complete(Option<RootDigest>),
    DecoderStopped,
}

pub(super) async fn run<P, F>(
    count: usize,
    produce: P,
) -> Result<(Vec<StoredEvent>, Option<RootDigest>), StoreError>
where
    P: FnOnce(mpsc::Sender<(u64, PreparedEvent)>) -> F,
    F: Future<Output = Result<Produced, StoreError>>,
{
    // The snapshot's preflight already bounds this finite batch by the caller's
    // event/byte budgets. No producer data survives this one admitted prefix.
    let (sender, receiver) = mpsc::channel::<(u64, PreparedEvent)>();
    let decoder = tokio::task::spawn_blocking(move || {
        receiver
            .into_iter()
            .map(|(sequence, prepared)| {
                Ok(StoredEvent {
                    sequence,
                    event: prepared.decode()?,
                })
            })
            .collect()
    });
    finish(async move { produce(sender).await }, decoder, count).await
}

async fn finish<F>(
    produce: F,
    decoder: JoinHandle<Result<Vec<StoredEvent>, StoreError>>,
    count: usize,
) -> Result<(Vec<StoredEvent>, Option<RootDigest>), StoreError>
where
    F: Future<Output = Result<Produced, StoreError>>,
{
    // SQLx rethrows worker panics at await. Drain the CPU task before restoring
    // that panic so the existing owner fence cannot detach unfinished work.
    let produced = AssertUnwindSafe(produce).catch_unwind().await;
    let decoded = decoder.await;
    let produced = match produced {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    };
    let decoded = match decoded {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(std::io::Error::other(error).into()),
    };
    let produced = produced?;
    let events = decoded?;
    match produced {
        Produced::Complete(digest) if events.len() == count => Ok((events, digest)),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "prefix decoder stopped before completing the admitted snapshot",
        )
        .into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[tokio::test]
    async fn producer_panic_waits_for_decoder_before_restoring_the_owner_panic() {
        let (release, blocked) = mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let decoder = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let _ = blocked.recv();
            done.store(true, Ordering::Release);
            Ok(Vec::new())
        });
        ready.await.unwrap();
        let mut parent = Box::pin(
            AssertUnwindSafe(finish(async { panic!("producer panic") }, decoder, 0)).catch_unwind(),
        );
        assert!(parent.as_mut().now_or_never().is_none());
        assert!(!finished.load(Ordering::Acquire));
        release.send(()).unwrap();
        let result = parent.await;
        let Err(panic) = result else {
            panic!("producer panic was hidden")
        };
        assert_eq!(panic.downcast_ref::<&str>(), Some(&"producer panic"));
        assert!(finished.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn producer_error_also_drains_the_decoder() {
        let (release, blocked) = mpsc::channel();
        let (started, ready) = tokio::sync::oneshot::channel();
        let decoder = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            let _ = blocked.recv();
            Ok(Vec::new())
        });
        ready.await.unwrap();
        let mut parent = Box::pin(finish(async { Err(StoreError::EventConflict) }, decoder, 0));
        assert!(parent.as_mut().now_or_never().is_none());
        release.send(()).unwrap();
        assert!(matches!(parent.await, Err(StoreError::EventConflict)));
    }

    #[tokio::test]
    async fn decoder_failure_is_not_masked_by_a_stopped_producer() {
        let decoder = tokio::task::spawn_blocking(|| Err(StoreError::EventConflict));
        assert!(matches!(
            finish(async { Ok(Produced::DecoderStopped) }, decoder, 1).await,
            Err(StoreError::EventConflict)
        ));
        let decoder = tokio::task::spawn_blocking(|| Ok(Vec::new()));
        assert!(
            finish(async { Ok(Produced::Complete(None)) }, decoder, 1)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn decoder_panic_is_restored_after_the_producer_finishes() {
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let decoder = tokio::task::spawn_blocking(|| panic!("decoder panic"));
        let result = AssertUnwindSafe(finish(
            async move {
                done.store(true, Ordering::Release);
                Ok(Produced::Complete(None))
            },
            decoder,
            0,
        ))
        .catch_unwind()
        .await;
        assert!(finished.load(Ordering::Acquire));
        let Err(panic) = result else {
            panic!("decoder panic was hidden")
        };
        assert_eq!(panic.downcast_ref::<&str>(), Some(&"decoder panic"));
    }
}
