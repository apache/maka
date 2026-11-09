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
mod post_cleanup;
mod setup_tests;

async fn task_heads(f: &Fixture, session: &str) -> Vec<Value> {
    use maka_plugin_core::storage::Namespace;
    use sha2::{Digest, Sha256};
    let namespace = Namespace::new(
        maka_agent_api::acp::IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )
    .unwrap();
    let mut heads = Vec::new();
    for row in f.recorded_facts(session).await {
        let maka_agent_facts::durable::Fact::ExternalTaskPrepared {
            task, descriptor, ..
        } = row.fact
        else {
            continue;
        };
        let view = f.owner.durable.frontier(row.run).await.unwrap();
        assert!(
            view.run == row.run
                && view.spec.session_id == session
                && view.spec.owner == f.owner.run_owner(),
            "original Task Root affinity"
        );
        let state = view
            .external
            .as_ref()
            .filter(|state| state.task == task)
            .expect("original Task");
        assert!(
            state.descriptor == descriptor,
            "original prepared descriptor"
        );
        let bytes = f.owner.durable.content(row.run, descriptor).await.unwrap();
        let frozen: maka_agent_facts::executor::TaskDescriptor<Value> =
            serde_json::from_slice(&bytes).unwrap();
        assert!(
            frozen.protocol == maka_agent_facts::executor::NATIVE_TASK_PROTOCOL,
            "original native Task protocol"
        );
        let execution: maka_agent_facts::durable::ExecutionIdentity =
            serde_json::from_value(frozen.payload["request"]["execution"].clone()).unwrap();
        let raw_task: maka_agent_facts::durable::ExternalTaskId =
            serde_json::from_value(frozen.payload["request"]["taskId"].clone()).unwrap();
        assert!(
            raw_task == task
                && execution.run_id == row.run
                && execution.session_id == session
                && execution.turn_id == view.spec.turn_id,
            "original Task execution"
        );
        let Some(binding) = &state.binding else {
            continue;
        };
        let bytes = f
            .owner
            .durable
            .content(row.run, binding.clone())
            .await
            .unwrap();
        let bound: maka_agent_facts::executor::TaskDescriptor<Value> =
            serde_json::from_slice(&bytes).unwrap();
        assert!(
            bound.protocol == frozen.protocol
                && bound.source == frozen.source
                && bound.payload["request"] == frozen.payload["request"]
                && bound.payload["privateResource"] == frozen.payload["privateResource"],
            "original bound Task affinity"
        );
        let recovery = &bound.payload["recovery"];
        assert!(
            recovery["kind"] == "service",
            "original ACP service recovery"
        );
        let original = &recovery["original"];
        let reference: maka_plugin_core::operation::RecoveryRef =
            serde_json::from_value(original["reference"].clone()).unwrap();
        reference.validate().unwrap();
        assert!(
            original["task"] == serde_json::to_value(task).unwrap()
                && original["execution"] == serde_json::to_value(&execution).unwrap()
                && original["provider"] == serde_json::to_value(&reference.namespace).unwrap()
                && original["deployment"]
                    == serde_json::to_value(reference.source.deployment).unwrap()
                && original["export"].as_str() == Some(reference.export.as_str())
                && original["package"]["id"].as_str() == Some(frozen.source.package_id.as_str())
                && reference.export == frozen.source.entry_id
                && reference.method == "execute",
            "original full service reference"
        );
        let source = f.app.source().unwrap();
        assert!(
            reference.source.state_domain == source.state_domain
                && reference.source.deployment == source.deployment,
            "original deployment affinity"
        );
        let intent = f
            .store
            .application_intent(reference.source.deployment, id(1), reference.operation)
            .await
            .unwrap()
            .expect("original Agent caller intent");
        assert!(
            intent.reference == reference
                && intent.consumer == id(1)
                && intent.recovery == json!({"protocol":2,"taskId":task,"execution":execution}),
            "same original caller reference and recovery"
        );
        let scope = hex::encode(Sha256::digest(
            serde_json::to_vec(&(
                &reference.source.state_domain,
                reference.source.deployment,
                &reference.namespace,
            ))
            .unwrap(),
        ));
        let caller = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&intent.consumer, session)).unwrap(),
        ));
        let key = format!("{scope}/tasks/{caller}/{task}");
        let Some(record) = f
            .store
            .plugin_data(&namespace, &format!("{key}/head"))
            .await
            .unwrap()
        else {
            continue;
        };
        let input = f
            .store
            .plugin_data(&namespace, &format!("{key}/input"))
            .await
            .unwrap()
            .expect("original ACP input");
        let input: executor::Execute =
            serde_json::from_value(input.data.value().unwrap()["input"].clone()).unwrap();
        assert!(
            input.task_id == task && input.execution == execution,
            "same ACP journal Task"
        );
        let resource: maka_process::isolated::Descriptor =
            serde_json::from_value(frozen.payload["privateResource"].clone()).unwrap();
        let workspace = f.workspace.clone();
        let resource = tokio::task::spawn_blocking(move || {
            let proof: maka_process::isolated::SnapshotProof = serde_json::from_slice(
                &std::fs::read(resource.resource_ref.join("owner/snapshot.json"))
                    .expect("original protected snapshot"),
            )
            .expect("original snapshot metadata");
            let workspace = workspace.canonicalize().expect("owned fixture workspace");
            assert!(
                proof.source() == workspace.as_path()
                    && proof.resource_ref() == resource.resource_ref.as_path(),
                "original private snapshot affinity"
            );
            resource
        })
        .await
        .unwrap();
        // Test view joins the original pinned resource; production Head carries no locator.
        let mut head = record.data.value().unwrap().clone();
        head["resource_ref"] = serde_json::to_value(resource.resource_ref).unwrap();
        heads.push(head);
    }
    heads
}
async fn trace_text(f: &Fixture, session: &str, trace: &std::path::Path) -> String {
    let heads = task_heads(f, session).await;
    let name = trace.file_name().unwrap().to_owned();
    tokio::task::spawn_blocking(move || {
        let mut text = String::new();
        for head in heads {
            let resource = head["resource_ref"]
                .as_str()
                .expect("original pinned private resource");
            let path = std::path::Path::new(resource).join("tmp").join(&name);
            if path.exists() {
                text.push_str(&std::fs::read_to_string(path).unwrap());
            }
        }
        text
    })
    .await
    .unwrap()
}
fn blocker_kind(reason: &maka_agent_facts::durable::BlockerKind) -> &'static str {
    use maka_agent_facts::durable::BlockerKind;
    match reason {
        BlockerKind::ExternalPublicationUnavailable { .. } => "ExternalPublicationUnavailable",
        BlockerKind::ExternalPublicationItem { .. } => "ExternalPublicationItem",
        BlockerKind::CurrentAuthorityUnavailable { .. } => "CurrentAuthorityUnavailable",
        BlockerKind::ExternalEffectUnknown { .. } => "ExternalEffectUnknown",
        BlockerKind::OperationUnknown { .. } => "OperationUnknown",
        BlockerKind::ProviderEffectUnknown { .. } => "ProviderEffectUnknown",
        BlockerKind::OriginalAdmissionUnknown { .. } => "OriginalAdmissionUnknown",
        BlockerKind::CodeCellRecoveryUnavailable { .. } => "CodeCellRecoveryUnavailable",
        BlockerKind::UnsupportedProtocol { .. } => "UnsupportedProtocol",
        BlockerKind::ToolCleanupUnconfirmed { .. } => "ToolCleanupUnconfirmed",
        BlockerKind::CleanupUnconfirmed { .. } => "CleanupUnconfirmed",
        BlockerKind::ResourcesUnavailable { .. } => "ResourcesUnavailable",
        BlockerKind::ExternalTaskUnobservable { .. } => "ExternalTaskUnobservable",
    }
}
async fn classify_form_timeout(
    f: &Fixture,
    session: &str,
    run: maka_agent_facts::durable::RunId,
) -> Result<(), &'static str> {
    let head = f
        .owner
        .durable
        .frontier(run)
        .await
        .map_err(|_| "original frontier unavailable")?;
    if head.run != run || head.spec.session_id != session || head.spec.owner != f.owner.run_owner()
    {
        return Err("original frontier identity mismatch");
    }
    let task = head
        .external
        .as_ref()
        .filter(|task| task.admitted)
        .ok_or("original admitted Task missing")?;
    let bytes = f
        .owner
        .durable
        .content(run, task.descriptor.clone())
        .await
        .map_err(|_| "original Task descriptor unavailable")?;
    let frozen: maka_agent_facts::executor::TaskDescriptor<Value> =
        serde_json::from_slice(&bytes).map_err(|_| "original Task descriptor invalid")?;
    let request = &frozen.payload["request"];
    let raw_task: maka_agent_facts::durable::ExternalTaskId =
        serde_json::from_value(request["taskId"].clone())
            .map_err(|_| "original request Task invalid")?;
    let execution: maka_agent_facts::durable::ExecutionIdentity =
        serde_json::from_value(request["execution"].clone())
            .map_err(|_| "original request execution invalid")?;
    if raw_task != task.task
        || execution.run_id != run
        || execution.session_id != session
        || execution.turn_id != head.spec.turn_id
    {
        return Err("original request identity mismatch");
    }
    let resource: maka_process::isolated::Descriptor =
        serde_json::from_value(frozen.payload["privateResource"].clone())
            .map_err(|_| "original private resource invalid")?;
    let evidence = maka_process::isolated::closed_evidence(&resource)
        .await
        .map_err(|_| "protected original evidence unavailable")?
        .ok_or("original group and streams closure missing")?;
    let workspace = f.workspace.clone();
    tokio::task::spawn_blocking(move || -> Result<(), &'static str> {
        use std::io::{Read, Seek, SeekFrom};
        let workspace = workspace.canonicalize().map_err(|_| "owned fixture workspace unavailable")?;
        if evidence.snapshot.source() != workspace.as_path()
            || evidence.snapshot.resource_ref() != resource.resource_ref.as_path() {
            return Err("original snapshot affinity mismatch");
        }
        if !matches!(&evidence.receipt, maka_process::isolated::TaskReceipt::Task { terminal_size: None, .. }) {
            return Err("original pipe receipt required");
        }
        let code_class = |code: Option<&Value>| match code {
            None => "absent",
            Some(Value::Number(code)) => match code.as_i64() {
                Some(-32700) => "ParseError",
                Some(-32600) => "InvalidRequest",
                Some(-32601) => "MethodNotFound",
                Some(-32602) => "InvalidParams",
                Some(-32603) => "InternalError",
                Some(-32800) => "RequestCancelled",
                Some(-32099..=-32000) => "ServerError",
                _ => "other",
            },
            Some(Value::String(code)) => match code.as_str() {
                "EACCES" => "EACCES", "EPERM" => "EPERM", "ENOENT" => "ENOENT",
                _ => "other",
            },
            Some(_) => "other",
        };
        let reason_class = |reason: Option<&str>| match reason {
            Some("IsolationUnavailable: ACP filesystem callbacks cannot write or read the Root; candidate publication requires known completion and a current Root FS effect") => "IsolationUnavailable",
            Some("ACP form execution changed") => "FormExecutionChanged",
            Some("ACP expected a form") => "ExpectedForm",
            Some("ACP form request rejected") => "FormRequestRejected",
            Some("agent_native_call_context_missing") => "NativeCallContextMissing",
            Some("interaction_native_call_mismatch") => "NativeCallMismatch",
            Some("form_requires_agent") => "FormRequiresAgent",
            Some("form_requires_tool") => "FormRequiresTool",
            Some("form_requires_mutation") => "FormRequiresMutation",
            Some("form_input_invalid") => "FormInputInvalid",
            Some("ACP service operation outcome or cleanup is unconfirmed") => "CallbackUnconfirmed",
            Some("ACP callback final receipt cleanup is unconfirmed") => "CallbackReceiptUnconfirmed",
            Some("ACP callback completion reference changed") => "CallbackReferenceChanged",
            Some("ACP call is closed or changed") => "CallClosedOrChanged",
            Some("Original runtime context is closed") => "RuntimeContextClosed",
            Some("Runtime role changed") => "RuntimeRoleChanged",
            _ => "other",
        };
        let trace_path = resource.resource_ref.join("tmp/acp-requests.jsonl");
        if let Ok(trace) = std::fs::File::open(trace_path) {
            let mut bytes = Vec::new();
            trace.take(65536).read_to_end(&mut bytes).map_err(|_| "original trace read failed")?;
            let mut initialized = 0;
            let mut responses = 0;
            for value in bytes.split(|byte| *byte == b'\n')
                .filter_map(|line| serde_json::from_slice::<Value>(line).ok()) {
                if value["method"] != "initialize" || initialized == 4 {
                    if value.get("method").is_none() && responses < 12 {
                        let id = match value["id"].as_str() {
                            Some("read-file") => "read-file",
                            Some("write-file") => "write-file",
                            Some("permission") => "permission",
                            _ => continue,
                        };
                        let kind = if value.get("error").is_some() { "error" }
                            else if value.get("result").is_some() { "result" } else { "other" };
                        eprintln!("acp callbacks: stage=owned_callback id={id} kind={kind} error_code={}",
                            code_class(value.get("error").and_then(|error| error.get("code"))));
                        if let Some(error) = value.get("error") {
                            eprintln!("acp callbacks: stage=owned_callback id={id} message_class={} data_class={}",
                                reason_class(error["message"].as_str()), reason_class(error["data"].as_str()));
                        }
                        responses += 1;
                    }
                    continue;
                }
                let classify = |field: &str| match value["params"]["clientCapabilities"]["fs"].get(field) {
                    None => "absent",
                    Some(Value::Bool(false)) => "false",
                    Some(Value::Bool(true)) => "true",
                    Some(_) => "other",
                };
                eprintln!("acp callbacks: stage=owned_initialize fs_read={} fs_write={}",
                    classify("readTextFile"), classify("writeTextFile"));
                initialized += 1;
            }
            if initialized == 0 { eprintln!("acp callbacks: stage=owned_initialize result=not_in_bounded_prefix"); }
        } else {
            eprintln!("acp callbacks: stage=owned_initialize result=trace_unavailable");
        }
        let mut stderr = evidence.stderr.ok_or("original pipe stderr missing")?;
        let size = stderr.metadata().map_err(|_| "original stderr metadata unavailable")?.len();
        let start = size.saturating_sub(16384);
        stderr.seek(SeekFrom::Start(start)).map_err(|_| "original stderr seek failed")?;
        let mut bytes = Vec::new();
        stderr.take(16384).read_to_end(&mut bytes).map_err(|_| "original stderr read failed")?;
        let bytes = if start == 0 { bytes.as_slice() } else {
            bytes.iter().position(|byte| *byte == b'\n').map_or(&[][..], |at| &bytes[at + 1..])
        };
        let text = String::from_utf8_lossy(bytes);
        let mut class = "other";
        for line in text.lines() {
            if line == "Error: Host read returned wrong contents" { class = "HostReadWrongContents"; break; }
            if line == "Error: Wrong permission response" { class = "WrongPermission"; break; }
            if line.starts_with("TypeError:") { class = "TypeError"; break; }
            if line.starts_with("SyntaxError:") { class = "SyntaxError"; break; }
            if line.starts_with("Error: EACCES:") || line.trim() == "code: 'EACCES'," { class = "EACCES"; break; }
            if line.starts_with("Error: EPERM:") || line.trim() == "code: 'EPERM'," { class = "EPERM"; break; }
            if line.starts_with("Error: ENOENT:") || line.trim() == "code: 'ENOENT'," { class = "ENOENT"; break; }
            if line == "Error: ACP form execution changed" { class = "FormExecutionChanged"; break; }
            if line == "Error: ACP expected a form" { class = "ExpectedForm"; break; }
            if let Some(error) = line.strip_prefix("Error: ")
                .and_then(|error| serde_json::from_str::<Value>(error).ok()) {
                class = reason_class(error["message"].as_str());
                eprintln!("acp callbacks: stage=owned_stderr data_class={}", reason_class(error["data"].as_str()));
                eprintln!("acp callbacks: stage=owned_stderr json_error_code={}", code_class(error.get("code")));
                break;
            }
        }
        eprintln!("acp callbacks: stage=owned_stderr class={class}");
        Ok(())
    }).await.map_err(|_| "original blocking reader failed")?
}
async fn setup(
    protocol: u8,
) -> (
    Fixture,
    TcpListener,
    std::path::PathBuf,
    maka_agent_api::acp::Configuration,
) {
    let fixture = Fixture::new("http://127.0.0.1:9/v1", None).await;
    let control = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let node = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(node.status.success());
    let trace = std::path::PathBuf::from("acp-requests.jsonl");
    let configuration = maka_agent_api::acp::Configuration {
        agent: maka_external_agent::Agent {
            id: "test.acp".into(),
            display_name: "Test ACP".into(),
            executable: String::from_utf8(node.stdout).unwrap().trim().into(),
            args: vec![
                "--input-type=module".into(),
                "--eval".into(),
                include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../../platform/host-runtime/tests/support/acp-agent.mjs"
                ))
                .into(),
                "acp-fixture".into(),
                trace.to_str().unwrap().into(),
                control.local_addr().unwrap().port().to_string(),
                protocol.to_string(),
            ],
            env: BTreeMap::new(),
        },
        permissions: None,
    };
    (fixture, control, trace, configuration)
}
#[tokio::test]
async fn native_acp_uses_fresh_private_tasks_and_canonical_history() {
    reuse(1).await;
}
#[tokio::test]
async fn native_acp_v2_uses_fresh_private_tasks_and_canonical_history() {
    reuse(2).await;
}
#[tokio::test]
async fn native_acp_continues_after_only_its_caller_is_reactivated() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, mut configuration) = setup(2).await;
        let node_directory = std::path::Path::new(&configuration.agent.executable)
            .parent()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        configuration.agent.executable = "node".into();
        configuration
            .agent
            .env
            .insert("PATH".into(), node_directory);
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP caller replacement").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let first = execute(&f, &session, "before replacement").await;
        let (_process, _) = control.accept().await.unwrap();
        f.drained().await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &first).await;
            if !matches!(
                observed["execution"]["state"]["kind"].as_str(),
                Some("admitted" | "running" | "waiting")
            ) {
                break observed;
            }
            changes.changed().await.unwrap();
        };
        if observed["execution"]["state"]["kind"] != "completed" {
            let diagnostic =
                tokio::time::timeout(Duration::from_secs(1), async {
                    let run = f.delivered_run(&first).await;
                    let head = f
                        .owner
                        .durable
                        .frontier(run)
                        .await
                        .map_err(|_| "original frontier unavailable")?;
                    if head.run != run
                        || head.spec.session_id != session
                        || head.spec.owner != f.owner.run_owner()
                    {
                        return Err("original frontier identity mismatch");
                    }
                    let task = head.external.as_ref().ok_or("original Task missing")?;
                    let cleanup = match &task.cleanup {
                        maka_plugin_core::operation::OperationCleanup::Confirmed => "Confirmed",
                        maka_plugin_core::operation::OperationCleanup::Unconfirmed => "Unconfirmed",
                        maka_plugin_core::operation::OperationCleanup::Failed { .. } => "Failed",
                    };
                    eprintln!(
                        "acp caller: stage=first_run_failure closed={} cleanup={cleanup}",
                        task.closed.is_some()
                    );
                    for blocker in head.blockers.values().filter(|blocker| {
                        blocker.decision.is_none() && blocker.resolved_by.is_none()
                    }) {
                        eprintln!(
                            "acp caller: stage=first_run_failure blocker_kind={}",
                            blocker_kind(&blocker.reason)
                        );
                        if let maka_agent_facts::durable::BlockerKind::ExternalPublicationUnavailable { diagnostic, .. } = &blocker.reason {
                            let class = match diagnostic.as_str() {
                                "original candidate capture capability is unavailable" => "CandidateCaptureUnavailable",
                                "captured Files publication capability is unavailable" => "FilesUnavailable",
                                "publication requires one unambiguous captured Files provider" => "FilesAmbiguous",
                                "foreign publication execution"
                                | "invalid execution input: foreign publication Run"
                                | "invalid execution input: publication belongs to another actual Root driver"
                                | "invalid execution input: foreign publication driver claim" => "ForeignRunOrDriver",
                                "original pending publication is unavailable"
                                | "original Pending publication is unavailable"
                                | "invalid execution input: publication has no original canonical Pending source"
                                | "invalid execution input: publication preparation is not the original pending obligation"
                                | "invalid execution input: publication has no canonical Pending source" => "PendingUnavailable",
                                "original native owner is closed"
                                | "invalid execution input: actual publication owner closed" => "OwnerClosed",
                                "invalid execution input: publication has no original executor task"
                                | "invalid execution input: publication requires the original known native closure"
                                | "invalid execution input: publication requires original known task closure" => "OriginalClosureUnavailable",
                                "invalid execution input: publication source differs from the actual Root workspace"
                                | "invalid execution input: publication source workspace or current permission epoch changed" => "RootWorkspaceOrEpochChanged",
                                "original preparation owner disappeared"
                                | "publication preparation worker panicked" => "PreparationOwnerFailed",
                                "original frozen publication material is unavailable" => "FrozenMaterialUnavailable",
                                "invalid execution input: publication differs from its exact original frozen manifest" => "FrozenManifestMismatch",
                                "execution cancelled" => "Cancelled",
                                _ => "Other",
                            };
                            eprintln!("acp caller: stage=first_run_failure publication_class={class}");
                        }
                    }
                    Ok(())
                })
                .await
                .unwrap_or(Err("original frontier deadline elapsed"));
            if let Err(reason) = diagnostic {
                eprintln!("acp caller: stage=first_run_failure guard_failed={reason}");
            }
        }
        assert_eq!(observed["execution"]["state"]["kind"], "completed");
        let client = f.app.client();
        let caller = client.activation(&id(1)).unwrap();
        let backend = client.activation(&id(21)).unwrap();
        let processes = client.activation(&id(22)).unwrap();
        let loaded = f
            .store
            .load_application(f.app.source().unwrap().deployment)
            .await
            .unwrap()
            .unwrap();
        let (loaded_source, loaded_packages, _, _) = loaded.into_parts();
        let mut input = loaded_source.input;
        input
            .instances
            .get_mut("provider")
            .unwrap()
            .configuration
            .values
            .insert("toolDiscovery".into(), json!(true));
        let source = f
            .store
            .commit_application(
                loaded_source.reference.deployment,
                loaded_source.reference.revision,
                input,
                vec![],
                loaded_packages,
            )
            .await
            .unwrap();
        f.app.adopt_committed(source).await.unwrap();
        f.app.ready().await.unwrap();
        assert_ne!(client.activation(&id(1)).unwrap(), caller);
        assert_eq!(client.activation(&id(21)).unwrap(), backend);
        assert_eq!(client.activation(&id(22)).unwrap(), processes);
        let mut changes = f.owner.durable.subscribe().unwrap();
        let next = execute(&f, &session, "after replacement").await;
        let (_next_process, _) = control.accept().await.unwrap();
        loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &next).await;
            match observed["execution"]["state"]["kind"].as_str() {
                Some("running" | "admitted" | "waiting") => {
                    changes.changed().await.unwrap();
                }
                _ => {
                    assert_eq!(
                        observed["execution"]["state"]["kind"], "completed",
                        "{observed}"
                    );
                    break;
                }
            }
        }
        let requests = trace_text(&f, &session, &trace).await;
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            requests.iter().filter(|v| v["method"] == "spawn").count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|v| v["method"] == "session/new")
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|v| v["method"] == "session/prompt")
                .count(),
            2
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
async fn reuse(protocol: u8) {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut fixture, control, trace, configuration) = setup(protocol).await;
        activate_backend(
            &mut fixture,
            true,
            None,
            true,
            Some(configuration.clone()),
            &[],
        )
        .await;
        let session = fixture.create("ACP native").await;
        super::super::files::change(&fixture, &session, "danger_full_access", false, false).await;
        for text in ["first", "second", "third"] {
            if text == "third" {
                activate_backend(
                    &mut fixture,
                    false,
                    None,
                    true,
                    Some(configuration.clone()),
                    &[],
                )
                .await;
            }
            let accepted = execute(&fixture, &session, text).await;
            let (stream, _) = control.accept().await.unwrap();
            let mut stream = tokio::io::BufReader::new(stream);
            let mut pid = String::new();
            tokio::io::AsyncBufReadExt::read_line(&mut stream, &mut pid)
                .await
                .unwrap();
            fixture.drained().await;
            let mut changes = fixture.owner.durable.subscribe().unwrap();
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&fixture, &session, &accepted).await;
                if !matches!(
                    observed["execution"]["state"]["kind"].as_str(),
                    Some("admitted" | "running" | "waiting")
                ) {
                    break observed;
                }
                changes.changed().await.unwrap();
            };
            assert_eq!(
                observed["execution"]["state"]["kind"], "completed",
                "{observed}"
            );
            let (_, _, answer) = external_result(&fixture, &session, &accepted).await;
            assert_eq!(answer, format!("answer {text}"));
        }
        let requests = trace_text(&fixture, &session, &trace).await;
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for method in [
            "spawn",
            "initialize",
            "session/new",
            "session/prompt",
            "private_context",
        ] {
            assert_eq!(
                requests.iter().filter(|v| v["method"] == method).count(),
                3,
                "one {method} per task"
            );
        }
        assert!(!requests.iter().any(|v| matches!(
            v["method"].as_str(),
            Some("session/load" | "session/resume")
        )));
        let contexts: Vec<_> = requests
            .iter()
            .filter(|v| v["method"] == "private_context")
            .collect();
        for context in &contexts {
            assert_ne!(context["cwd"], json!(fixture.workspace));
            assert!(
                context["historyFile"]
                    .as_str()
                    .unwrap()
                    .ends_with(maka_agent_authority::executor::HISTORY_FILE)
            );
            assert_ne!(
                context["home"].as_str(),
                std::env::var("HOME").ok().as_deref()
            );
        }
        for pair in contexts.windows(2) {
            assert_ne!(pair[0]["home"], pair[1]["home"]);
            assert_ne!(pair[0]["cwd"], pair[1]["cwd"]);
        }
        assert!(
            contexts[1]["history"]
                .as_str()
                .unwrap()
                .contains("answer first")
        );
        assert!(
            contexts[2]["history"]
                .as_str()
                .unwrap()
                .contains("answer second")
        );
        assert!(
            !fixture.workspace.join(&trace).exists(),
            "private trace is not copied back"
        );
        fixture.app.shutdown().await.unwrap();
        fixture.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn execute(f: &Fixture, session: &str, text: &str) -> Value {
    let result = f.mutation(2,"send",json!({"sessionId":session,"message":text,"backend":{"kind":"executor","selection":{"executor":"external","settings":{}}}}),Uuid::new_v4()).await.unwrap();
    assert_eq!(result["kind"], "queued", "{result}");
    assert_eq!(result["sessionId"], session);
    assert!(result["messageId"].is_string());
    result
}
async fn form(f: &Fixture, session: &str) -> maka_agent_facts::interaction::InteractionRecord {
    form_with_original(f, session, None).await
}
async fn form_with_original(
    f: &Fixture,
    session: &str,
    run: Option<maka_agent_facts::durable::RunId>,
) -> maka_agent_facts::interaction::InteractionRecord {
    let mut changes = f.owner.durable.interactions().subscribe().unwrap();
    loop {
        if let Some(record) = f
            .owner
            .durable
            .interactions()
            .pending(session)
            .await
            .unwrap()
            .records
            .into_iter()
            .find(|r| {
                matches!(
                    r.request,
                    maka_agent_facts::interaction::InteractionRequest::Form { .. }
                )
            })
        {
            return record;
        }
        let changed = tokio::time::timeout(Duration::from_secs(10), changes.changed()).await;
        if changed.is_err()
            && let Some(run) = run
        {
            let diagnostic = tokio::time::timeout(
                Duration::from_secs(1),
                classify_form_timeout(f, session, run),
            )
            .await
            .unwrap_or(Err("original evidence deadline elapsed"));
            if let Err(reason) = diagnostic {
                eprintln!("acp callbacks: stage=form_timeout guard_failed={reason}");
            }
        }
        changed.expect("ACP form did not arrive").unwrap();
    }
}
#[tokio::test]
async fn native_acp_callbacks_have_distinct_writes_and_cancel_the_original_form() {
    tokio::time::timeout(Duration::from_secs(90), async {
        eprintln!("acp callbacks: stage=setup_enter");
        let (mut f, control, _trace, configuration) = setup(1).await;
        eprintln!("acp callbacks: stage=setup_return");
        activate_backend(&mut f,true,None,true,Some(configuration), &[]).await;
        eprintln!("acp callbacks: stage=activated");
        let session = f.create("ACP callbacks").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        std::fs::write(f.workspace.join("input.txt"),"fixture contents\n").unwrap();
        for (round, text) in ["callbacks","callbacks","peer-cancel"].into_iter().enumerate() {
            eprintln!("acp callbacks: round={round} stage=send_enter");
            let accepted = execute(&f,&session,text).await;
            eprintln!("acp callbacks: round={round} stage=queued_return");
            eprintln!("acp callbacks: round={round} stage=delivery_enter");
            let actual_run = f.delivered_run(&accepted).await;
            eprintln!("acp callbacks: round={round} stage=delivery_return");
            let mut notices = f.owner.durable.subscribe()
                .unwrap_or_else(|_| panic!("ACP canonical notice unavailable"));
            let accepting = control.accept();
            tokio::pin!(accepting);
            let mut last_level = None;
            let (mut process,_) = loop {
                notices.borrow_and_update();
                let head = tokio::select! {
                    biased;
                    result = &mut accepting => break result
                        .unwrap_or_else(|_| panic!("ACP control accept failed")),
                    result = f.owner.durable.frontier(actual_run) => result
                        .unwrap_or_else(|_| panic!("ACP original Run frontier unavailable")),
                };
                assert!(head.run == actual_run, "ACP must observe the original Delivered Run");
                assert!(head.spec.session_id == session, "ACP must observe the original session");
                assert!(head.spec.owner == f.owner.run_owner(), "ACP must observe the original owner");
                use maka_agent_api::contract::ExecutionState;
                let state = match super::super::super::execution::project(&head).state {
                    ExecutionState::Admitted => "Admitted",
                    ExecutionState::Running => "Running",
                    ExecutionState::Waiting { .. } => "Waiting",
                    ExecutionState::Blocked { .. } => "Blocked",
                    ExecutionState::Completed => "Completed",
                    ExecutionState::Failed => "Failed",
                    ExecutionState::Cancelled => "Cancelled",
                };
                let blocker_kinds: Vec<_> = head.blockers.values()
                    .filter(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
                    .map(|blocker| blocker_kind(&blocker.reason)).collect();
                let external = head.external.as_ref();
                let level = (state, head.stopped, external.is_some(),
                    external.is_some_and(|task| task.admitted),
                    external.is_some_and(|task| task.binding.is_some()),
                    external.is_some_and(|task| task.closed.is_some()), blocker_kinds);
                if last_level.as_ref() != Some(&level) {
                    eprintln!("acp callbacks: round={round} stage=control_wait state={} stopped={} external={} admitted={} binding={} closed={}",
                        level.0, level.1, level.2, level.3, level.4, level.5);
                    for kind in &level.6 {
                        eprintln!("acp callbacks: round={round} stage=control_wait blocker_kind={kind}");
                    }
                    last_level = Some(level);
                }
                tokio::select! {
                    biased;
                    result = &mut accepting => break result
                        .unwrap_or_else(|_| panic!("ACP control accept failed")),
                    () = std::future::ready(()), if state == "Blocked" || head.terminal.is_some() => {
                        if state == "Blocked" {
                            let diagnostic: Result<(u64, usize, bool, usize, bool, String), &'static str> = async {
                                let task = head.external.as_ref().ok_or("original external Task missing")?;
                                if !task.admitted { return Err("original external Task not admitted"); }
                                let bytes = f.owner.durable.content(actual_run, task.descriptor.clone()).await
                                    .map_err(|_| "original Task descriptor unavailable")?;
                                let frozen: maka_agent_facts::executor::TaskDescriptor<Value> = serde_json::from_slice(&bytes)
                                    .map_err(|_| "original Task descriptor invalid")?;
                                let request = &frozen.payload["request"];
                                let raw_task: maka_agent_facts::durable::ExternalTaskId = serde_json::from_value(request["taskId"].clone())
                                    .map_err(|_| "original request Task invalid")?;
                                let execution: maka_agent_facts::durable::ExecutionIdentity = serde_json::from_value(request["execution"].clone())
                                    .map_err(|_| "original request execution invalid")?;
                                if raw_task != task.task || execution.run_id != actual_run
                                    || execution.session_id != session || execution.turn_id != head.spec.turn_id {
                                    return Err("original request identity mismatch");
                                }
                                let header = async {
                                    let binding = f.owner.services.imports()
                                        .find(|(name, _)| *name == "executor")
                                        .and_then(|(_, bindings)| bindings.first())
                                        .ok_or("original executor import unavailable")?;
                                    let backend = &frozen.payload["accepted"];
                                    if backend["import"].as_str() != Some("executor")
                                        || backend["member"].as_u64() != Some(0)
                                        || backend["basis"].as_str() != Some(binding.execution_basis())
                                    { return Err("original executor basis mismatch"); }
                                    let observer = f.owner.services.select_import_method("executor", 0, "observe")
                                        .map_err(|_| "original executor observe unavailable")?
                                        .request(maka_capabilities::call::Identity::Agent {
                                            execution: execution.clone(), operation_id: None,
                                        }, tokio_util::sync::CancellationToken::new())
                                        .map_err(|_| "original header scope unavailable")?;
                                    f.owner.cleanup_workers.spawn(async move {
                                        let mut subscription = None;
                                        let reading = tokio::time::timeout(Duration::from_secs(1), async {
                                            subscription = Some(observer.subscribe("executor", 0, "observe".into(),
                                                serde_json::to_value(executor::Observe { task_id: raw_task, after_index: None })
                                                    .map_err(|_| "original header input invalid")?,
                                                maka_capabilities::call::Attachments::default())
                                                .map_err(|_| "original header admission unavailable")?.await
                                                .map_err(|_| "original header admission failed")?);
                                            let value = subscription.as_mut().unwrap().recv().await
                                                .ok_or("original header stream ended")?;
                                            match serde_json::from_value::<executor::TaskObservation>(value)
                                                .map_err(|_| "original header invalid")? {
                                                executor::TaskObservation::Found { task_id, observed: 0, has_more: false, outputs,
                                                    state: executor::TaskState::Unknown { diagnostic }, .. }
                                                    if task_id == raw_task && outputs.is_empty() => Ok(diagnostic),
                                                _ => Err("original header identity or state mismatch"),
                                            }
                                        }).await.unwrap_or(Err("original header deadline elapsed"));
                                        match reading {
                                            Ok(diagnostic) => {
                                                let cause = diagnostic.strip_prefix("executor failed: ").unwrap_or(&diagnostic);
                                                let cause = cause.strip_prefix("process operation failed: ").unwrap_or(cause);
                                                let allowed = [
                                                    "ACP original process intent changed",
                                                    "ACP admitted process has no original caller intent",
                                                    "ACP private process was not observed starting",
                                                    "work resources closed",
                                                    "Host caller intent lookup policy panicked",
                                                    "invalid caller intent operation identity",
                                                    "Host caller intent lookup budget exhausted",
                                                    "ACP admitted process reference changed",
                                                    "ACP process admitted twice",
                                                    "ACP original process reference changed",
                                                    "ACP task missing",
                                                    "ACP task head deleted",
                                                    "Host request was revoked",
                                                    "Host deployment is closed",
                                                    "foreign or closed Host caller intent lookup",
                                                    "caller intent lookup requires native ownership",
                                                    "native caller intent lookup is limited to its own consumer",
                                                    "Host caller intent consumer is not active",
                                                    "caller intent lookup requires the original consumer source",
                                                    "Host caller intent lookup was revoked",
                                                    "foreign or closed Host recovery invocation",
                                                    "Host recovery consumer is not active",
                                                    "native operation recovery is not granted",
                                                    "Host recovery invocation was revoked",
                                                    "native work origin is not active",
                                                ];
                                                if diagnostic.chars().take(513).count() <= 512 && allowed.contains(&cause) {
                                                    let display: String = diagnostic.chars().flat_map(char::escape_debug).take(512).collect();
                                                    eprintln!("acp callbacks: stage=original_header diagnostic={display}");
                                                } else {
                                                    eprintln!("acp callbacks: stage=original_header diagnostic=omitted");
                                                }
                                            }
                                            Err(reason) => eprintln!("acp callbacks: stage=original_header guard_failed={reason}"),
                                        }
                                        let mut fenced = true;
                                        if let Some(mut subscription) = subscription {
                                            subscription.cancel();
                                            fenced &= subscription.completion().await.cleanup.is_ok();
                                        }
                                        fenced &= observer.finish().await.is_ok();
                                        if !fenced {
                                            eprintln!("acp callbacks: stage=original_header cleanup=unconfirmed");
                                            let _held_observer = observer;
                                            std::future::pending::<()>().await;
                                        }
                                    }).await.map_err(|_| "original header owner failed")
                                }.await;
                                if let Err(reason) = header {
                                    eprintln!("acp callbacks: stage=original_header guard_failed={reason}");
                                }
                                let resource: maka_process::isolated::Descriptor = serde_json::from_value(frozen.payload["privateResource"].clone())
                                    .map_err(|_| "original private resource invalid")?;
                                let evidence = maka_process::isolated::closed_evidence(&resource).await
                                    .map_err(|_| "protected original evidence unavailable")?
                                    .ok_or("original group and streams closure missing")?;
                                let workspace = f.workspace.clone();
                                tokio::task::spawn_blocking(move || -> Result<(u64, usize, bool, usize, bool, String), &'static str> {
                                    use std::io::{Read, Seek, SeekFrom};
                                    let workspace = workspace.canonicalize().map_err(|_| "owned fixture workspace unavailable")?;
                                    if evidence.snapshot.source() != workspace.as_path()
                                        || evidence.snapshot.resource_ref() != resource.resource_ref.as_path() {
                                        return Err("original snapshot affinity mismatch");
                                    }
                                    if !matches!(&evidence.receipt, maka_process::isolated::TaskReceipt::Task { terminal_size: None, .. }) {
                                        return Err("original pipe receipt required");
                                    }
                                    let mut stderr = evidence.stderr.ok_or("original pipe stderr missing")?;
                                    let size = stderr.metadata().map_err(|_| "original stderr metadata unavailable")?.len();
                                    let start = size.saturating_sub(4096);
                                    stderr.seek(SeekFrom::Start(start)).map_err(|_| "original stderr seek failed")?;
                                    let mut bytes = Vec::new();
                                    stderr.take(4096).read_to_end(&mut bytes).map_err(|_| "original stderr read failed")?;
                                    let read_bytes = bytes.len();
                                    let partial_discard = start != 0;
                                    let bytes = if !partial_discard { bytes.as_slice() } else {
                                        match bytes.iter().position(|byte| *byte == b'\n') {
                                            Some(newline) => &bytes[newline + 1..],
                                            None => &[],
                                        }
                                    };
                                    let text = std::str::from_utf8(bytes).map_err(|_| "original stderr is not UTF-8")?;
                                    let mut long_lines_omitted = 0;
                                    let mut display = String::new();
                                    let mut display_truncated = false;
                                    for line in text.lines() {
                                        let trimmed = line.trim();
                                        let rendered = if line.chars().take(257).count() > 256 {
                                            long_lines_omitted += 1;
                                            "[long line omitted]".to_owned()
                                        } else if trimmed.starts_with("at ") || (!trimmed.is_empty()
                                            && trimmed.chars().all(|ch| matches!(ch, '^' | '~' | '|' | ' '))) {
                                            "[stack/caret omitted]".to_owned()
                                        } else {
                                            let mut escaped = String::new();
                                            for part in line.split_inclusive(char::is_whitespace) {
                                                let boundary = part.trim_end_matches(char::is_whitespace).len();
                                                let (token, whitespace) = part.split_at(boundary);
                                                if token.contains('/') || token.contains('\\') || token.starts_with("file:") {
                                                    escaped.push_str("[path omitted]");
                                                } else {
                                                    escaped.extend(token.chars().flat_map(char::escape_debug));
                                                }
                                                escaped.extend(whitespace.chars().flat_map(char::escape_debug));
                                            }
                                            escaped
                                        };
                                        if display.len() + rendered.len() + 1 > 4096 - 256 {
                                            display_truncated = true;
                                            continue;
                                        }
                                        display.push_str(&rendered);
                                        display.push('\n');
                                    }
                                    Ok((size, read_bytes, partial_discard, long_lines_omitted, display_truncated, display))
                                }).await.map_err(|_| "original stderr blocking reader failed")?
                            }.await;
                            match diagnostic {
                                Ok((total_bytes, read_bytes, partial_discard, long_lines_omitted, display_truncated, display)) => {
                                    eprintln!("acp callbacks: stage=owned_stderr total_bytes={total_bytes} read_bytes={read_bytes} truncated={} partial_discard={partial_discard} long_lines_omitted={long_lines_omitted} display_truncated={display_truncated}\n{display}", total_bytes > read_bytes as u64);
                                }
                                Err(reason) => eprintln!("acp callbacks: stage=owned_stderr guard_failed={reason}"),
                            }
                            panic!("ACP Run blocked before control connection");
                        }
                        panic!("ACP Run terminal before control connection");
                    }
                    changed = notices.changed() => changed
                        .unwrap_or_else(|_| panic!("ACP canonical notice closed")),
                }
            };
            eprintln!("acp callbacks: round={round} stage=control_connected");
            let head = f.owner.durable.frontier(actual_run).await
                .unwrap_or_else(|_| panic!("ACP original Run frontier unavailable"));
            assert!(head.run == actual_run, "ACP must observe the original Delivered Run");
            assert!(head.spec.session_id == session, "ACP must observe the original session");
            assert!(head.spec.owner == f.owner.run_owner(), "ACP must observe the original owner");
            let record = form_with_original(&f,&session,Some(actual_run)).await;
            eprintln!("acp callbacks: round={round} stage=form_return same_session={} outcome_some={}",record.execution.session_id==session,record.outcome.is_some());
            if text=="peer-cancel" {
                eprintln!("acp callbacks: round={round} stage=cancel_enter");
                process.write_all(b"cancel-permission\n").await.unwrap();
                eprintln!("acp callbacks: round={round} stage=cancel_sent");
            } else {
                eprintln!("acp callbacks: round={round} stage=response_enter");
                let response=f.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,
                    "answer":{"kind":"form","action":"accept","values":{"permission":"allow-once"}}}),Uuid::new_v4()).await.unwrap();
                let response: maka_agent_api::contract::InteractionResult=serde_json::from_value(response)
                    .unwrap_or_else(|_|panic!("invalid ACP interaction response shape"));
                match response {
                    maka_agent_api::contract::InteractionResult::Recorded { record: committed }=>{
                        eprintln!("acp callbacks: round={round} stage=response_return result=Recorded outcome_some={}",committed.outcome.is_some());
                        assert!(committed.request_id==record.request_id,"response must record the original ACP form");
                        assert!(committed.execution==record.execution,"response must retain the original ACP execution");
                        let Some(maka_agent_facts::interaction::InteractionOutcome::FormAnswer {
                            result:maka_agent_facts::capability::FormResult::Accept { values }, ..
                        })=committed.outcome.as_ref() else {panic!("original ACP form acceptance must be recorded");};
                        assert!(values.len()==1 && values.get("permission")==Some(&maka_agent_facts::capability::FormValue::String("allow-once".into())),"original ACP form selection must be retained");
                    }
                    maka_agent_api::contract::InteractionResult::Rejected { reason }=>{
                        use maka_agent_api::contract::InteractionRejection;
                        let reason=match reason {
                            InteractionRejection::NotYourChild=>"NotYourChild",
                            InteractionRejection::HumanActionRequired=>"HumanActionRequired",
                            InteractionRejection::AuthorizationChanged=>"AuthorizationChanged",
                            InteractionRejection::PermissionRequestsDisabled=>"PermissionRequestsDisabled",
                            InteractionRejection::Closed=>"Closed",
                            InteractionRejection::Unavailable=>"Unavailable",
                            InteractionRejection::InvalidAnswer=>"InvalidAnswer",
                            InteractionRejection::Unsupported=>"Unsupported",
                        };
                        eprintln!("acp callbacks: round={round} stage=response_return result=Rejected reason={reason}");
                        panic!("original ACP form response rejected");
                    }
                }
            }
            eprintln!("acp callbacks: round={round} stage=drain_enter");
            f.drained().await;
            eprintln!("acp callbacks: round={round} stage=drain_return");
            let mut changes = f.owner.durable.subscribe().unwrap();
            let mut last_kind = None;
            let observed = loop {
                changes.borrow_and_update();
                let observed = work(&f, &session, &accepted).await;
                let state=match observed["execution"]["state"]["kind"].as_str() {
                    Some("admitted")=>"Admitted", Some("running")=>"Running", Some("waiting")=>"Waiting",
                    Some("completed")=>"Completed", Some("failed")=>"Failed", Some("cancelled")=>"Cancelled",
                    Some("blocked")=>"Blocked", _=>"Unexpected",
                };
                if last_kind != Some(state) {
                    eprintln!("acp callbacks: round={round} stage=canonical_level state={state}");
                    last_kind = Some(state);
                }
                if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
                changes.changed().await.unwrap();
            };
            assert_eq!(observed["execution"]["state"]["kind"],"completed","{observed}");
            let (_, _, answer) = external_result(&f, &session, &accepted).await;
            assert_eq!(answer,if text=="peer-cancel" {"permission cancelled"}else{"callbacks complete"});
            assert!(f.owner.durable.interactions().pending(&session).await.unwrap().records.is_empty());
            eprintln!("acp callbacks: round={round} stage=round_complete");
        }
        eprintln!("acp callbacks: stage=verification_enter");
        assert!(!f.workspace.join("written.txt").exists(),"Root never receives native/private writes");
        let heads=task_heads(&f,&session).await;
        assert_eq!(heads.len(),3);
        for head in &heads { assert_eq!(std::fs::read_to_string(std::path::Path::new(head["resource_ref"].as_str().unwrap()).join("tmp/written.txt")).unwrap(),"private fixture copy\n"); }
        let requests=trace_text(&f,&session,&std::path::PathBuf::from("acp-requests.jsonl")).await;
        let requests:Vec<Value>=requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(requests.iter().filter(|v|v["id"]=="write-file" && v.get("error").is_some()).count(),3,"three distinct requests receive real Root FS rejection");
        eprintln!("acp callbacks: stage=app_shutdown_enter");
        f.app.shutdown().await.unwrap();
        eprintln!("acp callbacks: stage=app_shutdown_return");
        f.config.shutdown().await.unwrap();
        eprintln!("acp callbacks: stage=config_shutdown_return");
    }).await.unwrap();
}
#[tokio::test]
async fn native_acp_does_not_replay_a_prompt_after_process_loss_and_reactivation() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(1).await;
        activate_backend(&mut f, true, None, true, Some(configuration.clone()), &[]).await;
        let session = f.create("ACP unknown").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let first = execute(&f, &session, "lose").await;
        let (_process, _) = control.accept().await.unwrap();
        f.drained().await;
        let before = task_heads(&f, &session).await;
        assert_eq!(before.len(), 1);
        assert_eq!(
            before[0]["state"]["kind"], "unknown",
            "loss is not a known business failure"
        );
        activate_backend(&mut f, false, None, true, Some(configuration), &[]).await;
        f.drained().await;
        let _observed = work(&f, &session, &first).await;
        let after = task_heads(&f, &session).await;
        assert_eq!(after.len(), 1);
        assert_eq!(after[0]["resource_ref"], before[0]["resource_ref"]);
        assert_eq!(after[0]["state"]["kind"], "unknown");
        assert!(
            !f.recorded_facts(&session).await.iter().any(|row| matches!(
                &row.fact,
                maka_agent_facts::durable::Fact::ExternalTaskClosed { .. }
            )),
            "no invented terminal business result"
        );
        let requests = trace_text(&f, &session, &trace).await;
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            requests
                .iter()
                .filter(|v| v["method"] == "session/prompt")
                .count(),
            1
        );
        assert_eq!(
            requests.iter().filter(|v| v["method"] == "spawn").count(),
            1
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_acp_file_callback_requires_its_own_write_grant() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(1).await;
        activate_backend(&mut f, true, None, true, Some(configuration), &["write"]).await;
        let session = f.create("ACP denied write").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        std::fs::write(f.workspace.join("input.txt"), "fixture contents\n").unwrap();
        let accepted = execute(&f, &session, "callbacks").await;
        let (_process, _) = control.accept().await.unwrap();
        let record=form(&f,&session).await;
        f.mutation(2,"respond",json!({"sessionId":session,"requestId":record.request_id,"answer":{"kind":"form","action":"accept","values":{"permission":"allow-once"}}}),Uuid::new_v4()).await.unwrap();
        f.drained().await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"], "completed", "{observed}");
        assert!(!f.workspace.join("written.txt").exists());
        assert!(
            f.owner.durable.interactions().pending(&session).await.unwrap().records.is_empty()
        );
        let requests = trace_text(&f, &session, &trace).await;
        let requests: Vec<Value> = requests
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(
            requests
                .iter()
                .any(|v| v["id"] == "write-file" && v.get("error").is_some())
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

async fn reject_changed_authority(f: &Fixture, session: &str) {
    let execution = f.latest_run(session).await.execution();
    for field in ["execution", "cwd"] {
        let mut input = json!({"taskId":Uuid::new_v4(),"execution":execution,"conversationKey":"untrusted shared key","message":"must not run","cwd":f.workspace,"instructions":null,"settings":{}});
        if field == "execution" {
            input["execution"]["session_id"] = json!("another-session");
        } else {
            input["cwd"] = json!("/tmp");
        }
        let client = f.app.client();
        let binding = client
            .bind(client.activation(&id(1)).unwrap(), "executor".into())
            .await
            .unwrap()
            .remove(0);
        let caller = scope(&f.issuer, true);
        let prepared = client
            .prepare_mutation(
                binding,
                "execute".into(),
                input,
                caller.clone(),
                Uuid::new_v4(),
                Attachments::default().into(),
            )
            .await
            .unwrap();
        let intent = f
            .store
            .record_application_intent(
                prepared.reference().source.clone(),
                prepared.consumer().instance().clone(),
                prepared.reference().clone(),
                Value::Null,
            )
            .await
            .unwrap();
        let result = client
            .mutate(prepared, intent)
            .await
            .unwrap()
            .completion()
            .await;
        result.cleanup.unwrap();
        caller.finish().await.unwrap();
        assert!(
            !matches!(
                result.reply.receipt,
                Receipt::Recorded {
                    outcome: OperationOutcome::Returned {
                        result: maka_plugin_core::operation::OperationResult::Success { .. }
                    },
                    ..
                }
            ),
            "payload metadata cannot produce the original native role"
        );
    }
}

#[tokio::test]
async fn native_acp_stop_controls_only_the_original_process_without_inventing_business_completion()
{
    tokio::time::timeout(Duration::from_secs(60), async {
        let (mut f, control, trace, configuration) = setup(2).await;
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP stop").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let accepted = execute(&f, &session, "wait").await;
        let run = f.delivered_run(&accepted).await;
        let (process, _) = control.accept().await.unwrap();
        let mut process = tokio::io::BufReader::new(process);
        let mut pid = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut process, &mut pid)
            .await
            .unwrap();
        let mut waiting = String::new();
        tokio::io::AsyncBufReadExt::read_line(&mut process, &mut waiting)
            .await
            .unwrap();
        assert_eq!(waiting.trim(), "waiting");
        let expected:Vec<String>=(0..300).map(|index|format!("stop-prefix {index}\n")).collect();
        let mut commits=f.owner.durable.subscribe().unwrap();
        loop {
            commits.borrow_and_update();
            let prefix:Vec<String>=f.recorded_facts(&session).await.into_iter().filter_map(|row|match row.fact {
                maka_agent_facts::durable::Fact::ExternalTaskObserved {output:maka_agent_facts::executor::Output::ToolProgress {text,..},..}=>Some(serde_json::from_str::<Value>(&text).unwrap()["rawOutput"].as_str().unwrap().to_owned()),
                _=>None,
            }).collect();
            if prefix.len()==expected.len() {assert_eq!(prefix,expected);break;}
            assert!(prefix.len()<expected.len());commits.changed().await.unwrap();
        }
        let original_heads=task_heads(&f,&session).await;assert_eq!(original_heads.len(),1);
        assert_eq!(original_heads[0]["observed"],301);
        let stopping=f.mutation(2,"stop",json!({"sessionId":session,"runId":run}),Uuid::new_v4());
        tokio::pin!(stopping);
        let stopped=tokio::select! {
            biased;
            stopped=&mut stopping=>stopped,
            sent=process.get_mut().write_all(b"continue\n")=>{
                sent.unwrap();
                stopping.await
            }
        }.unwrap();
        assert_eq!(stopped["requested"], true);
        f.drained().await;
        let mut eof=String::new();tokio::io::AsyncReadExt::read_to_string(&mut process,&mut eof).await.unwrap();
        let facts=f.recorded_facts(&session).await;
        assert!(facts.iter().any(|row|matches!(&row.fact,maka_agent_facts::durable::Fact::StopRequested {..})));
        assert!(!facts.iter().any(|row|matches!(&row.fact,maka_agent_facts::durable::Fact::ExternalTaskClosed {..})),"control ACK/EOF is not the external agent's business result");
        let retained:Vec<String>=facts.iter().filter_map(|row|match &row.fact {
            maka_agent_facts::durable::Fact::ExternalTaskObserved {output:maka_agent_facts::executor::Output::ToolProgress {text,..},..}=>Some(serde_json::from_str::<Value>(text).unwrap()["rawOutput"].as_str().unwrap().to_owned()),
            _=>None,
        }).collect();assert_eq!(retained,expected);
        let final_heads=task_heads(&f,&session).await;assert_eq!(final_heads.len(),1);
        let observed=final_heads[0]["observed"].as_u64().unwrap();
        assert!(matches!(observed,301|302),"only the interrupted original tool's error result may follow the complete progress prefix");
        assert_eq!(final_heads[0]["resource_ref"],original_heads[0]["resource_ref"]);
        assert_eq!(final_heads[0]["cleanup"]["kind"],"confirmed");
        let intents=f.store.application_intents(f.app.source().unwrap().deployment,id(1),0,128).await.unwrap();
        let original=intents.iter().find(|intent|intent.reference.namespace==id(21)&&intent.reference.method=="execute").unwrap();
        let receipt=f.store.operation(&original.reference).unwrap().operation_observation().await.unwrap().unwrap();
        assert_eq!(receipt.cleanup,maka_plugin_core::operation::OperationCleanup::Confirmed);
        let diagnostic=serde_json::to_string(&receipt.outcome).unwrap();
        assert!(!diagnostic.contains("not live in this provider"),"the original self-exit must reconcile its done, not become a residency failure: {diagnostic}");
        let trace_data=trace_text(&f,&session,&trace).await;
        let trace_rows:Vec<Value>=trace_data.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(trace_rows.iter().filter(|row|row["method"]=="spawn").count(),1);
        assert_eq!(trace_rows.iter().filter(|row|row["method"]=="self_exit"&&row["phase"]=="wait").count(),1);
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"], "cancelled", "{observed}");
        assert_eq!(
            trace_text(&f,&session,&trace).await
                .lines()
                .filter(
                    |line| serde_json::from_str::<Value>(line).unwrap()["method"]
                        == "session/prompt"
                )
                .count(),
            1
        );
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn native_acp_v1_forwards_complete_actual_attachments_once() {
    attachment_prompt(1).await;
}
#[tokio::test]
async fn native_acp_v2_forwards_complete_actual_attachments_once() {
    attachment_prompt(2).await;
}
async fn attachment_prompt(protocol: u8) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut f, control, trace, mut configuration) = setup(protocol).await;
        configuration.agent.args.push("attachments".into());
        activate_backend(&mut f, true, None, true, Some(configuration), &[]).await;
        let session = f.create("ACP attachments").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let image = b"\x89PNG\r\n\x1a\nactual binary pixels";
        let pdf = b"%PDF-1.7\n\0actual binary document";
        let text = "User attachment 独立字节\n";
        let extra: Vec<_> = (0..6).map(|index| (format!("extra-{index}.txt"), format!("ACP original extra {index} 中\nend-{index}"))).collect();
        let mut ids = Vec::new();
        for (name, bytes) in [("notes.md",text.as_bytes()), ("image.png",image.as_slice()), ("document.pdf",pdf.as_slice())]
            .into_iter().chain(extra.iter().map(|(name, bytes)| (name.as_str(), bytes.as_bytes()))) {
            let uploaded = super::super::attachments::upload(&f, &session, name, bytes, Uuid::new_v4()).await.unwrap();
            ids.push(uploaded["attachment"]["id"].clone());
        }
        let first = f.mutation(2,"send",json!({"sessionId":session,"message":"","attachments":ids,"backend":{"kind":"executor","selection":{"executor":"external","settings":{}}}}),Uuid::new_v4()).await.unwrap();
        assert_eq!(first["kind"],"queued");
        assert_eq!(first["sessionId"],session);
        assert!(first["messageId"].is_string());
        let (_stream, _) = control.accept().await.unwrap();
        f.drained().await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &first).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"],"completed","{observed}");
        let requests = trace_text(&f, &session, &trace).await;
        let requests: Vec<Value> = requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        let prompt = &requests.iter().find(|v| v["method"] == "session/prompt").unwrap()["params"]["prompt"];
        let blocks = prompt.as_array().unwrap();
        assert!(blocks.iter().any(|v| v["type"]=="resource" && v["resource"]["text"]==text));
        assert!(blocks.iter().any(|v| v["type"]=="image" && v["data"]==STANDARD.encode(image) && v["mimeType"]=="image/png"));
        assert!(blocks.iter().any(|v| v["type"]=="resource" && v["resource"]["blob"]==STANDARD.encode(pdf) && v["resource"]["mimeType"]=="application/pdf"));
        let media: Vec<_> = blocks.iter().filter(|block| matches!(block["type"].as_str(), Some("resource" | "image"))).collect();
        assert_eq!(media.len(),9);
        assert_eq!(media[0]["resource"]["text"],text);
        assert_eq!(media[1]["data"],STANDARD.encode(image));
        assert_eq!(media[2]["resource"]["blob"],STANDARD.encode(pdf));
        for (block, (_, expected)) in media[3..].iter().zip(&extra) {
            assert_eq!(block["type"],"resource");
            assert_eq!(block["resource"]["text"],*expected);
        }
        assert!(!prompt.to_string().contains(&f.workspace.to_string_lossy().to_string()));
        for id in &ids { assert!(!prompt.to_string().contains(id.as_str().unwrap())); }
        let mut large_image = vec![255;800_000];
        large_image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let large = super::super::attachments::upload(&f, &session, "large.png", &large_image, Uuid::new_v4()).await.unwrap();
        let large_execution = f.mutation(2,"send",json!({"sessionId":session,"message":"complete large image","attachments":[large["attachment"]["id"]],"backend":{"kind":"executor","selection":{"executor":"external","settings":{}}}}),Uuid::new_v4()).await.unwrap();
        let (_large_process,_) = control.accept().await.unwrap();
        f.drained().await;
        let large_observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &large_execution).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(large_observed["execution"]["state"]["kind"],"completed");
        let third = execute(&f, &session, "after complete attachment").await;
        let (_third_process,_) = control.accept().await.unwrap();
        f.drained().await;
        let third_observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &third).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        f.app.shutdown().await.unwrap();
        f.config.shutdown().await.unwrap();
        assert_eq!(large_execution["kind"],"queued");
        assert_eq!(large_execution["sessionId"],session);
        assert!(large_execution["messageId"].is_string());
        assert_eq!(large_observed["execution"]["state"]["kind"],"completed");
        assert_eq!(third_observed["execution"]["state"]["kind"],"completed");
        let requests=trace_text(&f, &session, &trace).await;
        let requests:Vec<Value>=requests.lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        let prompts:Vec<_>=requests.iter().filter(|v|v["method"]=="session/prompt").collect();
        assert_eq!(prompts.len(),3,"each accepted execution reaches the peer exactly once");
        assert_eq!(requests.iter().filter(|v|v["method"]=="spawn").count(),3);
        assert_eq!(requests.iter().filter(|v|v["method"]=="session/new").count(),3);
        assert!(prompts.iter().all(|prompt|prompt["params"]["sessionId"]=="acp-persistent"));
        let large_prompt=prompts[1]["params"]["prompt"].as_array().unwrap();
        assert_eq!(large_prompt.iter().filter(|block|block["type"]=="text" && block["text"]=="complete large image").count(),1);
        let large_media:Vec<_>=large_prompt.iter().filter(|block|matches!(block["type"].as_str(),Some("resource"|"image"))).collect();
        assert_eq!(large_media.len(),1);
        assert_eq!(large_media[0]["type"],"image");
        assert_eq!(large_media[0]["mimeType"],"image/png");
        let encoded=large_media[0]["data"].as_str().unwrap();
        assert!(encoded==STANDARD.encode(&large_image),"peer receives the entire canonical image encoding");
        assert!(STANDARD.decode(encoded).unwrap()==large_image,"peer receives every original image byte");
        let wire_prompt=prompts[1]["params"]["prompt"].to_string();
        assert!(!wire_prompt.contains(&f.workspace.to_string_lossy().to_string()));
        assert!(!wire_prompt.contains(large["attachment"]["id"].as_str().unwrap()));
        let last_prompt=prompts[2]["params"]["prompt"].as_array().unwrap();
        assert_eq!(last_prompt.iter().filter(|block|block["type"]=="text" && block["text"]=="after complete attachment").count(),1);
    }).await.unwrap();
}

