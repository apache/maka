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

//! Hardware smoke driven by the external handoff runner. Only its own blank
//! pages are claimed; real Root execution, grants and CUA effect custody apply.

use super::super::browser_access::tests::Fixture;
use super::*;
use maka_agent_facts::event::{EventWrite, Fact, InvocationInput, RuntimeEvent};
use maka_capabilities::call::{Identity, Issuer};

async fn turn(fixture: &Fixture, code: &str) {
    let prepared = fixture
        .store
        .execution_scope(Some(fixture.basis()))
        .await
        .unwrap();
    let (parent, effects) = prepared
        .accept_invocation(fixture.invocation.clone(), CancellationToken::new())
        .unwrap();
    let source = parent.store();
    let operation_id = Uuid::new_v4().to_string();
    let scope = Issuer::default()
        .issue_with_execution(
            Identity::Agent {
                invocation: fixture.invocation.clone(),
                operation_id: Some(operation_id.clone()),
            },
            (),
            CancellationToken::new(),
            source.execution_custody().unwrap(),
        )
        .unwrap();
    let interaction = fixture
        .owner
        .sessions
        .get(&fixture.invocation.session_id)
        .unwrap();
    let code = code.to_owned();
    let input =
        serde_json::json!({"code":code,"timeout_ms":30000,"title":"Verify retained test pages"});
    let owner = fixture.owner.clone();
    let basis = fixture.basis();
    let execution_interaction = interaction.clone();
    let execution_input = input.clone();
    let result = ToolJournal::new(Arc::new(source.clone()), fixture.invocation.clone())
        .invoke_prepared_output(
            operation_id,
            ToolCallIdentity::standalone(Uuid::new_v4().to_string()),
            "cua_repl".into(),
            input,
            None,
            CancellationToken::new(),
            PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    let result = owner
                        .evaluate(
                            "evaluate",
                            execution_input,
                            EvaluationScope {
                                call: scope,
                                input_resources: None,
                            },
                            basis,
                            execution_interaction,
                            cancellation,
                        )
                        .await?;
                    Ok(serde_json::to_value(result).map_err(failed)?.into())
                })
            }),
        )
        .await
        .and_then(|output| {
            serde_json::from_value::<ResultValue>(output.into_json()).map_err(failed)
        });
    if let Ok(ResultValue::Completed { artifact, .. }) = &result {
        let outputs = source
            .with_artifact(
                maka_event_log::artifacts::ArtifactReadScope::Execution(&fixture.invocation),
                artifact,
                |_, read| {
                    let mut text = String::new();
                    read.read_to_string(&mut text).unwrap();
                    text
                },
            )
            .await
            .unwrap()
            .unwrap();
        for output in serde_json::from_str::<Vec<Value>>(&outputs).unwrap() {
            if let Some(text) = output["text"].as_str()
                && let Ok(ids) = serde_json::from_str::<Value>(text)
                && ids.get("testPageId").is_some()
            {
                println!("MAKA_HANDOFF_SMOKE:OWNED={ids}");
            }
        }
    }
    assert!(
        matches!(&result, Ok(ResultValue::Completed { .. })),
        "real Host evaluation failed: {}",
        match result {
            Ok(value) => serde_json::to_string(&value).unwrap(),
            Err(error) => error.to_string(),
        }
    );
    fixture.end().await;
    sessions::drain_ended_turns(
        &fixture.owner,
        &interaction,
        &fixture.invocation.session_id,
        Language::En,
    )
    .await
    .unwrap();
    effects.settle().await.unwrap();
    parent.finish();
}

