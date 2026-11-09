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
async fn binding(f: &Fixture) -> Binding {
    let client = f.app.client();
    client
        .bind(client.activation(&id(1)).unwrap(), "service".into())
        .await
        .unwrap()
        .remove(0)
}
async fn snapshot(f: &Fixture) -> Value {
    f.app
        .client()
        .start(
            binding(f).await,
            "snapshot".into(),
            json!({}),
            scope(&f.issuer, true),
            Attachments::new().into(),
        )
        .await
        .unwrap()
        .result()
        .await
        .unwrap()
}
async fn mutation(f: &Fixture, method: &str, input: Value, secret: Option<&str>) -> Value {
    let reply = mutation_reply(f, method, input, secret).await;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = reply.receipt
    else {
        panic!("Jev operation receipt: {:?}", reply.receipt);
    };
    value
}
async fn mutation_reply(
    f: &Fixture,
    method: &str,
    input: Value,
    secret: Option<&str>,
) -> maka_plugin_core::operation::OperationReply {
    let client = f.app.client();
    let attachments = secret
        .map(|value| {
            BTreeMap::from([(
                "secret".into(),
                Arc::new(Secret(value.into())) as Arc<dyn maka_capabilities::call::ReadResource>,
            )])
        })
        .unwrap_or_default();
    let prepared = client
        .prepare_mutation(
            binding(f).await,
            method.into(),
            input,
            scope(&f.issuer, true),
            Uuid::new_v4(),
            attachments.into(),
        )
        .await
        .unwrap();
    let reference = prepared.reference().clone();
    let recorded = f
        .store
        .record_application_intent(
            reference.source.clone(),
            prepared.consumer().instance().clone(),
            reference.clone(),
            Value::Null,
        )
        .await
        .unwrap();
    client
        .mutate(prepared, recorded)
        .await
        .unwrap()
        .result()
        .await
}

struct Secret(String);
impl maka_capabilities::call::ReadResource for Secret {
    fn resource_type(&self) -> maka_plugin_core::contract::ResourceType {
        maka_plugin_core::contract::ResourceType {
            name: "maka.text.utf8".into(),
            version: 1,
        }
    }
    fn bytes(&self) -> usize {
        self.0.len()
    }
    fn metadata(&self) -> Value {
        Value::Null
    }
    fn read(&self, range: std::ops::Range<usize>) -> Result<Vec<u8>, String> {
        Ok(self.0.as_bytes()[range].to_vec())
    }
}

fn evaluation() -> Value {
    json!({"input":{"ready":true},"questions":{"ready":{"type":"predicate","instructions":"Is ready true?"}}})
}
async fn configure(f: &Fixture, url: &str, enabled: bool) -> Value {
    let current = snapshot(f).await;
    mutation(f, "save", json!({"revision":current["revision"],"settings":{"protocol":"jev","enabled":enabled,"url":url,"model":"fixture-jev","timeoutMs":8000}}), None).await
}
async fn credential(f: &Fixture, url: &str, target: Value, secret: Option<&str>) -> Value {
    let current = snapshot(f).await;
    mutation(f, "credential", json!({"url":url,"revision":current["credentialRevision"],"target":target,"change":if secret.is_some() {"replace"} else {"remove"}}), secret).await
}
async fn incoming(socket: &mut TcpStream) -> (String, Value) {
    http_fixture::read_request(socket).await
}

