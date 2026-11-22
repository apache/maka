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
use maka_code_runtime::{CellContext, CellLimits, CellResult, CellStore};
use maka_js_runtime::CodeExecutor;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

struct Tools<F>(F);
impl<F> ToolExecutor for Tools<F>
where
    F: Fn(Value) -> ToolFuture + Send + Sync + 'static,
{
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }
    fn invoke(&self, _: String, value: Value, _: CancellationToken) -> ToolFuture {
        (self.0)(value)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn json_numbers_survive_tool_roundtrip_and_sealed_cell_draft() {
    let payload = json!({
        "nested":[42, {"fraction":1.25, "negative":-7}],
        "timestamp":1_790_320_333_732_i64,
        "safe":9_007_199_254_740_991_i64,
        "minSafe":-9_007_199_254_740_991_i64,
        "wide":1_u64 << 60
    });
    let tools = Arc::new(Tools(move |value: Value| -> ToolFuture {
        let payload = payload.clone();
        Box::pin(async move { Ok(if value.is_null() { payload } else { value }) })
    }));
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    let result = engine
        .execute_with_context(
            r#"
        const value = await tools.echo(null);
        if (![value.timestamp, value.safe, value.minSafe, value.wide,
              value.nested[0], value.nested[1].fraction].every(v => typeof v === 'number'))
            throw Error('JSON numbers changed type');
        if (value.safe !== Number.MAX_SAFE_INTEGER || value.minSafe !== Number.MIN_SAFE_INTEGER
            || value.wide !== 2 ** 60 || value.nested[1].fraction + 0.75 !== 2)
            throw Error('JSON number changed value');
        const echoed = await tools.echo(value);
        store('numbers', echoed);
        const loaded = load('numbers');
        if (loaded.timestamp !== 1790320333732 || loaded.wide !== 2 ** 60)
            throw Error('cell draft changed a number');
        return loaded.nested[0] + 1;
        "#
            .into(),
            tools,
            CancellationToken::new(),
            context.clone(),
        )
        .await
        .unwrap();
    let CellResult::Success { value, .. } = result else {
        panic!("{result:?}")
    };
    assert_eq!(value, json!(43));
    let draft = context.take_draft().unwrap();
    let stored: Value = serde_json::from_slice(&draft.values["numbers"]).unwrap();
    assert_eq!(stored["timestamp"].as_i64(), Some(1_790_320_333_732));
    assert_eq!(stored["safe"].as_i64(), Some(9_007_199_254_740_991));
    assert_eq!(stored["minSafe"].as_i64(), Some(-9_007_199_254_740_991));
    assert_eq!(stored["wide"].as_f64(), Some((1_u64 << 60) as f64));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_and_non_json_inputs_stop_before_tool_or_draft_dispatch() {
    let dispatched = Arc::new(AtomicUsize::new(0));
    let tools = {
        let dispatched = dispatched.clone();
        Arc::new(Tools(move |value| -> ToolFuture {
            dispatched.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(value) })
        }))
    };
    let engine = CodeExecutor::new(CellLimits::default()).unwrap();
    for source in [
        "await tools.echo({ get x() { exit(); } }); throw Error('unreachable');",
        "tools.echo({ get x() { exit(); } }); throw Error('unreachable');",
        "store('aborted', { get x() { exit(); } }); throw Error('unreachable');",
    ] {
        let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = engine
            .execute_with_context(
                source.into(),
                tools.clone(),
                CancellationToken::new(),
                context.clone(),
            )
            .await
            .unwrap();
        let CellResult::Success { value, tool_calls } = result else {
            panic!("{source}: {result:?}")
        };
        assert_eq!(value, Value::Null);
        assert!(tool_calls.is_empty(), "{source}: {tool_calls:?}");
        assert!(context.take_draft().unwrap().values.is_empty());
    }
    let result = engine
        .execute(
            r#"
        const cyclic = {};
        cyclic.self = cyclic;
        for (const bad of [1n, cyclic, Symbol('x')]) {
            let rejected = false;
            try { await tools.echo(bad); } catch { rejected = true; }
            if (!rejected) throw Error('non-JSON input was dispatched');
        }
        return true;
        "#
            .into(),
            tools,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let CellResult::Success { value, tool_calls } = result else {
        panic!("{result:?}")
    };
    assert_eq!(value, json!(true));
    assert!(tool_calls.is_empty(), "{tool_calls:?}");
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn array_buffer_allocations_are_bounded_by_heap_limit() {
    let tools = Arc::new(Tools(|value: Value| -> ToolFuture {
        Box::pin(async move { Ok(value) })
    }));
    let limits = CellLimits {
        heap_bytes: 16 * 1024 * 1024,
        ..CellLimits::default()
    };
    let engine = CodeExecutor::new(limits).unwrap();

    // Finite allocation within budget succeeds and exercises normal ArrayBuffer views/slice.
    let within = engine
        .execute(
            r#"
            const buf = new ArrayBuffer(8 * 1024 * 1024);
            const view = new Uint8Array(buf);
            view[0] = 7;
            const copy = buf.slice(0, 4);
            return { len: buf.byteLength, copyLen: copy.byteLength, first: new Uint8Array(copy)[0] };
            "#
            .into(),
            tools.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let CellResult::Success { value, .. } = within else {
        panic!("expected in-budget ArrayBuffer allocation to succeed, got {within:?}");
    };
    assert_eq!(
        value,
        json!({ "len": 8 * 1024 * 1024, "copyLen": 4, "first": 7 })
    );

    // Finite single-shot and cumulative allocations exceeding the 16 MiB budget are rejected
    // immediately (either as a catchable RangeError from the allocator or V8's heap-limit abort
    // triggered by allocator refusal — never succeeding and never timing out).
    for (label, source) in [
        (
            "single-shot",
            "new ArrayBuffer(17 * 1024 * 1024); return 'allowed';",
        ),
        (
            "cumulative",
            "const a = new Uint8Array(6 * 1024 * 1024); const b = new Uint8Array(6 * 1024 * 1024); const c = new Uint8Array(6 * 1024 * 1024); return a.byteLength + b.byteLength + c.byteLength;",
        ),
    ] {
        let outcome = engine
            .execute(source.into(), tools.clone(), CancellationToken::new())
            .await
            .unwrap();
        match outcome {
            CellResult::Failure { error, .. }
                if matches!(
                    error.kind,
                    maka_code_runtime::CellDiagnosticKind::LimitExceeded
                        | maka_code_runtime::CellDiagnosticKind::ExecutionError
                ) => {}
            other => panic!(
                "{label} over-budget allocation must fail via budget/heap rejection, got {other:?}"
            ),
        }
    }

    // Resizable ArrayBuffers bypass V8's ArrayBuffer::Allocator and must be disabled across all entry points.
    let resizable = engine
        .execute(
            r#"
            const results = {};
            const check = (key, fn) => {
                try { fn(); results[key] = "allowed"; }
                catch (err) { results[key] = err.name; }
            };
            check("direct", () => new ArrayBuffer(1024, { maxByteLength: 32 * 1024 * 1024 }));
            check("protoCtor", () => {
                const Ctor = new Uint8Array(8).buffer.constructor;
                return new Ctor(1024, { maxByteLength: 32 * 1024 * 1024 });
            });
            check("reflect", () => Reflect.construct(ArrayBuffer, [1024, { maxByteLength: 32 * 1024 * 1024 }]));
            check("subclass", () => {
                class SubAB extends ArrayBuffer {}
                return new SubAB(1024, { maxByteLength: 32 * 1024 * 1024 });
            });
            results.hasResize = "resize" in ArrayBuffer.prototype;
            return results;
            "#
            .into(),
            tools.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let CellResult::Success { value, .. } = resizable else {
        panic!("expected resizable ArrayBuffer check to complete, got {resizable:?}");
    };
    assert_eq!(
        value,
        json!({
            "direct": "RangeError",
            "protoCtor": "RangeError",
            "reflect": "RangeError",
            "subclass": "RangeError",
            "hasResize": false
        })
    );

    // Subsequent healthy cell execution must still succeed cleanly.
    let healthy = engine
        .execute("return 21 + 21;".into(), tools, CancellationToken::new())
        .await
        .unwrap();
    let CellResult::Success { value, .. } = healthy else {
        panic!("expected healthy cell after budget tests, got {healthy:?}");
    };
    assert_eq!(value, json!(42));
}
