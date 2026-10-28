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
async fn ui_bindings_retire_reads_keep_original_mutations_and_recover_after_reopening() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new().await;
        let parent = fixture.client().await;
        let instance = InstanceId(vec![Uuid::from_u128(4)]);
        let (child, imports) = parent.bind_ui(parent.source().clone(), instance.clone()).await.unwrap();
        let endpoint = &imports["counter"][0];
        assert_eq!(child.query(endpoint, "read", Value::Null).await.unwrap(), json!({"sent":0}));
        let watch = child.subscribe(endpoint, "watch", Value::Null).await.unwrap();
        assert!(matches!(watch.next().await.unwrap(), Some(SubscriptionEvent::Item(value)) if value == json!({"sent":0})));
        assert_eq!(child.query(endpoint, "read", json!({"fail":true})).await.unwrap_err(), "ordinary counter failure");
        assert!(!child.binding_retired());
        assert_eq!(fixture.counter.watches_closed.load(Ordering::SeqCst), 0);
        let unconfirmed = child.mutation(Uuid::new_v4(), endpoint, "send", Value::Null, Attachments::new(), None,
            json!({"kind":"ui", "instance":instance, "import":"counter", "index":0})).await.unwrap();
        unconfirmed.prepare().await.unwrap();
        unconfirmed.detach().await.unwrap();
        assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 0);
        assert!(parent.pending_ui(&instance).await.unwrap().is_empty());
        fixture.counter.blocked.store(true, Ordering::SeqCst);
        let id = Uuid::new_v4();
        let mutation = child.mutation(id, endpoint, "send", json!({"progress":true}), Attachments::new(), None,
            json!({"kind":"ui", "instance":instance, "import":"counter", "index":0})).await.unwrap();
        mutation.prepare().await.unwrap();
        assert!(matches!(mutation.next().await.unwrap(), Some(MutationEvent::Progress(_))));
        let original = tokio::spawn(async move { mutation.detach().await });
        fixture.counter.started.notified().await;
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let retirement = tokio::spawn({
            let child = child.clone();
            async move {
                let retiring = child.retire();
                tokio::pin!(retiring);
                assert!(futures_util::poll!(retiring.as_mut()).is_pending());
                entered.send(()).unwrap();
                retiring.await
            }
        });
        entered_rx.await.unwrap();
        assert!(child.query(endpoint, "read", Value::Null).await.is_err());
        assert!(!retirement.is_finished());
        let reopened = fixture.client().await;
        assert_eq!(reopened.pending_ui(&instance).await.unwrap().iter().map(|operation| operation.id).collect::<Vec<_>>(), [id]);
        assert!(reopened.operation_for_ui(&InstanceId(vec![Uuid::from_u128(99)]), id).await.is_err());
        let (replacement, routes) = parent.bind_ui(parent.source().clone(), instance.clone()).await.unwrap();
        assert_eq!(replacement.query(&routes["counter"][0], "read", Value::Null).await.unwrap(), json!({"sent":1}));
        fixture.counter.release.notify_one();
        original.await.unwrap().unwrap();
        retirement.await.unwrap().unwrap();
        let reply = reopened.recover(id).await.unwrap();
        assert!(matches!(&reply.receipt, Receipt::Recorded { outcome:OperationOutcome::Returned { value }, .. } if value == &json!({"kind":"saved"})));
        assert!(watch.next().await.unwrap().is_none());
        assert!(reopened.pending_ui(&instance).await.unwrap().is_empty());
        assert_eq!(reopened.recover(id).await.unwrap().reference, reply.reference);
        assert_eq!(child.recover(id).await.unwrap().reference, reply.reference);
        assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 1);
        let retained = replacement.subscribe(&routes["counter"][0], "watch", Value::Null).await.unwrap();
        assert!(matches!(retained.next().await.unwrap(), Some(SubscriptionEvent::Item(_))));
        parent.close().await.unwrap();
        assert!(retained.next().await.unwrap().is_none());
        assert_eq!(replacement.pending_requests().await, 0);
        reopened.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("UI service custody and recovery did not finish");
}
