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
use maka_capabilities::call::ReadResource;
use maka_plugin_core::contract::ResourceType;
use std::ops::Range;

struct Secret(Vec<u8>);
impl ReadResource for Secret {
    fn encoding(&self) -> ResourceEncoding {
        ResourceEncoding::Utf8
    }
    fn resource_type(&self) -> ResourceType {
        text_resource_type()
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        json!({})
    }
    fn read(&self, range: Range<usize>) -> Result<Vec<u8>> {
        self.0
            .get(range)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| "invalid secret range".into())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_admission_and_original_secret_receipt_survive_independent_clients_and_restart() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let fixture = Fixture::new().await;
        let first = fixture.client().await;
        let second = fixture.client().await;
        let resource = |bytes| -> Attachments {
            Attachments::from([(
                "secret".into(),
                Arc::new(Secret(bytes)) as Arc<dyn ReadResource>,
            )])
        };
        let secret = || resource("k€y\\\"raw".as_bytes().to_vec());
        for (endpoint, method, resources, expected) in [
            ("agent", "selectBackend", Attachments::new(), "unsupported settings mutation method"),
            ("settings", "create", secret(), "settings mutation does not accept resources"),
            ("settings", "saveCredential", Attachments::new(), "settings credential requires one UTF-8 secret resource"),
        ] {
            assert_eq!(first.settings_mutation(Uuid::new_v4(), endpoint, method, Value::Null, resources).await.err().unwrap(), expected);
        }
        let mut extra = secret();
        extra.insert("extra".into(), Arc::new(Secret(vec![b'x'])));
        for (input, resources, expected) in [
            (json!({"credential":"unknown"}), Attachments::new(), "settings network credential action is invalid"),
            (json!({"credential":"keep"}), secret(), "settings mutation does not accept resources"),
            (json!({"credential":"replace"}), extra, "settings network credential requires one nonempty UTF-8 secret resource"),
            (json!({"credential":"replace"}), resource(vec![0xff]), "settings network credential requires one nonempty UTF-8 secret resource"),
        ] {
            let id = Uuid::new_v4();
            assert_eq!(first.settings_mutation(id, "settings", "updateNetwork", input, resources).await.err().unwrap(), expected);
            assert_eq!(first.operation(id).await.unwrap_err(), "original client operation not found for this Host");
        }
        let inexact = Uuid::new_v4();
        assert_eq!(first.mutation(inexact, "agent", "selectBackend", Value::Null, Attachments::new(), Some("session-one".into()), json!({"attempt":9_007_199_254_740_993u64})).await.err().unwrap(), "JSON integer cannot be represented exactly as a JavaScript Number");
        assert_eq!(first.operation(inexact).await.unwrap_err(), "original client operation not found for this Host");
        for (endpoint, method, session, correlation) in [
            ("agent", "selectBackend", Some("session-one".into()), json!({"kind":"agent-control"})),
            ("settings", "create", Some("session-one".into()), json!({"kind":"settings"})),
            ("settings", "create", None, json!({"kind":"settings","extra":true})),
        ] {
            let other = first.mutation(Uuid::new_v4(), endpoint, method, Value::Null, Attachments::new(), session, correlation).await.unwrap();
            assert_eq!(first.operation_for_settings(other.id()).await.unwrap_err(), "original client operation belongs to another settings owner");
            other.close().await.unwrap();
        }
        assert!(first.pending_settings().await.unwrap().is_empty());
        let (left, right) = tokio::join!(
            first.settings_mutation(Uuid::new_v4(), "settings", "updateAssistantPreferences", json!({"expectedRevision":0,"mutation":{"kind":"personalization","displayName":"private settings input"}}), Attachments::new()),
            second.settings_mutation(Uuid::new_v4(), "setup", "discoverModels", json!({"connectionId":"one"}), Attachments::new()),
        );
        let admitted = match (left, right) {
            (Ok(admitted), Err(error)) | (Err(error), Ok(admitted)) => {
                assert_eq!(error, "settings operation already exists or has an unresolved original");
                admitted
            }
            _ => panic!("exactly one independent settings client must be admitted"),
        };
        let original_id = admitted.id();
        assert_eq!(first.pending_requests().await + second.pending_requests().await, 1);
        for client in [&first, &second] {
            let pending = client.pending_settings().await.unwrap();
            assert_eq!(pending.iter().map(|operation| operation.id).collect::<Vec<_>>(), [original_id]);
            let target = client.describe(&pending[0].endpoint).await.unwrap();
            assert_eq!(pending[0].correlation, json!({"kind":"settings","owner":{"namespace":target.provider,"export":target.export}}));
            assert_eq!(client.recover(original_id).await.unwrap_err(), "client attempt has no confirmed preparation; it cannot be replayed");
        }
        let restarted = fixture.client().await;
        assert!(restarted.abandon_unprepared(original_id).await.unwrap().abandoned);
        assert_eq!(restarted.operation_for_settings(original_id).await.unwrap().id, original_id);
        assert!(admitted.prepare().await.is_err());
        assert_eq!(first.query("agent", "read", Value::Null).await.unwrap(), json!({"sent":0}));
        assert!(second.pending_settings().await.unwrap().is_empty());

