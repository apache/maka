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
use futures_util::FutureExt;
use maka_agent_state::artifacts::{ArtifactStore, SessionScope};

async fn turn(fixture: &Fixture) {
    let result = fixture.run_call().await;
    let ResultValue::Completed { artifact, .. } = result else {
        panic!(
            "real Host evaluation failed: {}",
            serde_json::to_string(&result).unwrap()
        );
    };
    let session = fixture.execution.session_id.clone();
    let turn = fixture.execution.turn_id.clone();
    let outputs = ArtifactStore::new(fixture.host.root.data_writer().unwrap())
        .with_content(
            SessionScope {
                owner: fixture.call.authority.run_owner().clone(),
                session: session.clone(),
            },
            artifact,
            move |artifact, read| {
                assert_eq!(artifact.session_id, session);
                assert_eq!(artifact.turn_id, turn);
                let mut text = String::new();
                read.read_to_string(&mut text).unwrap();
                text
            },
        )
        .await
        .unwrap()
        .expect("original Computer output artifact");
    for output in serde_json::from_str::<Vec<Value>>(&outputs).unwrap() {
        if let Some(text) = output["text"].as_str()
            && let Ok(ids) = serde_json::from_str::<Value>(text)
            && ids.get("testPageId").is_some()
        {
            println!("MAKA_HANDOFF_SMOKE:OWNED={ids}");
        }
    }
    fixture
        .host
        .wait_terminal(fixture.execution.run_id)
        .await
        .unwrap();
    sessions::drain_ended_turns(&fixture.owner, &fixture.entry, Language::En)
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
    let mut fixture = Fixture::browser_handoff(
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
    let result = std::panic::AssertUnwindSafe(async {
    turn(&fixture).await;
    println!("MAKA_HANDOFF_SMOKE:CREATED");
    fixture.next_call(r#"
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
    turn(&fixture).await;
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
    fixture.next_call(r#"
        globalThis.newBrowser=await cua.getBrowser({id:'chatgpt'});
        if(newBrowser.browserId===firstBrowser.browserId) throw Error('native generation did not change');
        if(!(await newBrowser.user.openTabs()).some(t=>t.id===resultPageId)) throw Error('deliverable page did not survive handback');
        globalThis.newPage=await newBrowser.user.claimTab(testPageId);
        globalThis.cleanupResult=await newBrowser.user.claimTab(resultPageId);
        await cleanupResult.close();
        nodeRepl.write('new generation page resumed without a new retention mark');
    "#).await;
    turn(&fixture).await;
    fixture.next_call(r#"
        globalThis.finalBrowser=await cua.getBrowser({id:'chatgpt'});
        let tabs=await finalBrowser.user.openTabs();
        if(tabs.some(t=>t.id===testPageId||t.id===resultPageId||t.id===unusedPageId)) throw Error('test-owned page remained after cleanup');
        nodeRepl.write('test-owned pages removed');
    "#).await;
    turn(&fixture).await;
    }).catch_unwind().await;
    fixture.close().await;
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
    println!("MAKA_HANDOFF_SMOKE:COMPLETE");
}
