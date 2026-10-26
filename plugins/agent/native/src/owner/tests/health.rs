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

pub(super) fn install(input: &mut Input, packages: &mut Vec<Package>) {
    let package = packages.last_mut().unwrap();
    let mut manifest = package.manifest().clone();
    let mut manifest_application = manifest.application.as_ref().unwrap().declaration().clone();
    manifest_application
        .entries
        .get_mut(&EntryTarget::Host)
        .unwrap()
        .imports
        .insert(
            "web".into(),
            Import {
                contract: maka_web_api::contract(),
                cardinality: Cardinality::One,
            },
        );
    let mut files = package.files().clone();
    files.insert(MANIFEST_FILE.into(), {
        manifest.application =
            Some(maka_plugin_core::package::CheckedDeclaration::new(manifest_application).unwrap());
        serde_json::to_vec(&manifest).unwrap()
    });
    *package = Package::new(files).unwrap();
    let node = input.instances.get_mut("service").unwrap();
    node.package = package.application_ref().into();
    node.bindings.insert(
        "web".into(),
        vec![Target::Instance {
            path: vec!["health-web".into()],
            export: maka_web_api::EXPORT.into(),
        }],
    );
    let web = Package::new(BTreeMap::from([(MANIFEST_FILE.into(), serde_json::to_vec(&json!({
        "schemaVersion":1,"id":"fixture.health-web","application":{"entries":{"host":{
            "implementation":{"kind":"native","implementation":maka_web_api::IMPLEMENTATION},
            "configuration":maka_web_api::configuration_schema(),"imports":{},
            "exports":{(maka_web_api::EXPORT):{"contract":maka_web_api::contract(),"availability":"required"}}
        }}}
    })).unwrap())])).unwrap();
    input.instances.insert(
        "health-web".into(),
        Node {
            key: Uuid::from_u128(22),
            package: web.application_ref().into(),
            use_package: PackageUse::Entry,
            configuration: NodeConfiguration {
                values: serde_json::from_value(json!({"network":"allowed"})).unwrap(),
                parameters: Default::default(),
            },
            parameters: Default::default(),
            disabled: false,
            overrides: vec![],
            bindings: Default::default(),
        },
    );
    packages.push(web);
}

#[cfg(target_os = "macos")]
mod acceptance {
    use super::super::processes::{call, finish, roundtrip};
    use super::*;
    use maka_agent_facts::interaction::{InteractionRecord, InteractionRequest};

