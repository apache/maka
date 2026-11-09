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
use crate::owner::{
    driver_model::DriverModel,
    tests::{Fixture, model_interruption::cold_reopen},
};
use maka_agent_api::contract::BackendPreference;
use maka_agent_facts::{
    configuration::{
        CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis, ImageInput,
        ModelOverride, Patch, UpdateCatalogConnectionInput,
    },
    input::{DeliveredMessage, MessageInput},
    message::{MessageDisposition, Placement, RootSourceMessage},
};
use maka_agent_ports::model as protocol;
use maka_agent_state::{Admission, ContentBlob};
use maka_model::{ModelExecutor, ProviderAuth, ProviderConfig, ProviderKind};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

struct NoOpen {
    inner: protocol::Binding,
    opens: Arc<AtomicUsize>,
}
impl protocol::ProviderAdapter for NoOpen {
    fn recovery_contract(
        &self,
        kind: &protocol::ProviderKind,
        tools: &[Arc<maka_agent_facts::tools::ToolDefinition>],
    ) -> Option<protocol::RecoveryContract> {
        self.inner.recovery_contract(kind, tools)
    }
    fn continuation_cursor(
        &self,
        contract: &protocol::RecoveryContract,
        part: &maka_agent_facts::model::ModelPart,
    ) -> Option<Value> {
        self.inner.continuation_cursor(contract, part)
    }
    fn supports_item_acceptance(&self) -> bool {
        self.inner.supports_item_acceptance()
    }
    fn enforces_idle_timeout(&self) -> bool {
        self.inner.enforces_idle_timeout()
    }
    fn open(
        &self,
        _: protocol::Lifetime,
        _: CancellationToken,
    ) -> BoxFuture<'_, Result<Arc<dyn protocol::Session>, protocol::Error>> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Err(protocol::Error::Adapter(
                "preparation must not open a provider session".into(),
            ))
        })
    }
}

