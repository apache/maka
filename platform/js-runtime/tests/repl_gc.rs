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

use maka_agent_facts::tools::{ToolExecutor, ToolFuture};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult, CellStore};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct Fixture;

impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        vec![]
    }

    fn invoke(&self, _: String, _: Value, _: CancellationToken) -> ToolFuture {
        Box::pin(async { panic!("the GC regression must not invoke Host tools") })
    }
}

async fn evaluate(repl: &Repl, source: &str) -> (CellResult, Vec<CellOutput>) {
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            source.into(),
            Arc::new(Fixture),
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    (result, context.take_output())
}

// A separate test executable sets the process-wide flag before V8 initialization.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repl_retains_its_original_result_through_gc_and_releases_it_after_settlement() {
    deno_core::v8::V8::set_flags_from_string("--expose-gc");
    let repl = Repl::new(
        r#"
        const collect = gc;
        delete globalThis.gc;
        Object.defineProperty(globalThis, 'collect', { value: collect });
        Object.defineProperty(globalThis, 'app', { value: Object.freeze({}) });
        Object.defineProperty(globalThis, 'write', {
            value: value => emit({kind:'text', text:JSON.stringify(value)})
        });
        "#,
        CellLimits::default(),
    )
    .unwrap();

    let (result, output) = evaluate(
        &repl,
        r#"
        let target = 41;
        let collections = 0;
        Promise.resolve().then(() => { collect(); collections += 1; });
        try {
            await app.moveCursor([2600, 1300]);
            write({ok:true});
        } catch (error) {
            write({ok:false, error:String(error)});
        }
        "#,
    )
    .await;
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    let [CellOutput::Text { text }]: [CellOutput; 1] = output.try_into().unwrap() else {
        panic!("expected the caught JavaScript error output")
    };
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({"ok":false, "error":"TypeError: app.moveCursor is not a function"})
    );

    let (result, output) = evaluate(&repl, "write([++target, collections]);").await;
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    assert!(
        matches!(output.as_slice(), [CellOutput::Text { text }] if text == "[42,1]"),
        "{output:?}"
    );

    let (result, output) = evaluate(
        &repl,
        "let releasedResult = new WeakRef({value:target}); releasedResult.deref();",
    )
    .await;
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    assert!(output.is_empty(), "{output:?}");

    let (result, output) = evaluate(
        &repl,
        "collect(); write(releasedResult.deref() === undefined);",
    )
    .await;
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    assert!(
        matches!(output.as_slice(), [CellOutput::Text { text }] if text == "true"),
        "the settled result must no longer retain its completion value: {output:?}"
    );
    assert!(!repl.is_closed());
    repl.close().await.unwrap();
}
