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
use maka_agent_ports::model::Events;
use tokio::sync::Semaphore;

fn budgeted_stream() -> (ModelStream, Arc<Semaphore>) {
    let budget = Arc::new(Semaphore::new(16 * 1024));
    let (sender, receiver) = mpsc::channel(4);
    let (activity, _) = tokio::sync::watch::channel(tokio::time::Instant::now());
    let events = ChannelEvents { sender, activity };
    let cancellation = CancellationToken::new();
    let producer_cancel = cancellation.clone();
    let producer_budget = budget.clone();
    let worker = tokio::spawn(async move {
        let produce = async {
            events
                .emit(
                    ModelEvent::PartStarted {
                        id: "text".into(),
                        text_kind: maka_agent_facts::model::TextKind::Text,
                        provider_options: None,
                    }
                    .into(),
                )
                .await?;
            for text in ["a", "b", "c"] {
                let reservation = producer_budget
                    .clone()
                    .acquire_many_owned(16 * 1024)
                    .await
                    .unwrap();
                events
                    .emit(Emission {
                        event: ModelEvent::PartDelta {
                            id: "text".into(),
                            text: text.repeat(16 * 1024),
                            provider_options: None,
                        },
                        reservation: Some(Arc::new(reservation)),
                    })
                    .await?;
            }
            events
                .emit(
                    ModelEvent::PartFinished {
                        id: "text".into(),
                        provider_options: None,
                    }
                    .into(),
                )
                .await?;
            events
                .emit(
                    ModelEvent::Finished {
                        reason: maka_agent_facts::model::ModelFinishReason::Stop,
                        usage: Default::default(),
                        provider_options: None,
                    }
                    .into(),
                )
                .await
        };
        tokio::select! {
            _ = producer_cancel.cancelled() => {},
            result = produce => { let _ = result; },
        }
        Ok(())
    });
    (
        ModelStream {
            receiver,
            cancellation,
            worker: Some(worker),
            cleanup: Ok(()),
            finished: false,
            pending_delta: None,
            ended: false,
        },
        budget,
    )
}

#[tokio::test]
async fn split_output_keeps_backpressure_until_consumed_and_exceeds_one_window() {
    tokio::time::timeout(Duration::from_secs(2), async {
        let (mut stream, budget) = budgeted_stream();
        let mut builder = StepBuilder::default();
        builder
            .push(stream.next().await.unwrap().unwrap().event)
            .unwrap();
        let first = stream.next().await.unwrap().unwrap();
        let second = stream.next().await.unwrap().unwrap();
        assert_eq!(budget.available_permits(), 0);
        builder.push(first.event).unwrap();
        drop(first.reservation);
        assert_eq!(
            budget.available_permits(),
            0,
            "another fragment still owns the bytes"
        );
        builder.push(second.event).unwrap();
        drop(second.reservation);
        while let Some(emission) = stream.next().await {
            let emission = emission.unwrap();
            builder.push(emission.event).unwrap();
        }
        stream.cancel_and_wait().await.unwrap();
        assert_eq!(budget.available_permits(), 16 * 1024);
        let output = builder.finish().unwrap();
        let [maka_agent_facts::model::ModelPart::Text { text, .. }] = output.parts.as_slice()
        else {
            panic!("one complete text part expected");
        };
        assert_eq!(
            text.chunks().collect::<String>(),
            format!(
                "{}{}{}",
                "a".repeat(16 * 1024),
                "b".repeat(16 * 1024),
                "c".repeat(16 * 1024)
            )
        );
    })
    .await
    .expect("output larger than its in-flight window must complete");
}

#[tokio::test]
async fn cancellation_releases_split_and_buffered_output_before_joining_producer() {
    tokio::time::timeout(Duration::from_secs(2), async {
        let (mut stream, budget) = budgeted_stream();
        stream.next().await.unwrap().unwrap();
        let fragment = stream.next().await.unwrap().unwrap();
        assert_eq!(budget.available_permits(), 0);
        drop(fragment);
        stream.cancel_and_wait().await.unwrap();
        assert_eq!(budget.available_permits(), 16 * 1024);
        let permit = budget.acquire_many_owned(16 * 1024).await.unwrap();
        drop(permit);
    })
    .await
    .expect("cancellation must release bytes and settle the producer");
}