async fn next_turn(fixture: &mut Fixture, name: &str) {
    let configuration = fixture
        .store
        .invocation_configuration(&fixture.invocation)
        .await
        .unwrap()
        .unwrap();
    fixture.invocation.turn_id = name.into();
    fixture.invocation.run_id = Uuid::new_v4().to_string();
    fixture.invocation.invocation_id = Uuid::new_v4().to_string();
    fixture
        .store
        .append(
            &EventWrite::plain(RuntimeEvent::new(
                fixture.invocation.clone(),
                Fact::InvocationOpened {
                    configuration: Some(Box::new(configuration)),
                    input: InvocationInput::Code {
                        source: "retained browser hardware smoke".into(),
                    },
                },
            ))
            .unwrap(),
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the external retained-browser runner and a connected ChatGPT extension"]
async fn real_host_retained_browser_pages_survive_handoff() {
    assert_eq!(
        std::env::var("MAKA_BROWSER_HANDOFF_SMOKE").as_deref(),
        Ok("1"),
        "use the external runner; this test changes only its own blank tabs"
    );
    let mut fixture = Fixture::browser_handoff().await;
    turn(
        &fixture,
        r#"
        globalThis.firstBrowser=await cua.getBrowser({id:'chatgpt'});
        globalThis.testPage=await firstBrowser.tabs.new();
        globalThis.testPageId=testPage.id;
        await testPage.markHandoff();
        globalThis.resultPage=await firstBrowser.tabs.new();
        globalThis.resultPageId=resultPage.id;
        await resultPage.markDeliverable();
        globalThis.unusedPage=await firstBrowser.tabs.new();
        globalThis.unusedPageId=unusedPage.id;
        await unusedPage.markHandoff();
        nodeRepl.write({testPageId,resultPageId,unusedPageId});
    "#,
    )
    .await;
    println!("MAKA_HANDOFF_SMOKE:CREATED");
    next_turn(&mut fixture, "same-native-generation").await;
    turn(&fixture, r#"
        globalThis.sameBrowser=await cua.getBrowser({id:'chatgpt'});
        if(sameBrowser.browserId!==firstBrowser.browserId) throw Error('peer lost its native generation');
        await sameBrowser.tabs.list();
        if(!(await sameBrowser.user.openTabs()).some(t=>t.id===resultPageId)) throw Error('deliverable page disappeared');
        globalThis.samePage=await sameBrowser.user.claimTab(testPageId);
        await samePage.markHandoff();
        await sameBrowser.release();
        globalThis.againBrowser=await cua.getBrowser({id:'chatgpt'});
        globalThis.againPage=await againBrowser.user.claimTab(testPageId);
        await againPage.markHandoff();
        nodeRepl.write('same generation and same logical turn page resumed');
    "#).await;
    println!("MAKA_HANDOFF_SMOKE:RETURN");
    let line = tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        line
    })
    .await
    .unwrap();
    assert_eq!(
        line.trim(),
        "READY",
        "external runner must return and reacquire the host"
    );
    next_turn(&mut fixture, "new-native-generation").await;
    turn(&fixture, r#"
        globalThis.newBrowser=await cua.getBrowser({id:'chatgpt'});
        if(newBrowser.browserId===firstBrowser.browserId) throw Error('native generation did not change');
        if(!(await newBrowser.user.openTabs()).some(t=>t.id===resultPageId)) throw Error('deliverable page did not survive handback');
        globalThis.newPage=await newBrowser.user.claimTab(testPageId);
        globalThis.cleanupResult=await newBrowser.user.claimTab(resultPageId);
        await cleanupResult.close();
        nodeRepl.write('new generation page resumed without a new retention mark');
    "#).await;
    next_turn(&mut fixture, "verify-final-cleanup").await;
    turn(&fixture, r#"
        globalThis.finalBrowser=await cua.getBrowser({id:'chatgpt'});
        let tabs=await finalBrowser.user.openTabs();
        if(tabs.some(t=>t.id===testPageId||t.id===resultPageId||t.id===unusedPageId)) throw Error('test-owned page remained after cleanup');
        nodeRepl.write('test-owned pages removed');
    "#).await;
    fixture.close().await;
    println!("MAKA_HANDOFF_SMOKE:COMPLETE");
}