async fn retained(f: &Fixture, run: RunId, request: &RequestSpec) -> Vec<(ContentRef, Vec<u8>)> {
    let mut refs = vec![
        request.request.clone(),
        request.source_capture.clone(),
        request.provenance.clone(),
        request.recovery_contract.clone(),
    ];
    refs.extend(request.request_contents.clone());
    let mut result = Vec::new();
    for reference in refs {
        let bytes = f
            .owner
            .durable
            .content(run, reference.clone())
            .await
            .unwrap();
        result.push((reference, bytes));
    }
    result
}
async fn unchanged(f: &Fixture, run: RunId, expected: &[(ContentRef, Vec<u8>)]) {
    for (reference, bytes) in expected {
        assert_eq!(
            &f.owner
                .durable
                .content(run, reference.clone())
                .await
                .unwrap(),
            bytes
        );
    }
}
async fn frozen_connection(f: &Fixture, base: &str, enabled: bool, policy: ImageInput) {
    let row = f.config.catalog().await.unwrap().connections.remove(0);
    assert!(matches!(
        f.config
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: row.connection_id,
                    revision: row.revision
                },
                changes: ConnectionCatalogEntryUpdate {
                    name: None,
                    configuration: Some(json!({"baseUrl":base})),
                    enabled: Some(enabled),
                    enabled_model_ids: None,
                    model_overrides: Patch::Set(BTreeMap::from([(
                        "fixture-model".into(),
                        ModelOverride {
                            vision: Some(true),
                            code_mode: Some(false),
                            image_input: Some(policy),
                            ..Default::default()
                        }
                    )])),
                    request_body_overlay: Patch::Keep
                },
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed { .. }
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn released_request_rehydrates_its_original_input_after_new_publication() {
    tokio::time::timeout(Duration::from_secs(90),async{
        for with_image in [false,true]{
            let opens=Arc::new(AtomicUsize::new(0));let executor=ModelExecutor::new(Duration::from_secs(5)).unwrap();
            let provider=ProviderConfig{adapter:None,kind:ProviderKind::OpenaiChatCompletions,model:"fixture-model".into(),base_url:"http://127.0.0.1:1/v1".into(),auth:ProviderAuth::ApiKey("fixture".into()),headers:Default::default(),body_overlay:None,image_input:None,network:Default::default(),capabilities:Default::default()};
            let inner=executor.binding(&provider).unwrap();let source=inner.source().clone();
            let executor=executor.with_adapters(BTreeMap::from([("chat-completions".into(),protocol::Binding::new(Arc::new(NoOpen{inner,opens:opens.clone()}),source))]));
            let f=Fixture::new(&provider.base_url,Some(executor.clone())).await;
            let row=f.config.catalog().await.unwrap().connections.remove(0);
            let original_policy=ImageInput{mime_types:Some(vec!["image/png".into()]),max_bytes:Some(1024*1024),..Default::default()};
            assert!(matches!(f.config.update_connection(UpdateCatalogConnectionInput{expected:ConnectionVersionBasis{connection_id:row.connection_id,revision:row.revision},changes:ConnectionCatalogEntryUpdate{name:None,configuration:None,enabled:None,enabled_model_ids:None,model_overrides:Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride{vision:Some(true),code_mode:Some(false),image_input:Some(original_policy.clone()),..Default::default()})])),request_body_overlay:Patch::Keep}}).await.unwrap(),CatalogMutationResult::Committed{..}));
            let session=f.create("Frozen recovery authority").await;
            let mut input:MessageInput="original frozen question".into();
            if with_image{
                use image::ImageEncoder;
                use maka_agent_facts::artifact::{Artifact,ArtifactKind,ArtifactSource};
                let pixels=image::RgbImage::from_pixel(8,8,image::Rgb([23,41,67]));let mut png=Vec::new();
                image::codecs::png::PngEncoder::new(&mut png).write_image(pixels.as_raw(),8,8,image::ExtendedColorType::Rgb8).unwrap();
                let record=f.owner.durable.artifacts().upload(maka_agent_state::artifacts::Upload::new(
                    maka_agent_state::artifacts::SessionScope{owner:f.owner.run_owner(),session:session.clone()},"frozen-image-upload".into(),"frozen-image".into(),
                    Artifact{id:"frozen-image".into(),session_id:session.clone(),turn_id:"upload".into(),created_at:1,name:"original.png".into(),kind:ArtifactKind::Image,size_bytes:png.len() as u64,mime_type:Some("image/png".into()),source:ArtifactSource::UserUpload,summary:None},png,
                )).await.unwrap();
                input=serde_json::from_value(json!({"text":"original frozen question","attachments":[{"kind":"image","name":"original.png","mimeType":"image/png","bytes":record.payload.bytes,"ref":{"kind":"session_file","sessionId":session,"relativePath":record.artifact.id}}]})).unwrap();
            }
            let parent=f.issuer.issue_with(Identity::Remote{request_id:uuid::Uuid::new_v4()},true,CancellationToken::new()).unwrap();
            let basis=f.owner.capture_current_run(&session,Some(BackendPreference::Model{connection_id:f.selection().await.connection_id,model_id:"fixture-model".into(),thinking_level:None}),String::new(),&parent).await.unwrap();
            let message=RootSourceMessage{message:DeliveredMessage{message_id:"original-user-message".into(),submitted_content_digest:input.content_digest().unwrap(),content:input.clone(),origin:None},unprepared_content:input,submitted_placement:Placement::CurrentTurn,disposition:MessageDisposition::TurnStarted,submitted_intent:None};
            let (queued,contents)=f.owner.freeze_background_request(&session,message,&basis,BTreeSet::new(),"frozen-preparation",&parent).await.unwrap();drop(basis);
            let admission=Admission::new(queued.spec,UnixMillis(1),contents);let run=admission.run();f.owner.durable.admit(admission).await.unwrap();
            let original={
                let claim=f.owner.durable.claim(run).await.unwrap();let view=f.owner.durable.frontier(run).await.unwrap();
                let current=f.owner.mutable_session(&session).await.unwrap();let cancellation=CancellationToken::new();
                let (lease,effects)=f.owner.current_work_scope(&session,&current.configuration).await.unwrap().accept(cancellation.clone());
                let access=f.owner.run_access(Arc::new(view.spec.clone()),claim.clone(),&lease).unwrap();
                let state=f.owner.durable.with_data_writer(access.data_writer().unwrap()).unwrap();
                let (basis,selection)=f.owner.restored_data(&view).await.unwrap();
                                let catalog=f.owner.run_catalog(access.clone(),basis.mcp_catalog.as_ref().unwrap(),&selection).unwrap();
                let source=crate::model::Source::restore(f.owner.configuration.clone(),f.owner.credentials.clone(),basis.model.as_ref().unwrap().clone(),session.clone(),f.owner.revision.clone()).unwrap();
                let cleanup=Evidence::default();let workers=TaskTracker::new();let (preview,_)=tokio::sync::watch::channel(None);
                let model=DriverModel{state:state.clone(),log:Arc::new(lease.store()),source:Arc::new(source),executor:executor.clone(),resources:f.owner.services.model_preparation_resources(),execution:access.execution().clone(),cancellation:cancellation.clone(),cleanup:cleanup.clone(),workers:workers.clone(),original_cleanup:Default::default(),conversation:Default::default(),preview};
                let driver=NativeDriver::new(f.owner.clone(),state.clone(),access,catalog,basis.mcp_catalog.as_ref().unwrap().clone(),NativeBackend::Model{model,cells:None},cancellation,cleanup,workers);
                let prepared=DriverPorts::prepare_step(&driver,&view,Preparation::Initial).await.unwrap();let original=prepared.request.clone();
                let body=ContentBlob::json(&original).unwrap();let mut contents=prepared.contents;contents.push(body.clone());
                state.append(&claim,(&view).into(),vec![Change::new(Fact::StepPrepared{step:original.step,request:body.reference().clone(),adjudications:vec![]},UnixMillis(2))],contents).await.unwrap();
                assert!(driver.model().unwrap().step_tool_model(&state.frontier(run).await.unwrap(),&original).await.is_ok());
                driver.model().unwrap().finish().await.unwrap();drop(driver);effects.settle().await.unwrap();lease.finish();original
            };
            let bytes=retained(&f,run,&original).await;let before=f.owner.durable.history(run,0,256).await.unwrap();
            assert!(f.owner.durable.frontier(run).await.unwrap().attempts.is_empty());assert_eq!(opens.load(Ordering::SeqCst),0);
            drop(parent);
            let f=cold_reopen(f).await;
            let claim=f.owner.durable.claim(run).await.unwrap();let view=f.owner.durable.frontier(run).await.unwrap();
            let current=f.owner.mutable_session(&session).await.unwrap();let cancellation=CancellationToken::new();
            let (lease,effects)=f.owner.current_work_scope(&session,&current.configuration).await.unwrap().accept(cancellation.clone());
            let access=f.owner.run_access(Arc::new(view.spec.clone()),claim,&lease).unwrap();let state=f.owner.durable.with_data_writer(access.data_writer().unwrap()).unwrap();
            let (basis,selection)=f.owner.restored_data(&view).await.unwrap();
                        let catalog=f.owner.run_catalog(access.clone(),basis.mcp_catalog.as_ref().unwrap(),&selection).unwrap();
            let source=crate::model::Source::restore(f.owner.configuration.clone(),f.owner.credentials.clone(),basis.model.as_ref().unwrap().clone(),session.clone(),f.owner.revision.clone()).unwrap();let actual_mcp=basis.mcp_catalog.as_ref().unwrap().clone();drop(basis);
            let cleanup=Evidence::default();let workers=TaskTracker::new();let (preview,_)=tokio::sync::watch::channel(None);
            let model=DriverModel{state:state.clone(),log:Arc::new(lease.store()),source:Arc::new(source),executor:executor.clone(),resources:f.owner.services.model_preparation_resources(),execution:access.execution().clone(),cancellation:cancellation.clone(),cleanup:cleanup.clone(),workers:workers.clone(),original_cleanup:Default::default(),conversation:Default::default(),preview};
            let driver=NativeDriver::new(f.owner.clone(),state,access,catalog,actual_mcp,NativeBackend::Model{model,cells:None},cancellation,cleanup,workers);
            assert!(driver.catalog_for_request(&view,&original).await.is_ok(),"fresh real Root/Owner must first restore the original contract successfully");
            for gate in ["route","image_policy","current_model_role"]{
                let mut policy=original_policy.clone();if gate=="image_policy"{policy.max_bytes=Some(1);}
                let change=async{
                    frozen_connection(&f,if gate=="route"{"http://127.0.0.1:2/v1"}else{provider.base_url.as_str()},gate!="current_model_role",policy).await;
                    assert!(driver.catalog_for_request(&view,&original).await.is_err(),"actual changed {gate} must refuse recovery preparation before a new provider open");
                };
                let restore=async{
                    frozen_connection(&f,&provider.base_url,true,original_policy.clone()).await;
                    assert!(driver.catalog_for_request(&view,&original).await.is_ok(),"new preparation has actual authority again; only the denied original factory keeps its first refusal");
                };
                if gate=="image_policy"{change.await;restore.await;}else{
                    driver.model().unwrap().assert_frozen_build_rechecks_after_wait(&view,&original,driver.access.clone(),change,restore).await;
                }
                unchanged(&f,run,&bytes).await;assert_eq!(f.owner.durable.history(run,0,256).await.unwrap(),before);assert_eq!(opens.load(Ordering::SeqCst),0);
            }
            driver.model().unwrap().finish().await.unwrap();drop(driver);effects.settle().await.unwrap();lease.finish();
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn frozen_tools_ignore_later_loaded_names_and_require_current_permission_and_schema() {
    tokio::time::timeout(Duration::from_secs(90),async{
        for code in [false,true]{
            let opens=Arc::new(AtomicUsize::new(0));let executor=ModelExecutor::new(Duration::from_secs(5)).unwrap();
            let provider=ProviderConfig{adapter:None,kind:ProviderKind::OpenaiChatCompletions,model:"fixture-model".into(),base_url:"http://127.0.0.1:1/v1".into(),auth:ProviderAuth::ApiKey("fixture".into()),headers:Default::default(),body_overlay:None,image_input:None,network:Default::default(),capabilities:Default::default()};
            let inner=executor.binding(&provider).unwrap();let source=inner.source().clone();
            let executor=executor.with_adapters(BTreeMap::from([("chat-completions".into(),protocol::Binding::new(Arc::new(NoOpen{inner,opens:opens.clone()}),source))]));
            let f=Fixture::new(&provider.base_url,Some(executor.clone())).await;
            let deployment=f.app.source().unwrap().deployment;f.app.shutdown().await.unwrap();
            let loaded=f.store.load_application(deployment).await.unwrap().unwrap();let mut installed=loaded.source().input.clone();
            installed.instances.get_mut("provider").unwrap().configuration.values.insert("todo".into(),json!(true));
            f.store.commit_application(deployment,loaded.source().reference.revision,installed,loaded.source().remote_exports.clone(),loaded.packages().to_vec()).await.unwrap();drop(loaded);
            let f=cold_reopen(f).await;assert!(f.owner.settings.todo);
            let row=f.config.catalog().await.unwrap().connections.remove(0);
            assert!(matches!(f.config.update_connection(UpdateCatalogConnectionInput{expected:ConnectionVersionBasis{connection_id:row.connection_id,revision:row.revision},changes:ConnectionCatalogEntryUpdate{name:None,configuration:None,enabled:None,enabled_model_ids:None,model_overrides:Patch::Set(BTreeMap::from([("fixture-model".into(),ModelOverride{code_mode:Some(code),..Default::default()})])),request_body_overlay:Patch::Keep}}).await.unwrap(),CatalogMutationResult::Committed{..}));
            let roots=f.query("directories",json!({"kind":"roots"})).await.unwrap();
            let created=f.mutation(2,"create",json!({"title":"Frozen selected tool surface","labels":[],"workspace":{"kind":"directory","path":roots["roots"][0]["path"]},"tools":["todo_read"]}),uuid::Uuid::new_v4()).await.unwrap();
            let session=created["session"]["id"].as_str().unwrap().to_owned();
            let parent=f.issuer.issue_with(Identity::Remote{request_id:uuid::Uuid::new_v4()},true,CancellationToken::new()).unwrap();
            let basis=f.owner.capture_current_run(&session,Some(BackendPreference::Model{connection_id:f.selection().await.connection_id,model_id:"fixture-model".into(),thinking_level:None}),String::new(),&parent).await.unwrap();
            let input:MessageInput="read the checklist, without changing it".into();
            let message=RootSourceMessage{message:DeliveredMessage{message_id:"selected-tools-message".into(),submitted_content_digest:input.content_digest().unwrap(),content:input.clone(),origin:None},unprepared_content:input,submitted_placement:Placement::CurrentTurn,disposition:MessageDisposition::TurnStarted,submitted_intent:None};
            let (queued,contents)=f.owner.freeze_background_request(&session,message,&basis,BTreeSet::new(),"selected-tools-preparation",&parent).await.unwrap();drop(basis);
            let admission=Admission::new(queued.spec,UnixMillis(1),contents);let run=admission.run();f.owner.durable.admit(admission).await.unwrap();
            let original={
                let claim=f.owner.durable.claim(run).await.unwrap();let view=f.owner.durable.frontier(run).await.unwrap();
                let current=f.owner.mutable_session(&session).await.unwrap();let cancellation=CancellationToken::new();
                let (lease,effects)=f.owner.current_work_scope(&session,&current.configuration).await.unwrap().accept(cancellation.clone());
                let access=f.owner.run_access(Arc::new(view.spec.clone()),claim.clone(),&lease).unwrap();let state=f.owner.durable.with_data_writer(access.data_writer().unwrap()).unwrap();
                let (basis,selection)=f.owner.restored_data(&view).await.unwrap();
                                let catalog=f.owner.run_catalog(access.clone(),basis.mcp_catalog.as_ref().unwrap(),&selection).unwrap();
                let accepted=basis.model.as_ref().unwrap();let source=crate::model::Source::restore(f.owner.configuration.clone(),f.owner.credentials.clone(),accepted.clone(),session.clone(),f.owner.revision.clone()).unwrap();
                let cleanup=Evidence::default();let workers=TaskTracker::new();
                let cells=if code{Some(crate::owner::driver_cells::RunCells::new(f.owner.clone(),access.clone(),f.owner.code_executor.clone().with_language(accepted.code_language),workers.clone(),cleanup.clone()).unwrap())}else{None};
                let (preview,_)=tokio::sync::watch::channel(None);
                let model=DriverModel{state:state.clone(),log:Arc::new(lease.store()),source:Arc::new(source),executor:executor.clone(),resources:f.owner.services.model_preparation_resources(),execution:access.execution().clone(),cancellation:cancellation.clone(),cleanup:cleanup.clone(),workers:workers.clone(),original_cleanup:Default::default(),conversation:Default::default(),preview};
                let mut driver=NativeDriver::new(f.owner.clone(),state.clone(),access,catalog,basis.mcp_catalog.as_ref().unwrap().clone(),NativeBackend::Model{model,cells},cancellation,cleanup,workers);
                let prepared=DriverPorts::prepare_step(&driver,&view,Preparation::Initial).await.unwrap();let original=prepared.request.clone();
                let body=ContentBlob::json(&original).unwrap();let mut contents=prepared.contents;contents.push(body.clone());
                state.append(&claim,(&view).into(),vec![Change::new(Fact::StepPrepared{step:original.step,request:body.reference().clone(),adjudications:vec![]},UnixMillis(2))],contents).await.unwrap();
                let mut view=state.frontier(run).await.unwrap();
                let before=retained(&f,run,&original).await;let mut facts=state.history(run,0,256).await.unwrap();
                let selection:crate::tools::SelectionSnapshot=driver.decode(&view.spec.tool_selection).await.unwrap();
                assert_eq!(selection.definitions.iter().map(|tool|tool.name.as_str()).collect::<Vec<_>>(),vec!["todo_read"],"alpha is the actually admitted selected surface; beta remains unselected");
                let restored_catalog=driver.catalog_for_request(&view,&original).await.unwrap();
                if code{
                    let mut provenance:Value=driver.decode(&original.provenance).await.unwrap();
                    let contracts:BTreeMap<String,String>=serde_json::from_value(provenance["toolContracts"].clone()).unwrap();
                    let actual:BTreeMap<_,_>=restored_catalog.definitions().map(|tool|(tool.name.clone(),tool_contract_digest(tool).unwrap())).collect();
                    assert_eq!(contracts,actual,"T0 provenance must describe the real request-bound Input projection, not raw declarations or exec's schema");
                    let mut changed=restored_catalog.definitions().find(|tool|tool.name=="todo_read").unwrap().clone();
                    changed.input_schema=json!({"type":"object","properties":{"postbound_change":{"type":"boolean"}},"additionalProperties":false});
                    let changed_digest=tool_contract_digest(&changed).unwrap();assert_ne!(contracts["todo_read"],changed_digest);
                    provenance["toolContracts"]["todo_read"]=json!(changed_digest);
                    let proof=ContentBlob::json(&provenance).unwrap();
                    let mut trusted=original.clone();trusted.provenance=proof.reference().clone();
                    // Canonical preparation owns the new blob; the recovery
                    // subject keeps its original Step and all other fields.
                    let mut publication=trusted.clone();publication.step=StepId::new();
                    let contract=ContentBlob::json(&publication).unwrap();
                    state.append(&claim,(&view).into(),vec![Change::new(Fact::StepPrepared{step:publication.step,request:contract.reference().clone(),adjudications:vec![]},UnixMillis(3))],vec![proof,contract]).await.unwrap();
                    view=state.frontier(run).await.unwrap();facts=state.history(run,0,256).await.unwrap();
                    let published:Value=driver.decode(&trusted.provenance).await.unwrap();assert_eq!(published,provenance,"the new provenance has a valid original content SHA and canonical pin");
                    assert_eq!(trusted.composition,original.composition);assert_eq!(trusted.request,original.request);assert_eq!(trusted.request_contents,original.request_contents);
                    let mut unchanged_subject=trusted.clone();unchanged_subject.provenance=original.provenance.clone();assert_eq!(unchanged_subject,original);
                    let same_state=driver.catalog_for_request(&view,&original).await.unwrap();
                    let same_state_contracts:BTreeMap<_,_>=same_state.definitions().map(|tool|(tool.name.clone(),tool_contract_digest(tool).unwrap())).collect();
                    assert_eq!(same_state_contracts,contracts,"after the carrier changed current_step/head, the unchanged request must still prepare in this exact current scope");
                    let postbound_error=driver.catalog_for_request(&view,&trusted).await.err().expect("a changed bound Input contract must refuse new dispatch even with unchanged raw declarations and model-visible tools");
                    assert!(matches!(postbound_error,RunError::Preparation(ref error) if error.kind()==std::io::ErrorKind::PermissionDenied&&error.get_ref().is_some_and(|cause|cause.is::<SourceAuthorityChanged>())));
                    let raw:crate::tools::SelectionSnapshot=driver.decode(&view.spec.tool_selection).await.unwrap();assert_eq!(raw.definitions,selection.definitions);
                    unchanged(&f,run,&before).await;assert_eq!(state.history(run,0,256).await.unwrap(),facts);assert_eq!(opens.load(Ordering::SeqCst),0);assert!(view.attempts.is_empty()&&view.tools.is_empty());
                }
                let original_catalog=driver.catalog.clone();let mut beta=f.owner.todo.tools().into_iter().find(|tool|tool.definition.name=="todo_write").unwrap();
                beta.definition.input_schema=json!({"type":"object","properties":{"later_only":{"type":"boolean"}},"additionalProperties":false});
                driver.catalog=driver.catalog.excluding(&["todo_write"]).with_additional([beta]).unwrap();
                assert_ne!(driver.catalog.digest(),original_catalog.digest());
                assert!(driver.catalog_for_request(&view,&original).await.is_ok(),"unselected beta/current full catalog changes must not replace or invalidate the frozen selected subset");
                driver.catalog=original_catalog;
                let mut schema=original.clone();Arc::make_mut(&mut schema.composition.tools[0]).input_schema=json!({"type":"string"});
                schema.composition.tool_catalog_digest=maka_agent_engine::digest(&schema.composition.tools).unwrap();
                let schema_error=driver.catalog_for_request(&view,&schema).await.err().expect("self-consistent but different selected schema must be refused");
                assert!(matches!(schema_error,RunError::Preparation(ref error) if error.kind()==std::io::ErrorKind::PermissionDenied&&error.get_ref().is_some_and(|cause|cause.is::<SourceAuthorityChanged>())));
                let mut digest=original.clone();digest.composition.tool_catalog_digest=maka_agent_facts::artifact::content_digest(b"different selected catalog");
                let digest_error=driver.catalog_for_request(&view,&digest).await.err().expect("the original selected catalog digest is checked before reuse");
                assert!(matches!(digest_error,RunError::InvalidInput(ref message) if message=="frozen selected tool definitions differ from their digest"));
                unchanged(&f,run,&before).await;assert_eq!(state.history(run,0,256).await.unwrap(),facts);assert_eq!(opens.load(Ordering::SeqCst),0);assert!(view.attempts.is_empty()&&view.tools.is_empty());
                assert_eq!(state.request(run,original.step).await.unwrap(),original);
                let stored=f.store.get_session::<maka_agent_api::session::StoredSessionConfiguration>(&session).await.unwrap().unwrap();
                f.store.update_session_metadata::<maka_agent_api::session::StoredSessionConfiguration,_>(&session,stored.revision,|configuration|{
                    configuration.tools=Some(Vec::new());Ok(())
                }).await.unwrap();
                assert!(driver.access.live_configuration().await.is_ok(),"the same original claim and workspace remain live after tool-role narrowing");
                let model=maka_agent_engine::ModelSource::capture(driver.model().unwrap().source.as_ref()).await.unwrap();
                let next_bound=driver.bind_step_tools(&view,&model).await.unwrap();
                assert!(!next_bound.catalog.contains("todo_read"),"new Step capture must remove tools revoked from the current role");
                let next=DriverPorts::prepare_step(&driver,&view,Preparation::Initial).await.unwrap();
                assert_ne!(next.request.step,original.step);
                assert!(!next.request.composition.tools.iter().any(|tool|tool.name=="todo_read"));
                assert!(!driver.bind_step_tools(&view,&model).await.unwrap().catalog.contains("todo_read"));
                let old_error=driver.catalog_for_request(&view,&original).await.err().expect("narrowing after preparation rejects the original selected request rather than filtering its frozen bytes");
                assert!(matches!(old_error,RunError::Preparation(ref error) if error.kind()==std::io::ErrorKind::PermissionDenied&&error.get_ref().is_some_and(|cause|cause.is::<SourceAuthorityChanged>())));
                assert_eq!(state.request(run,original.step).await.unwrap(),original);assert_eq!(state.history(run,0,256).await.unwrap(),facts);
                drop(next);
                let stored=f.store.get_session::<maka_agent_api::session::StoredSessionConfiguration>(&session).await.unwrap().unwrap();
                f.store.update_session_metadata::<maka_agent_api::session::StoredSessionConfiguration,_>(&session,stored.revision,|configuration|{
                    configuration.tools=Some(vec!["todo_read".into()]);Ok(())
                }).await.unwrap();
                assert!(driver.catalog_for_request(&view,&original).await.is_ok());
                assert_eq!(opens.load(Ordering::SeqCst),0);
                driver.model().unwrap().finish().await.unwrap();drop(driver);effects.settle().await.unwrap();lease.finish();original
            };
            drop(parent);let before=retained(&f,run,&original).await;let records=f.owner.durable.history(run,0,256).await.unwrap();
            // No original T1 exists in this preparation-only case. Revoking a
            // tool must refuse new dispatch, not invalidate a stored SDK result.
            let deployment=f.app.source().unwrap().deployment;
            f.app.shutdown().await.unwrap();
            let loaded=f.store.load_application(deployment).await.unwrap().unwrap();let mut input=loaded.source().input.clone();
            input.instances.get_mut("provider").unwrap().configuration.values.insert("todo".into(),json!(false));
            f.store.commit_application(deployment,loaded.source().reference.revision,input,loaded.source().remote_exports.clone(),loaded.packages().to_vec()).await.unwrap();drop(loaded);
            let f=cold_reopen(f).await;
            assert!(!f.owner.settings.todo,"the fresh activation actually removed the selected current role");
            let claim=f.owner.durable.claim(run).await.unwrap();let view=f.owner.durable.frontier(run).await.unwrap();
            let current=f.owner.mutable_session(&session).await.unwrap();let cancellation=CancellationToken::new();
            let (lease,effects)=f.owner.current_work_scope(&session,&current.configuration).await.unwrap().accept(cancellation.clone());
            let access=f.owner.run_access(Arc::new(view.spec.clone()),claim,&lease).unwrap();let state=f.owner.durable.with_data_writer(access.data_writer().unwrap()).unwrap();
            let (basis,selection)=f.owner.restored_data(&view).await.unwrap();let accepted=basis.model.as_ref().unwrap();
                        let catalog=f.owner.run_catalog(access.clone(),basis.mcp_catalog.as_ref().unwrap(),&selection).unwrap();
            let source=crate::model::Source::restore(f.owner.configuration.clone(),f.owner.credentials.clone(),accepted.clone(),session.clone(),f.owner.revision.clone()).unwrap();
            let cleanup=Evidence::default();let workers=TaskTracker::new();
            let cells=if code{Some(crate::owner::driver_cells::RunCells::new(f.owner.clone(),access.clone(),f.owner.code_executor.clone().with_language(accepted.code_language),workers.clone(),cleanup.clone()).unwrap())}else{None};let actual_mcp=basis.mcp_catalog.as_ref().unwrap().clone();drop(basis);
            let (preview,_)=tokio::sync::watch::channel(None);
            let model=DriverModel{state:state.clone(),log:Arc::new(lease.store()),source:Arc::new(source),executor:executor.clone(),resources:f.owner.services.model_preparation_resources(),execution:access.execution().clone(),cancellation:cancellation.clone(),cleanup:cleanup.clone(),workers:workers.clone(),original_cleanup:Default::default(),conversation:Default::default(),preview};
            let driver=NativeDriver::new(f.owner.clone(),state,access,catalog,actual_mcp,NativeBackend::Model{model,cells},cancellation,cleanup,workers);
            let denied=driver.catalog_for_request(&view,&original).await.err().expect("a genuine new Root activation with the selected role removed must not re-advertise it");
            assert!(matches!(denied,RunError::Preparation(ref error) if error.kind()==std::io::ErrorKind::PermissionDenied&&error.get_ref().is_some_and(|cause|cause.is::<SourceAuthorityChanged>())));
            assert!(driver.access.live_configuration().await.is_ok(),"rejection is not an expired Owner, fake scope or dead claim");
            unchanged(&f,run,&before).await;assert_eq!(f.owner.durable.history(run,0,256).await.unwrap(),records);assert_eq!(opens.load(Ordering::SeqCst),0);
            driver.model().unwrap().finish().await.unwrap();drop(driver);effects.settle().await.unwrap();lease.finish();
            f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
        }
    }).await.unwrap();
}
