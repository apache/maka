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
async fn system_permission_controls_recover_each_grants_original_without_redispatch() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let fixture = Fixture::new().await;
        fixture.counter.blocked.store(true, Ordering::SeqCst);
        let client = fixture.client().await;
        let observer = fixture.client().await;
        let input = |grant| json!({
            "sessionId":"permission-session", "requestId":"permission-request", "grant":grant,
        });
        let target = client.describe("agent").await.unwrap();
        let correlation = |grant| json!({
            "kind":"agent-control", "owner":{"namespace":target.provider,"export":target.export},
            "requestId":"permission-request", "grant":grant,
        });
        let accessibility_id = Uuid::new_v4();
        let accessibility = client.control(accessibility_id, "requestSystemPermission", input("accessibility")).await.unwrap();
        let screen_id = Uuid::new_v4();
        let screen = observer.control(screen_id, "requestSystemPermission", input("screen_recording")).await.unwrap();
        for (id, grant) in [(accessibility_id,"accessibility"), (screen_id,"screen_recording")] {
            let original = observer.operation_for_control(id).await.unwrap();
            assert_eq!(original.session_id.as_deref(), Some("permission-session"));
            assert_eq!(original.method, "requestSystemPermission");
            assert_eq!(original.correlation, correlation(grant));
            // The captured ID cannot be opened as another action while unsettled.
            assert_eq!(observer.control(id, "requestSystemPermission", input(grant)).await.err().unwrap(),
                "client operation already exists; recover the original attempt");
        }
        let pending = observer.pending_controls().await.unwrap();
        assert_eq!(pending.len(), 2);
        for (grant, id) in [("accessibility", accessibility_id), ("screen_recording", screen_id)] {
            let same_grant = pending.iter().filter(|operation| {
                operation.method == "requestSystemPermission"
                    && operation.session_id.as_deref() == Some("permission-session")
                    && operation.correlation["requestId"] == "permission-request"
                    && operation.correlation["grant"] == grant
            }).map(|operation| operation.id).collect::<Vec<_>>();
            assert_eq!(same_grant, [id], "each grant recovers its own original control");
        }
        let prepared = accessibility.prepare().await.unwrap();
        let screen_prepared = screen.prepare().await.unwrap();
        assert_eq!(observer.operation_for_control(accessibility_id).await.unwrap().reference, prepared.reference);
        let mut confirmation = Box::pin(accessibility.confirm());
        tokio::select! {
            result = &mut confirmation => panic!("gated permission request returned early: {result:?}"),
            () = fixture.counter.started.notified() => {},
        }
        drop(confirmation);
        accessibility.disconnect().await.unwrap();
        let running = observer.recover(accessibility_id).await.unwrap();
        assert_eq!(running.reference, prepared.reference.clone().unwrap());
        assert!(!matches!(running.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { .. }, .. }));
        assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 1);
        assert_eq!(observer.pending_controls().await.unwrap().len(), 2);
        assert_eq!(observer.control(accessibility_id, "requestSystemPermission", input("screen_recording")).await.err().unwrap(),
            "client operation already exists; recover the original attempt");

        fixture.counter.release.notify_one();
        let recovered = loop {
            let reply = observer.recover(accessibility_id).await.unwrap();
            if matches!(reply.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { .. }, cleanup: OperationCleanup::Confirmed }) {
                break reply;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(recovered.reference, prepared.reference.clone().unwrap());
        assert!(matches!(recovered.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { result: OperationResult::Success { ref value } }, .. } if value == &json!({"sent":1})));
        assert_eq!(observer.pending_controls().await.unwrap().iter().map(|operation| operation.id).collect::<Vec<_>>(), [screen_id]);
        fixture.counter.blocked.store(false, Ordering::SeqCst);
        let screen_reply = screen.confirm().await.unwrap();
        assert_eq!(screen_reply.reference, screen_prepared.reference.clone().unwrap());
        assert!(matches!(screen_reply.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { result: OperationResult::Success { ref value } }, .. } if value == &json!({"sent":2})));
        assert!(observer.pending_controls().await.unwrap().is_empty());
        assert_eq!(fixture.counter.effects.load(Ordering::SeqCst), 2);
        screen.close().await.unwrap();
        drop(accessibility);
        client.close().await.unwrap();
        observer.close().await.unwrap();

        let reopened = fixture.client().await;
        for (id, grant, reference) in [
            (accessibility_id, "accessibility", prepared.reference.unwrap()),
            (screen_id, "screen_recording", screen_prepared.reference.unwrap()),
        ] {
            assert_eq!(reopened.operation_for_control(id).await.unwrap().correlation, correlation(grant));
            assert_eq!(reopened.recover(id).await.unwrap().reference, reference);
        }
        assert_eq!(reopened.query("agent", "read", Value::Null).await.unwrap(), json!({"sent":2}));
        assert!(reopened.pending_controls().await.unwrap().is_empty());
        reopened.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("system permission original control recovery timed out");
}