#[tokio::test]
async fn native_decisions_api_evaluates_with_endpoint_credentials_and_revokes_inflight_access() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/decision", server.local_addr().unwrap());
        let other_url = format!("http://{}/other", server.local_addr().unwrap());
        let f = Fixture::with_services("http://127.0.0.1:1/v1", None, None, Some(service_tools::Setup::decisions_api())).await;
        assert_eq!(snapshot(&f).await["settings"]["enabled"], false);
        configure(&f, &url, true).await;
        assert_eq!(credential(&f, &url, json!({"kind":"api_key"}), Some("jev-private-key")).await["kind"], "updated");
        let source = f.app.source().unwrap();
        let prefix = maka_host_runtime::storage::instance_prefix(&source.state_domain, source.deployment, &id(21));
        let namespace = maka_plugin_core::storage::Namespace::new("maka.workspace.decisions_api", maka_plugin_core::scope::Scope::Profile).unwrap();
        let persisted = maka_host_runtime::storage::Storage::new(f.store.clone(), prefix.clone(), namespace.clone());
        let stored = maka_plugin_core::storage::Store::read(&persisted, "settings".into()).await.unwrap().unwrap();
        assert_eq!(stored.data.value().unwrap()["protocol"], "jev");
        let settings = maka_workspace_api::decisions_api::Settings { url: url.clone(), ..Default::default() };
        let stored_key = f.config.plugin_credential(namespace, format!("{prefix}{}", settings.credential_key())).await.unwrap().unwrap();
        assert!(stored_key.secret.unwrap().contains("jev-private-key"));
        let keyed = snapshot(&f).await;
        assert_eq!(credential(&f, &url, json!({"kind":"header","name":"X-Tenant"}), Some("jev-private-tenant")).await["kind"], "updated");
        assert_eq!(mutation(&f, "credential", json!({"url":url,"revision":keyed["credentialRevision"],"target":{"kind":"api_key"},"change":"remove"}), None).await["kind"], "changed");
        assert_eq!(credential(&f, &url, json!({"kind":"header","name":"Authorization"}), Some("conflicting-key")).await["kind"], "invalid");
        let (evaluated, ()) = tokio::join!(mutation(&f, "evaluate", evaluation(), None), async {
            let (mut socket, _) = server.accept().await.unwrap();
            let (headers, body) = incoming(&mut socket).await;
            assert!(headers.to_ascii_lowercase().contains("authorization: bearer jev-private-key"));
            assert!(headers.to_ascii_lowercase().contains("x-tenant: jev-private-tenant"));
            assert_eq!(body["model"], "fixture-jev");
            assert_eq!(body["state"], evaluation()["input"]);
            let body = json!({"model":"fixture-jev","answers":{"ready":{"type":"noul","noul":0.9}},"usage":{"input_tokens":12,"output_tokens":3}}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        assert_eq!(evaluated["kind"], "completed");
        assert_eq!(evaluated["value"]["usage"]["input_tokens"], 12);
        // A different path on the same host owns a different secret slot.
        configure(&f, &other_url, true).await;
        assert_eq!(snapshot(&f).await["configured"], false);
        assert_eq!(mutation(&f, "evaluate", evaluation(), None).await["kind"], "failed");
        assert!(tokio::time::timeout(Duration::from_millis(30), server.accept()).await.is_err());
        configure(&f, &url, true).await;
        let (redirected, ()) = tokio::join!(mutation(&f, "evaluate", evaluation(), None), async {
            let (mut socket, _) = server.accept().await.unwrap();
            incoming(&mut socket).await;
            socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {other_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        assert_eq!(redirected["kind"], "failed");
        assert!(tokio::time::timeout(Duration::from_millis(30), server.accept()).await.is_err());
        let (cancelled, ()) = tokio::join!(mutation_reply(&f, "evaluate", evaluation(), None), async {
            let (mut socket, _) = server.accept().await.unwrap();
            incoming(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 64000\r\n\r\n{").await.unwrap();
            credential(&f, &url, json!({"kind":"api_key"}), None).await;
            socket.write_all(b" ").await.unwrap();
            let mut buffer = [0; 1];
            assert!(matches!(socket.read(&mut buffer).await, Ok(0) | Err(_)));
        });
        assert!(!matches!(cancelled.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { result: OperationResult::Success { value } }, .. } if value["kind"] == "completed"));
        let current = snapshot(&f).await;
        assert_eq!(current["apiKeyConfigured"], false);
        assert_eq!(current["headerNames"], json!(["X-Tenant"]));
        let intents = f.store.application_intents(f.app.source().unwrap().deployment, id(1), 0, 128).await.unwrap();
        let wire = serde_json::to_string(&intents).unwrap();
        assert!(!wire.contains("jev-private-key") && !wire.contains("jev-private-tenant"));
        f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_decisions_api_jev_preserves_structured_criteria_and_legend() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/decision", server.local_addr().unwrap());
        let f = Fixture::with_services("http://127.0.0.1:1/v1", None, None,
            Some(service_tools::Setup::decisions_api())).await;
        configure(&f, &url, true).await;
        credential(&f, &url, json!({"kind":"api_key"}), Some("original-jev-key")).await;
        let input = json!({"input":{"original":"state"},"questions":{
            "choice":{"type":"choice","instructions":"Choose the last","choices":[{"value":"first"},{"value":"second"}]},
            "score":{"type":"score","instructions":"Use the last score","levels":[{"label":"zero"},{"label":"one","description":{"value":"one"}}]}
        }});
        let reply = json!({"model":"fixture-jev","answers":{
            "choice":{"type":"choice","choice":"second","confidence":1.0,"probabilities":{"first":0.0,"second":1.0}},
            "score":{"type":"score","score":1.0,"confidence":1.0,"probabilities":{"0":0.0,"1":1.0},"legend":{"0":"zero","1":{"label":"one","description":{"value":"one"}}}}
        },"usage":{"input_tokens":12,"output_tokens":3}});
        let (evaluated, ()) = tokio::join!(mutation(&f, "evaluate", input.clone(), None), async {
            let (mut socket, _) = server.accept().await.unwrap();
            let (_, observed) = incoming(&mut socket).await;
            assert_eq!(observed["state"], input["input"]);
            assert_eq!(observed["questions"]["score"]["criteria"], json!(["zero",{"label":"one","description":{"value":"one"}}]));
            let body = reply.to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        assert_eq!(evaluated["kind"], "completed");
        assert_eq!(evaluated["value"]["answers"]["score"]["legend"], reply["answers"]["score"]["legend"]);
        assert_eq!(evaluated["value"]["answers"]["choice"]["choice"], "second");
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}

#[tokio::test]
async fn native_decisions_api_openai_uses_typed_choices_and_preserves_partial_refusal() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1/decisions", server.local_addr().unwrap());
        let f = Fixture::with_services("http://127.0.0.1:1/v1", None, None, Some(service_tools::Setup::decisions_api())).await;
        let current = snapshot(&f).await;
        assert_eq!(mutation(&f,"save",json!({"revision":current["revision"],"settings":{"protocol":"openai_decisions","enabled":true,"url":url,"model":"gpt-6-luna","timeoutMs":8000}}),None).await["kind"],"updated");
        credential(&f,&url,json!({"kind":"api_key"}),Some("openai-private-key")).await;
        let input = json!({"input":{"ticket":"charged twice"},"questions":{
            "ready":{"type":"predicate","instructions":"Is this supported?"},
            "route":{"type":"choice","instructions":{"select":"boolean true"},"choices":[{"value":true},{"value":"true"}]}
        }});
        let (evaluated, ()) = tokio::join!(mutation(&f,"evaluate",input.clone(),None),async {
            let (mut socket,_) = server.accept().await.unwrap();
            let (headers,body) = incoming(&mut socket).await;
            assert!(headers.to_ascii_lowercase().contains("authorization: bearer openai-private-key"));
            assert_eq!(body["model"],"gpt-6-luna");
            assert_eq!(body["input"][0]["content"][0],json!({"type":"input_json","data":input["input"]}));
            assert_eq!(body["questions"][1]["choices"],json!([{"value":true},{"value":"true"}]));
            let body = json!({"model":"gpt-6-luna","answers":[{"type":"refusal","name":"ready"},{"type":"choice","name":"route","choice":true,"confidence":1.0,"probabilities":[{"value":true,"probability":1.0},{"value":"true","probability":0.0}]}],"usage":{"input_tokens":32,"output_tokens":0,"total_tokens":32,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":0}}}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        assert_eq!(evaluated["kind"],"completed");
        assert_eq!(evaluated["value"]["answers"]["ready"],json!({"type":"refusal"}));
        assert_eq!(evaluated["value"]["answers"]["route"]["choice"],true);
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