        fixture.counter.blocked.store(true, Ordering::SeqCst);
        let id = Uuid::new_v4();
        let saved = first.settings_mutation(id, "settings", "saveCredential", json!({"expected":{"connectionId":"one"},"expectedCredential":null}), secret()).await.unwrap();
        let prepared = saved.prepare().await.unwrap();
        let fenced = restarted.abandon_unprepared(id).await.unwrap();
        assert!(!fenced.abandoned);
        assert_eq!(fenced.reference, prepared.reference);
        let mut confirmation = Box::pin(saved.confirm());
        tokio::select! {
            result = &mut confirmation => panic!("gated Settings returned early: {result:?}"),
            () = fixture.counter.started.notified() => {},
        }
        drop(confirmation);
        saved.disconnect().await;
        drop(saved);
        assert_eq!(second.settings_mutation(Uuid::new_v4(), "settings", "updateNetwork", json!({"credential":"keep"}), Attachments::new()).await.err().unwrap(), "settings operation already exists or has an unresolved original");
        fixture.counter.release.notify_one();
        loop {
            let recovered = restarted.recover(id).await.unwrap();
            if let Receipt::Recorded { outcome: OperationOutcome::Returned { value }, cleanup: OperationCleanup::Confirmed } = recovered.receipt {
                assert_eq!(value, json!({"sent":1}));
                assert_eq!(recovered.reference, prepared.reference.clone().unwrap());
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(fixture.counter.secrets.lock().unwrap().as_slice(), &[vec![107, 226, 130, 172, 121, 92, 34, 114, 97, 119]]);
        assert_eq!(first.pending_requests().await, 1, "receipt recovery does not acknowledge physical cleanup");
        assert_eq!(second.operation_for_settings(id).await.unwrap().id, id);
        assert!(second.pending_settings().await.unwrap().is_empty());
        assert_eq!(second.settings_mutation(id, "setup", "discoverModels", Value::Null, Attachments::new()).await.err().unwrap(), "settings operation already exists or has an unresolved original");
        fixture.counter.blocked.store(false, Ordering::SeqCst);
        let next = second.settings_mutation(Uuid::new_v4(), "setup", "discoverModels", Value::Null, Attachments::new()).await.unwrap();
        next.prepare().await.unwrap();
        assert!(matches!(next.confirm().await.unwrap().receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value == &json!({"sent":2})));
        assert_eq!(restarted.query("agent", "read", Value::Null).await.unwrap(), json!({"sent":2}));
        let preferences = json!({"expectedRevision":0,"mutation":{"kind":"language","preference":"zh-CN"}});
        let update = second.settings_mutation(Uuid::new_v4(), "settings", "updateAssistantPreferences", preferences.clone(), Attachments::new()).await.unwrap();
        update.prepare().await.unwrap();
        assert!(matches!(update.confirm().await.unwrap().receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value == &json!({"sent":3})));
        let network = json!({"expectedPolicyRevision":0,"expectedCredential":null,"networkProxy":{"enabled":true,"protocol":"http","host":"proxy.test","port":8080,"authEnabled":true,"username":"user","bypassList":[],"autoBypassDomains":[]},"credential":"replace"});
        let password = format!("{}x", "密".repeat(5_000)).into_bytes();
        let update = first.settings_mutation(Uuid::new_v4(), "settings", "updateNetwork", network.clone(), resource(password.clone())).await.unwrap();
        let prepared = update.prepare().await.unwrap();
        update.confirm().await.unwrap();
        let recovered = restarted.recover(update.id()).await.unwrap();
        assert_eq!(recovered.reference, prepared.reference.unwrap());
        assert!(matches!(recovered.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value == &json!({"sent":4})));
        for (index, action) in ["keep", "delete"].into_iter().enumerate() {
            let mut input = network.clone();
            input["credential"] = json!(action);
            if action == "delete" {
                input["networkProxy"]["authEnabled"] = json!(false);
            }
            let update = second.settings_mutation(Uuid::new_v4(), "settings", "updateNetwork", input, Attachments::new()).await.unwrap();
            update.prepare().await.unwrap();
            assert!(matches!(update.confirm().await.unwrap().receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { ref value }, .. } if value == &json!({"sent":index + 5})));
        }
        assert_eq!(&fixture.counter.messages.lock().unwrap()[2..4], &[preferences, network]);
        assert_eq!(fixture.counter.secrets.lock().unwrap().as_slice(), &["k€y\\\"raw".as_bytes().to_vec(), password]);
        let contexts = sqlx::query_scalar::<_, String>("SELECT context FROM operations")
            .fetch_all(&restarted.0.journal.pool).await.unwrap();
        for context in contexts {
            assert!(!context.contains("k€y"));
            assert!(!context.contains("密密"));
            assert!(!context.contains("private settings input"));
        }
        assert!(restarted.pending_settings().await.unwrap().is_empty());
        assert_eq!(restarted.query("agent", "read", Value::Null).await.unwrap(), json!({"sent":6}));
        first.close().await.unwrap();
        second.close().await.unwrap();
        restarted.close().await.unwrap();
        fixture.finish().await;
    }).await.unwrap();
}
