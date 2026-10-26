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

//! Actual Computer.evaluate, canonical grants and Host reply custody for the
//! main-world Clipboard bridge. The observer uses a separate real Chrome socket.
use super::browser_dialogs::{Browser, product};
use super::*;
use maka_agent_facts::interaction::{GrantCapability, GrantScope, GrantTarget};
use std::sync::atomic::Ordering;

async fn evaluate(run: &Run, label: &str, source: String) -> (String, Value) {
    let marker = format!("clipboard-{}=", Uuid::new_v4());
    let (outer, result) = run.invoke(label, "evaluate", json!({
        "code":format!("nodeRepl.write({}+JSON.stringify(await(async()=>{{{source}}})()));",json!(marker)),
        "timeout_ms":10000,"title":"Owned product clipboard fixture"
    })).await;
    let output = run.text(result.unwrap()).await;
    let value = serde_json::from_str(
        output
            .lines()
            .find_map(|line| line.strip_prefix(&marker))
            .unwrap_or_else(|| panic!("clipboard result marker missing: {output}")),
    )
    .unwrap();
    (outer, value)
}

async fn write(run: &Run, browser: &Browser, label: &str, text: &str) -> String {
    let (outer, result) = evaluate(run, label, format!(
        "globalThis.browser=await cua.getBrowser({{id:'fixture'}});globalThis.tab=await browser.tabs.get({});return {{written:(await tab.clipboard.writeText({}))===undefined}};",
        json!(browser.target),json!(text)
    )).await;
    assert_eq!(result, json!({"written":true}));
    let ledger = facts(&run.store, &run.invocation.session_id).await;
    let writes: Vec<_> = ledger
        .iter()
        .filter_map(|stored| match &stored.event.fact {
            Fact::ToolDispatched {
                operation_id,
                name,
                input,
                ..
            } if name == "cua_operation" && input["method"] == "clipboardWriteText" => {
                Some(operation_id)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        writes.len(),
        1,
        "fixture must issue one native clipboard write"
    );
    assert!(matches!(
        settled(&ledger, writes[0]),
        Some(ToolOutcome::Succeeded { .. })
    ));
    assert!(matches!(
        settled(&ledger, &outer),
        Some(ToolOutcome::Succeeded { .. })
    ));
    assert!(
        run.effects.is_idle(),
        "completed Agent calls must release their actual native effect leases"
    );
    outer
}

async fn origin_decision(run: &Run, browser: &Browser, id: &str, decision: Decision, time: u64) {
    let target = GrantTarget {
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin {
            origin: browser.endpoint.clone(),
        },
        ..api::target()
    };
    let record = InteractionRecord {
        session_id: run.invocation.session_id.clone(),
        turn_id: run.invocation.turn_id.clone(),
        run_id: run.invocation.run_id.clone(),
        request_id: id.into(),
        created_at: time,
        request: InteractionRequest::ClientCapability {
            tool_use_id: "owned-product-clipboard".into(),
            target: target.clone(),
            basis: Some(run.basis),
        },
        outcome: None,
    };
    run.store
        .establish_run_interaction(&run.invocation, &record)
        .await
        .unwrap();
    assert!(
        run.store
            .commit_interaction_outcome(
                id,
                InteractionOutcome::ClientCapabilityDecision {
                    decision,
                    committed_at: time
                }
            )
            .await
            .unwrap()
            .matches
    );
    assert_eq!(
        run.store
            .browser_origin_decision(&run.invocation.session_id, &target, &run.basis)
            .await
            .unwrap(),
        Some(decision)
    );
}

async fn no_bridge(browser: &Browser) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if browser
                .page("globalThis.__makaVirtualClipboard===undefined")
                .await
                == true
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("actual turn/epoch cleanup did not restore the owned page bridge");
}

async fn cleanup_complete(browser: &Browser, expected: usize) {
    no_bridge(browser).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let complete = {
                let rows = browser.wire.rows.lock().unwrap();
                let acknowledgements: Vec<_> = rows
                    .iter()
                    .filter(|row| {
                        row["stage"] == "cleanup_ack" && row["method"] == "Runtime.disable"
                    })
                    .collect();
                for row in &acknowledgements {
                    assert!(row["message"].get("error").is_none(), "{row}");
                }
                acknowledgements.len() >= expected
            };
            if complete {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned bridge cleanup did not finish its actual final Runtime.disable ACK");
}

async fn reload(browser: &Browser) {
    let previous = browser.request("Page.getFrameTree", json!({})).await;
    let previous = previous["frameTree"]["frame"]["loaderId"]
        .as_str()
        .unwrap()
        .to_owned();
    browser.request("Page.reload", json!({})).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = browser.request("Page.getFrameTree", json!({})).await;
            if current["frameTree"]["frame"]["loaderId"]
                .as_str()
                .is_some_and(|loader| loader != previous)
                && browser.page("document.readyState").await == "complete"
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned Chrome did not finish its actual replacement document");
}

fn same_reply_requests(browser: &Browser, original: &Value) -> usize {
    browser
        .wire
        .rows
        .lock()
        .unwrap()
        .iter()
        .filter(|row| {
            row["stage"] == "clipboard_reply_request"
                && row["message"]["params"]["uniqueContextId"]
                    == original["message"]["params"]["uniqueContextId"]
                && row["message"]["params"]["expression"]
                    == original["message"]["params"]["expression"]
        })
        .count()
}

fn dispatches(events: &[StoredEvent]) -> usize {
    events
        .iter()
        .filter(|stored| matches!(&stored.event.fact, Fact::ToolDispatched { .. }))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires native-desktop, MAKA_CUA_TEST_CHROME and a task-owned MAKA_COMPUTER_LIVE_ARTIFACT_DIR; launches only a new headless Chrome profile"]
async fn product_clipboard_page_callbacks_outlive_completed_agent_calls_and_follow_current_origin_grants()
 {
    tokio::time::timeout(Duration::from_secs(90),async {
        let browser=Browser::open().await;
        let mut run=product(&browser.endpoint).await;
        let outer=write(&run,&browser,"clipboard_agent_write","Agent Café 日本語 🐧").await;
        let before=facts(&run.store,&run.invocation.session_id).await;
        assert_eq!(browser.page("navigator.clipboard.readText()").await,"Agent Café 日本語 🐧");
        assert_eq!(browser.page("navigator.clipboard.writeText('Page Γειά 世界 🦀').then(()=>true)").await,true);
        let after=facts(&run.store,&run.invocation.session_id).await;
        assert_eq!(dispatches(&after),dispatches(&before),"page callbacks must not fabricate Agent T1 facts");
        assert!(run.effects.is_idle(),"page callbacks use Host custody, not a retained old Agent Run ticket");
        let (_,read)=evaluate(&run,"clipboard_second_agent_call","return await tab.clipboard.readText();".into()).await;
        assert_eq!(read,"Page Γειά 世界 🦀");
        let time=maka_agent_authority::now();
        origin_decision(&run,&browser,"clipboard-origin-denied",Decision::Deny,time+1).await;
        let refusal=browser.page("navigator.clipboard.readText().then(()=>({allowed:true}),error=>({allowed:false,error:error.message}))").await;
        assert_eq!(refusal,json!({"allowed":false,"error":"tool failed: Browser site access has not been granted"}));
        assert_eq!(browser.page("navigator.clipboard.writeText('revoked write must not persist').then(()=>true,()=>false)").await,false);
        origin_decision(&run,&browser,"clipboard-origin-restored",Decision::Allow,time+2).await;
        let (_,unchanged)=evaluate(&run,"clipboard_after_origin_restore","return await tab.clipboard.readText();".into()).await;
        assert_eq!(unchanged,"Page Γειά 世界 🦀");
        run.record("clipboard_actual_agent_scope_finished",json!({
            "outer":outer,"scope":"Computer.evaluate and canonical inner/outer Tool T2 completed while logical Turn remains active; not a sealed Engine Run or handoff",
            "page_to_agent":"Page Γειά 世界 🦀","denial":refusal,"page_callbacks_added_agent_dispatches":0
        })).await;
        run.close().await;
        cleanup_complete(&browser,1).await;
        let current=run.owner.store.session(&run.invocation.session_id).await.unwrap();
        let terminal=current.turn_boundary(&run.invocation.session_id,&run.invocation.turn_id).await.unwrap().unwrap();
        assert!(matches!(terminal.state.terminal_outcome(),Some(InvocationOutcome::Completed)));
        reload(&browser).await;
        assert_eq!(browser.page("globalThis.__makaVirtualClipboard===undefined").await,true,"completed Turn left a future-document clipboard hook");
        NativeOwner::close(&Service(run.owner.clone())).await.unwrap();
        assert!(run.owner.resources.is_idle());
        run.owner.store.shutdown().await.unwrap();
        browser.finish().await;
    }).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires native-desktop, MAKA_CUA_TEST_CHROME and a task-owned MAKA_COMPUTER_LIVE_ARTIFACT_DIR; launches only a new headless Chrome profile"]
async fn product_clipboard_reset_and_stop_preserve_the_same_accepted_host_reply_until_its_original_ack()
 {
    tokio::time::timeout(Duration::from_secs(90),async {
        let browser=Browser::open().await;
        let _release_on_failure=browser.wire.release.clone().drop_guard();
        let mut run=product(&browser.endpoint).await;
        write(&run,&browser,"clipboard_before_held_reply","Owned Host reply").await;
        let entry=run.owner.sessions.get(&run.invocation.session_id).unwrap();
        let gate=entry.kernel.lock().await.as_ref().unwrap().admission.clone();
        gate.check_open().unwrap();
        let before=facts(&run.store,&run.invocation.session_id).await;
        browser.wire.hold_clipboard_replies(true);
        assert_eq!(browser.page("navigator.clipboard.readText()").await,"Owned Host reply",
            "the separate page observer must see the actual promise resolve before the held CDP ACK");
        tokio::time::timeout(Duration::from_secs(5),browser.wire.held.cancelled()).await.unwrap();
        browser.wire.hold_clipboard_replies(false);
        assert_eq!(browser.wire.requests.load(Ordering::SeqCst),1);
        assert!(!browser.wire.forwarded.is_cancelled());
        assert!(run.effects.is_idle(),"automatic reply must not borrow an Agent Run's effect ticket");
        let after=facts(&run.store,&run.invocation.session_id).await;
        assert_eq!(dispatches(&after),dispatches(&before));
        let request=browser.wire.rows.lock().unwrap().iter().find(|row|row["stage"]=="request_forwarded").unwrap().clone();
        let held=browser.wire.rows.lock().unwrap().iter().find(|row|row["stage"]=="ack_held").unwrap().clone();
        assert_eq!(request["message"]["method"],"Runtime.evaluate");
        assert!(request["message"]["params"]["uniqueContextId"].is_string());
        assert_eq!(request["connection"],held["connection"]);
        assert_eq!(request["message"]["id"],held["message"]["id"]);
        assert_eq!(same_reply_requests(&browser,&request),1);
        let (_,reset)=run.invoke("clipboard_reset_with_host_reply_pending","reset",json!({})).await;
        assert_eq!(reset.unwrap()["state"],"fresh");
        assert!(matches!(gate.check_open(),Err(ToolError::Failed(message)) if message=="Computer VM has retired"));
        cleanup_complete(&browser,1).await;
        assert!(!browser.wire.lost_while_held.load(Ordering::SeqCst),"reset dropped the original reply transport");
        let (_,fresh)=evaluate(&run,"clipboard_fresh_epoch",format!(
            "var oldBinding=typeof tab;globalThis.browser=await cua.getBrowser({{id:'fixture'}});globalThis.tab=await browser.tabs.get({});return {{oldBinding,items:await tab.clipboard.read()}};",json!(browser.target)
        )).await;
        assert_eq!(fresh,json!({"oldBinding":"undefined","items":[]}));
        assert_eq!(browser.page("navigator.clipboard.readText()").await,"");
        assert_eq!(browser.wire.requests.load(Ordering::SeqCst),1);
        assert_eq!(same_reply_requests(&browser,&request),1,"pending reply must not replay after reset");
        run.close().await;
        let current=run.owner.store.session(&run.invocation.session_id).await.unwrap();
        assert!(matches!(current.turn_boundary(&run.invocation.session_id,&run.invocation.turn_id).await.unwrap().unwrap().state.terminal_outcome(),Some(InvocationOutcome::Completed)));
        let mut closing=NativeOwner::close(&Service(run.owner.clone()));
        assert!(futures_util::poll!(&mut closing).is_pending());
        cleanup_complete(&browser,2).await;
        assert!(futures_util::poll!(&mut closing).is_pending(),"Stop cannot complete Host resources before the original reply ACK");
        assert!(!run.owner.resources.is_idle());
        assert!(!browser.wire.lost_while_held.load(Ordering::SeqCst));
        run.record("clipboard_same_host_reply_pending",json!({
            "wire":browser.wire.snapshot(),"engine_run_completed":true,"native_owner_close_pending":true,
            "scope":"actual Root factory and VM Gate; the held automatic response has Host resource custody and no Agent T1"
        })).await;
        browser.wire.release.cancel();
        tokio::time::timeout(Duration::from_secs(10),&mut closing).await.expect("same original ACK must settle NativeOwner Host resources").unwrap();
        tokio::time::timeout(Duration::from_secs(5),browser.wire.forwarded.cancelled()).await.unwrap();
        assert!(run.owner.resources.is_idle());
        assert!(!browser.wire.lost_while_held.load(Ordering::SeqCst));
        assert_eq!(browser.wire.requests.load(Ordering::SeqCst),1);
        let released=browser.wire.rows.lock().unwrap().iter().find(|row|row["stage"]=="original_ack_forwarded").unwrap().clone();
        assert_eq!(released["connection"],request["connection"]);
        assert_eq!(released["id"],request["message"]["id"]);
        assert_eq!(same_reply_requests(&browser,&request),1,"Stop or release must not replay the original response");
        run.record("clipboard_same_host_reply_settled",json!({"wire":browser.wire.snapshot(),"computer_resources_idle":true})).await;
        run.owner.store.shutdown().await.unwrap();
        browser.finish().await;
    }).await.unwrap();
}
