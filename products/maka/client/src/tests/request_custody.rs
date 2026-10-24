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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_subscriptions_do_not_block_queries_or_controls_and_close_drains_every_owner() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let fixture = Fixture::new().await;
        let client = fixture.client().await;
        let mut retained = Vec::new();
        // Cross the former request-count ceiling on one real authenticated scope.
        // Reading the first item proves each handler is live before leaving it open.
        for index in 0..129 {
            let subscription = client
                .subscribe("agent", "watch", Value::Null)
                .await
                .unwrap();
            assert!(matches!(
                subscription.next().await.unwrap(),
                Some(SubscriptionEvent::Item(value)) if value == json!({"sent": 0})
            ));
            if index % 2 == 0 {
                // Losing the display handle must not lose the scope's cleanup custody.
                drop(subscription);
            } else {
                retained.push(subscription);
            }
        }
        assert_eq!(client.pending_requests().await, 129);
        assert_eq!(fixture.counter.watches_closed.load(Ordering::SeqCst), 0);

        assert_eq!(
            client.query("agent", "read", Value::Null).await.unwrap(),
            json!({"sent": 0})
        );
        let control = client
            .control(
                Uuid::new_v4(),
                "editQueue",
                json!({"sessionId": "session-one"}),
            )
            .await
            .unwrap();
        control.prepare().await.unwrap();
        let reply = control.confirm().await.unwrap();
        assert!(matches!(
            reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { value }, ..
            } if value == json!({"sent": 1})
        ));
        assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 1);
        assert_eq!(client.pending_requests().await, 129);

        client.close().await.unwrap();
        assert_eq!(client.pending_requests().await, 0);
        assert_eq!(fixture.counter.watches_closed.load(Ordering::SeqCst), 129);
        for subscription in retained {
            assert!(subscription.next().await.unwrap().is_none());
        }
        assert_eq!(
            client
                .query("agent", "read", Value::Null)
                .await
                .unwrap_err(),
            "client scope is closing"
        );
        fixture.finish().await;
    })
    .await
    .unwrap();
}
