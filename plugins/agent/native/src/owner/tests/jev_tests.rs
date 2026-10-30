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
        outcome: OperationOutcome::Returned { value },
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
    json!({"state":{"ready":true},"questions":{"ready":{"type":"noul","instructions":"Is ready true?"}}})
}
async fn configure(f: &Fixture, url: &str, enabled: bool) -> Value {
    let current = snapshot(f).await;
    mutation(f, "save", json!({"revision":current["revision"],"settings":{"enabled":enabled,"url":url,"model":"fixture-jev","timeoutMs":8000}}), None).await
}
async fn credential(f: &Fixture, url: &str, target: Value, secret: Option<&str>) -> Value {
    let current = snapshot(f).await;
    mutation(f, "credential", json!({"url":url,"revision":current["credentialRevision"],"target":target,"change":if secret.is_some() {"replace"} else {"remove"}}), secret).await
}
async fn incoming(socket: &mut TcpStream) -> (String, Value) {
    http_fixture::read_request(socket).await
}

#[tokio::test]
async fn native_jev_evaluates_with_endpoint_credentials_and_revokes_inflight_access() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/decision", server.local_addr().unwrap());
        let other_url = format!("http://{}/other", server.local_addr().unwrap());
        let f = Fixture::with_services("http://127.0.0.1:1/v1", None, None, Some(service_tools::Setup::jev())).await;
        assert_eq!(snapshot(&f).await["settings"]["enabled"], false);
        configure(&f, &url, true).await;
        assert_eq!(credential(&f, &url, json!({"kind":"api_key"}), Some("jev-private-key")).await["kind"], "updated");
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
            assert_eq!(body["state"], evaluation()["state"]);
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
        assert!(!matches!(cancelled.receipt, Receipt::Recorded { outcome: OperationOutcome::Returned { value }, .. } if value["kind"] == "completed"));
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
async fn native_jev_choice_and_score_preserve_the_original_wire_values() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/decision", server.local_addr().unwrap());
        let f = Fixture::with_services("http://127.0.0.1:1/v1", None, None,
            Some(service_tools::Setup::jev())).await;
        configure(&f, &url, true).await;
        credential(&f, &url, json!({"kind":"api_key"}), Some("original-jev-key")).await;
        let input = json!({"state":{"original":"state"},"questions":{
            "choice":{"type":"choice","instructions":"Choose the last","criteria":{"first":null,"second":null}},
            "score":{"type":"score","instructions":"Use the last score","criteria":["zero","one"]}
        }});
        let reply = json!({"model":"fixture-jev","answers":{
            "choice":{"type":"choice","choice":"second","confidence":1.0,"probabilities":{"first":0.0,"second":1.0}},
            "score":{"type":"score","score":1.0,"confidence":1.0,"probabilities":{"0":0.0,"1":1.0},"legend":{"0":"zero","1":"one"}}
        },"usage":{"input_tokens":12,"output_tokens":3}});
        let (evaluated, ()) = tokio::join!(mutation(&f, "evaluate", input.clone(), None), async {
            let (mut socket, _) = server.accept().await.unwrap();
            let (_, observed) = incoming(&mut socket).await;
            assert_eq!(observed["state"], input["state"]);
            assert_eq!(observed["questions"], input["questions"]);
            let body = reply.to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        assert_eq!(evaluated["kind"], "completed");
        assert_eq!(evaluated["value"]["answers"], reply["answers"]);
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
