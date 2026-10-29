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

use maka_agent_facts::tools::{ToolError, ToolExecutor, ToolFuture};
use maka_code_runtime::{CellContext, CellLimits, CellResult, CellStore};
use maka_computer_use::facade;
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

struct ContextFixture(Arc<Mutex<Vec<Value>>>);
impl ToolExecutor for ContextFixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        let calls = self.0.clone();
        Box::pin(async move {
            serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            calls
                .lock()
                .expect("fixture calls mutex poisoned")
                .push(input.clone());
            Ok(match input["method"].as_str() {
                Some("documentation") => json!("Authored user-tab context fixture"),
                Some("getBrowser") => json!({"id":"fixture","apiProfile":{"user":true}}),
                Some("browserUserGetTabContext") => {
                    assert_eq!(input["browserId"], "fixture");
                    assert_eq!(input["tabId"], "17");
                    json!({"kind":"document","title":"T","url":"https://example.test/",
                        "fileName":"T.pdf","mimeType":"application/pdf","dataBase64":"JVBERi0x",
                        "path":"/host/session/T.pdf"})
                }
                other => panic!("unexpected context fixture command {other:?}"),
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_tab_context_keeps_document_bytes_and_never_binds_the_user_tab() {
    let repl = Repl::new(facade(), CellLimits::default()).expect("create context REPL");
    let calls = Arc::new(Mutex::new(Vec::new()));
    let cell = CellContext::new(CellStore::temporary().expect("create cell store"), vec![])
        .expect("create cell context");
    let result = repl.evaluate(r#"
        const browser=await cua.getBrowser({id:'fixture'});
        for (const [input,expected] of [
          ['', 'browser.user.getTabContext received an empty tab id'],
          [17, 'browser.user.getTabContext expects a tab returned by browser.user.openTabs() or a tab id']
        ]) {
          let error;
          try { await browser.user.getTabContext(input); } catch (caught) { error=caught; }
          if (!error || error.message!==expected) throw Error('wrong invalid tab reference failure');
        }
        const context=await browser.user.getTabContext({id:'17'});
        if (!(context.data instanceof Uint8Array) || JSON.stringify([...context.data])!=='[37,80,68,70,45,49]') throw Error('wrong actual document bytes');
        if (context.path!=='/host/session/T.pdf' || 'dataBase64' in context) throw Error('wrong public document shape');
        if (context.title!=='T' || context.url!=='https://example.test/') throw Error('document identity changed');
    "#.into(),Arc::new(ContextFixture(calls.clone())),CancellationToken::new(),cell,Duration::from_secs(5))
        .await.expect("evaluate context fixture");
    assert!(
        matches!(result, CellResult::Success { .. }),
        "context fixture failed: {result:?}"
    );
    let actual: Vec<_> = calls
        .lock()
        .expect("fixture calls mutex poisoned")
        .iter()
        .map(|value| value["method"].as_str().expect("fixture method").to_owned())
        .collect();
    assert_eq!(
        actual,
        ["getBrowser", "documentation", "browserUserGetTabContext"],
        "context must not claim, focus, bind or observe a user tab"
    );
}