#[tokio::test]
async fn native_acp_rejects_unsupported_media_then_accepts_plain_text_attachment() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let (mut f,control,trace,configuration)=setup(2).await;
        activate_backend(&mut f,true,None,true,Some(configuration),&[]).await;
        let session=f.create("Text-only peer").await;
        super::super::files::change(&f, &session, "danger_full_access", false, false).await;
        let image=super::super::attachments::upload(&f,&session,"image.png",b"\x89PNG\r\n\x1a\nactual image",Uuid::new_v4()).await.unwrap();
        let accepted=f.mutation(2,"send",json!({"sessionId":session,"message":"inspect image","attachments":[image["attachment"]["id"]],"backend":{"kind":"executor","selection":{"executor":"external","settings":{}}}}),Uuid::new_v4()).await.unwrap();
        let (_first,_)=control.accept().await.unwrap();
        f.drained().await;
        let mut changes = f.owner.durable.subscribe().unwrap();
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"],"failed");
        let text=super::super::attachments::upload(&f,&session,"notes.txt",b"actual text attachment",Uuid::new_v4()).await.unwrap();
        let accepted=f.mutation(2,"send",json!({"sessionId":session,"message":"inspect text","attachments":[text["attachment"]["id"]],"backend":{"kind":"executor","selection":{"executor":"external","settings":{}}}}),Uuid::new_v4()).await.unwrap();
        let (_second,_)=control.accept().await.unwrap();
        f.drained().await;
        let observed = loop {
            changes.borrow_and_update();
            let observed = work(&f, &session, &accepted).await;
            if !matches!(observed["execution"]["state"]["kind"].as_str(), Some("admitted" | "running" | "waiting")) { break observed; }
            changes.changed().await.unwrap();
        };
        assert_eq!(observed["execution"]["state"]["kind"],"completed");
        let trace=trace_text(&f, &session, &trace).await;
        let prompts:Vec<Value>=trace.lines().map(|line|serde_json::from_str::<Value>(line).unwrap()).filter(|v|v["method"]=="session/prompt").collect();
        assert_eq!(prompts.len(),1,"unsupported image never reaches the peer");
        let content=prompts[0]["params"]["prompt"].as_array().unwrap();
        assert!(content.iter().all(|v|v["type"]=="text"));
        assert!(content.iter().any(|v|v["text"]=="actual text attachment"));
        f.app.shutdown().await.unwrap();f.config.shutdown().await.unwrap();
    }).await.unwrap();
}