    async fn pending(f: &Fixture, session: &str) -> InteractionRecord {
        let mut commits = f.session(session).await.subscribe_commits().unwrap();
        loop {
            if let Some(record) = f
                .session(session)
                .await
                .pending_interactions(session)
                .await
                .unwrap()
                .into_iter()
                .next()
            {
                return record;
            }
            commits.changed().await.unwrap();
        }
    }
    async fn permission(f: &Fixture, record: &InteractionRecord, allow: bool) {
        let InteractionRequest::Permissions { request, .. } = &record.request else {
            panic!("network permission")
        };
        let decision = if allow {
            json!({"decision":"allow","scope":"once","permissions":request.permissions})
        } else {
            json!({"decision":"deny"})
        };
        f.mutation(2, "respond", json!({"sessionId":record.session_id,"requestId":record.request_id,"answer":{"kind":"permissions","decision":decision}}),Uuid::new_v4()).await.unwrap();
    }
    async fn head(socket: &mut tokio::net::TcpStream) -> String {
        let mut bytes = vec![];
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(socket.read_u8().await.unwrap());
            assert!(bytes.len() < 8192);
        }
        String::from_utf8(bytes).unwrap()
    }
    async fn fixture() -> (TcpListener, Fixture, String, Value) {
        let model = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let f = Fixture::with_services(
            &format!("http://{}/v1", model.local_addr().unwrap()),
            None,
            None,
            Some(service_tools::Setup::health()),
        )
        .await;
        let session = f.create("Health").await;
        let process = roundtrip(
            &model,
            &f,
            &session,
            "Execute",
            json!({"command":"printf health-output","login":false,"run_in_background":true,"timeout_ms":5000}),
        )
        .await;
        assert_eq!(process["kind"], "completed", "{process}");
        let reference = process["value"]["ref"].clone();
        assert!(reference.is_string(), "{process}");
        // Shell state commits do not append model events. Subscribe before
        // reading so a process that settles after the model cannot strand us.
        let mut changes = f.store.subscribe_catalog_changes();
        let id = maka_host_runtime::shell::request::parse_ref(reference.as_str().unwrap()).unwrap();
        loop {
            changes.borrow_and_update();
            if !f
                .session(&session)
                .await
                .read_shell_run(&session, id)
                .await
                .unwrap()
                .unwrap()
                .state
                .active()
            {
                break;
            }
            changes.changed().await.unwrap();
        }
        (model, f, session, reference)
    }
    #[tokio::test]
    async fn health_model_checks_original_process_and_header_only_endpoint_across_restart() {
        tokio::time::timeout(Duration::from_secs(90),async {
            let (model,mut f,session,reference)=fixture().await;
            let endpoint=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url=format!("http://{}/health",endpoint.local_addr().unwrap());
            let plain=roundtrip(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference})).await;
            assert_eq!(plain["value"]["process"]["status"],"completed","{plain}");
            assert!(plain["value"]["process"].get("logs").is_none());
            assert_eq!(plain["value"]["endpoint"]["state"],"not_checked");
            call(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference,"url":url})).await;
            permission(&f,&pending(&f,&session).await,false).await;
            let denied=finish(&model,&f).await;
            assert_eq!(denied["value"]["endpoint"]["state"],"unknown","{denied}");
            assert!(tokio::time::timeout(Duration::from_millis(50),endpoint.accept()).await.is_err());
            call(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference,"url":url,"include_logs":true})).await;
            permission(&f,&pending(&f,&session).await,true).await;
            let (mut socket,_)=endpoint.accept().await.unwrap();
            assert!(head(&mut socket).await.starts_with("HEAD /health "));
            socket.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            drop(socket);
            // The fallback remains within the same target and original probe grant.
            let (mut socket,_)=endpoint.accept().await.unwrap();
            assert!(head(&mut socket).await.starts_with("GET /health "));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n").await.unwrap();
            let checked=finish(&model,&f).await;
            assert_eq!(checked["value"]["endpoint"]["health"],"healthy","{checked}");
            assert_eq!(checked["value"]["process"]["logs"]["stdout"],"health-output");
            assert_eq!(socket.read(&mut [0;1]).await.unwrap(),0);
            let deployment = f.app.source().unwrap().deployment;
            let prefix=f.session(&(session)).await.scoped_prefix(maka_agent_facts::event::LogScope::Session { id:session.clone() },256,4*1024*1024).await.unwrap();
            let event=prefix.events.iter().rev().find(|event|matches!(event.event.fact,maka_agent_facts::event::Fact::ToolSettled { .. })).unwrap();
            let maka_agent_facts::tool_output::ToolOutput::Operation(reply)=f.session(&session).await.resolve_tool_result(&session,&event.event.id).await.unwrap() else { panic!("original health receipt") };
            let original=reply.reference;
            assert_eq!(original.method,"health");
            let original_receipt = f.store.operation(&original).unwrap().operation_observation().await.unwrap().unwrap();
            f.app.shutdown().await.unwrap();
            let mut native = NativeRegistry::default();
            maka_settings_native::provide(&mut native, crate::owner::tests::bundled_catalog()).unwrap();
            provide_all(&mut native).unwrap();
            let policy = service_tools::Setup::health().policy();
            f.issuer = policy.issuer();
            f.app = Application::start_from_store(f.store.clone(), deployment, native, f.issuer.clone(), Arc::new(Grant(f.issuer.clone(), Some(policy))), Some(maka_host_js::factory(Default::default()))).await.unwrap();
            f.app.ready().await.unwrap();
            let client=f.app.client();
            let recovered=client.recover(client.activation(&id(1)).unwrap(),original,scope(&f.issuer,true)).await.unwrap().unwrap();
            assert_eq!(recovered,original_receipt);
            assert!(tokio::time::timeout(Duration::from_millis(50),endpoint.accept()).await.is_err());
            let restored=roundtrip(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference,"include_logs":true})).await;
            assert_eq!(restored["value"]["process"],checked["value"]["process"]);
            let foreign=f.create("Foreign").await;
            let rejected=roundtrip(&model,&f,&foreign,"BackgroundTaskHealth",json!({"ref":reference,"url":url})).await;
            assert_eq!(rejected["kind"],"failed","{rejected}");
            assert!(f.session(&foreign).await.pending_interactions(&foreign).await.unwrap().is_empty());
            assert!(tokio::time::timeout(Duration::from_millis(50),endpoint.accept()).await.is_err());
            f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
    #[tokio::test]
    async fn health_cancellation_withdraws_permission_and_closes_live_http_socket() {
        tokio::time::timeout(Duration::from_secs(90),async {
            let (model,f,session,reference)=fixture().await;
            let endpoint=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url=format!("http://{}/health",endpoint.local_addr().unwrap());
            let started=call(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference,"url":url})).await;
            pending(&f,&session).await;
            f.mutation(2,"stop",json!({"sessionId":session,"invocationId":started["invocationId"]}),Uuid::new_v4()).await.unwrap();
            f.drained().await;
            assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            assert!(tokio::time::timeout(Duration::from_millis(50),endpoint.accept()).await.is_err());
            let started=call(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference,"url":url})).await;
            permission(&f,&pending(&f,&session).await,true).await;
            let (mut socket,_)=endpoint.accept().await.unwrap();
            assert!(head(&mut socket).await.starts_with("HEAD /health "));
            f.mutation(2,"stop",json!({"sessionId":session,"invocationId":started["invocationId"]}),Uuid::new_v4()).await.unwrap();
            f.drained().await;
            assert_eq!(socket.read(&mut [0;1]).await.unwrap(),0);
            let facts=service_tools::facts(&f,&session).await;
            let operations:std::collections::BTreeSet<_>=facts.iter().filter_map(|fact|match fact {
                maka_agent_facts::event::Fact::ToolDispatched { name,operation_id,.. } if name=="Http"=>Some(operation_id), _=>None
            }).collect();
            assert_eq!(operations.len(),1);
            assert_eq!(facts.iter().filter(|fact|matches!(fact,maka_agent_facts::event::Fact::ToolSettled { operation_id,.. } if operations.contains(operation_id))).count(),1);
            let policy=f.config.runtime_policy().await.unwrap();
            f.config.set_privacy(policy.revision,maka_agent_facts::configuration::policy::PrivacyPolicy { incognito_active:true }).await.unwrap();
            let private=roundtrip(&model,&f,&session,"BackgroundTaskHealth",json!({"ref":reference,"url":url})).await;
            assert_eq!(private["value"]["endpoint"]["state"],"unknown","{private}");
            assert_eq!(private["value"]["process"]["status"],"completed");
            assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            assert!(tokio::time::timeout(Duration::from_millis(50),endpoint.accept()).await.is_err());
            f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
    #[tokio::test]
    async fn health_code_mode_keeps_redirects_as_independent_unknown_observations() {
        tokio::time::timeout(Duration::from_secs(90),async {
            let (model,f,session,reference)=fixture().await;
            super::super::selection::edit(&f,|changes| {
                changes.model_overrides=Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride { code_mode:Some(true), ..Default::default() })]));
            }).await;
            let endpoint=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let redirect=TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url=format!("http://{}/health",endpoint.local_addr().unwrap());
            call(&model,&f,&session,"exec",json!({"code":format!("text(await tools.BackgroundTaskHealth({}));",json!({"ref":reference,"url":url}))})).await;
            permission(&f,&pending(&f,&session).await,true).await;
            let (mut socket,_)=endpoint.accept().await.unwrap();
            assert!(head(&mut socket).await.starts_with("HEAD /health "));
            socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://{}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",redirect.local_addr().unwrap()).as_bytes()).await.unwrap();
            let (mut model_socket,_)=model.accept().await.unwrap();
            let outgoing=request(&mut model_socket).await;
            let encoded=outgoing["messages"].as_array().unwrap().iter().rev().find(|message|message["role"]=="tool").unwrap()["content"].as_str().unwrap();
            let lines:Vec<Value>=encoded.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
            assert_eq!(lines[0]["result"]["ok"],true,"{encoded}");
            assert_eq!(lines[1]["value"]["endpoint"]["httpStatus"],302);
            assert_eq!(lines[1]["value"]["endpoint"]["health"],"unknown");
            assert_eq!(lines[1]["value"]["process"]["status"],"completed");
            response(&mut model_socket).await; f.drained().await;
            assert!(tokio::time::timeout(Duration::from_millis(50),redirect.accept()).await.is_err());
            assert!(f.session(&session).await.pending_interactions(&session).await.unwrap().is_empty());
            f.app.shutdown().await.unwrap(); f.config.shutdown().await.unwrap();
        }).await.unwrap();
    }
}
