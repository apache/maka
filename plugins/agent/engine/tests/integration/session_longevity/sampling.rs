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

use maka_agent_facts::tools::{ToolError, ToolExecutor, ToolFuture};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::sync::Barrier;
use tokio_util::sync::CancellationToken;

pub(super) struct StepGate {
    root: PathBuf,
    first: Barrier,
    second: Barrier,
    paused: Vec<AtomicU64>,
    // A cancelled barrier cannot be reused safely. Fail all participants rather
    // than leaving a peer waiting for a Session that has already stopped.
    cancelled: CancellationToken,
}

impl StepGate {
    pub(super) fn new(root: PathBuf, w: usize) -> Arc<Self> {
        assert!(w > 0);
        Arc::new(Self {
            root,
            first: Barrier::new(w),
            second: Barrier::new(w),
            paused: (0..w).map(|_| AtomicU64::new(0)).collect(),
            cancelled: CancellationToken::new(),
        })
    }

    pub(super) fn paused_nanos(&self, index: usize) -> u64 {
        self.paused[index].load(Ordering::Acquire)
    }

    async fn wait(
        &self,
        barrier: &Barrier,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                self.cancelled.cancel();
                Err(fixture_cancelled())
            }
            _ = self.cancelled.cancelled() => Err(fixture_cancelled()),
            _ = barrier.wait() => Ok(()),
        }
    }

    async fn checkpoint(
        &self,
        index: usize,
        cancellation: &CancellationToken,
        sample: impl Future<Output = ()>,
    ) -> Result<(), ToolError> {
        let started = Instant::now();
        let result = async {
            self.wait(&self.first, cancellation).await?;
            if index == 0 {
                // Once started, the blocking read must really finish before
                // this tool settles, including when cancellation arrives.
                sample.await;
            }
            self.wait(&self.second, cancellation).await
        }
        .await;
        self.paused[index].fetch_add(
            u64::try_from(started.elapsed().as_nanos()).expect("fixture pause fits u64"),
            Ordering::Release,
        );
        result
    }
}

fn fixture_cancelled() -> ToolError {
    ToolError::Failed("same_run sampling fixture cancelled".into())
}

pub(super) struct Echo {
    pub effects: Arc<AtomicUsize>,
    pub gate: Arc<StepGate>,
    pub index: usize,
}

impl ToolExecutor for Echo {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let effects = self.effects.clone();
        let gate = self.gate.clone();
        let index = self.index;
        Box::pin(async move {
            let step = input["step"].as_u64().expect("fixture step is an integer") as usize;
            if step % 100 == 0 {
                gate.checkpoint(index, &cancellation, async {
                    super::sample(&gate.root, "active_sample", step, gate.paused.len(), 0).await;
                })
                .await?;
            }
            if cancellation.is_cancelled() || gate.cancelled.is_cancelled() {
                gate.cancelled.cancel();
                return Err(fixture_cancelled());
            }
            let output = json!({"step":input["step"],"payload":"x".repeat(128)});
            effects.fetch_add(1, Ordering::Relaxed);
            Ok(output)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancellation_releases_waiting_peers_without_tool_effects() {
        let gate = StepGate::new(PathBuf::new(), 3);
        let effects = Arc::new(AtomicUsize::new(0));
        let cancellation = CancellationToken::new();
        let first = Echo {
            effects: effects.clone(),
            gate: gate.clone(),
            index: 0,
        };
        let second = Echo {
            effects: effects.clone(),
            gate: gate.clone(),
            index: 1,
        };
        let a = tokio::spawn(first.invoke("echo".into(), json!({"step":0}), cancellation.clone()));
        let b =
            tokio::spawn(second.invoke("echo".into(), json!({"step":0}), CancellationToken::new()));
        tokio::task::yield_now().await;
        cancellation.cancel();
        let (a, b) = tokio::time::timeout(Duration::from_secs(1), async {
            (a.await.unwrap(), b.await.unwrap())
        })
        .await
        .unwrap();
        assert!(matches!(a, Err(ToolError::Failed(_))));
        assert!(matches!(b, Err(ToolError::Failed(_))));
        assert_eq!(effects.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn checkpoint_waits_for_sample_and_accumulates_each_sessions_pause() {
        tokio::time::timeout(Duration::from_secs(1), async {
            let gate = StepGate::new(PathBuf::new(), 2);
            for _ in 0..2 {
                let before = [gate.paused_nanos(0), gate.paused_nanos(1)];
                let (entered, sampling) = tokio::sync::oneshot::channel();
                let (release, released) = tokio::sync::oneshot::channel();
                let a_gate = gate.clone();
                let a = tokio::spawn(async move {
                    a_gate
                        .checkpoint(0, &CancellationToken::new(), async {
                            entered.send(()).unwrap();
                            released.await.unwrap();
                        })
                        .await
                });
                let b_gate = gate.clone();
                let b = tokio::spawn(async move {
                    b_gate
                        .checkpoint(1, &CancellationToken::new(), async {
                            panic!("only Session zero samples");
                        })
                        .await
                });
                sampling.await.unwrap();
                assert!(!a.is_finished() && !b.is_finished());
                assert_eq!([gate.paused_nanos(0), gate.paused_nanos(1)], before);
                release.send(()).unwrap();
                a.await.unwrap().unwrap();
                b.await.unwrap().unwrap();
                assert!(gate.paused_nanos(0) > before[0]);
                assert!(gate.paused_nanos(1) > before[1]);
            }
        })
        .await
        .expect("successful sampling checkpoints must settle");
    }

    #[tokio::test]
    async fn peer_cancellation_waits_for_the_started_sample_to_really_finish() {
        tokio::time::timeout(Duration::from_secs(1), async {
            let gate = StepGate::new(PathBuf::new(), 2);
            let effects = Arc::new(AtomicUsize::new(0));
            let (entered, sampling) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            let a_gate = gate.clone();
            let a_effects = effects.clone();
            let a = tokio::spawn(async move {
                a_gate
                    .checkpoint(0, &CancellationToken::new(), async {
                        entered.send(()).unwrap();
                        released.await.unwrap();
                    })
                    .await?;
                a_effects.fetch_add(1, Ordering::Relaxed);
                Ok::<_, ToolError>(())
            });
            let cancellation = CancellationToken::new();
            let peer = Echo {
                effects: effects.clone(),
                gate: gate.clone(),
                index: 1,
            };
            let b =
                tokio::spawn(peer.invoke("echo".into(), json!({"step":0}), cancellation.clone()));
            sampling.await.unwrap();
            cancellation.cancel();
            assert!(matches!(b.await.unwrap(), Err(ToolError::Failed(_))));
            // The peer has observed cancellation and poisoned the shared gate,
            // but the sampling Session still owns its unfinished read.
            assert!(!a.is_finished());
            assert_eq!(effects.load(Ordering::Relaxed), 0);
            assert_eq!(gate.paused_nanos(0), 0);
            release.send(()).unwrap();
            assert!(matches!(a.await.unwrap(), Err(ToolError::Failed(_))));
            assert_eq!(effects.load(Ordering::Relaxed), 0);
            assert!(gate.paused_nanos(0) > 0);
            assert!(gate.paused_nanos(1) > 0);
        })
        .await
        .expect("cancelled sampling checkpoint must settle after its read finishes");
    }
}
