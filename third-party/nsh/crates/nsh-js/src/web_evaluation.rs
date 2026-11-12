//! Tests the shared WebView script contract with a real JavaScript engine.
use nsh_core::{
    JsonValue,
    platform::web_evaluation::{cleanup_script, poll_script, start_script},
};
use rquickjs::{Context, Runtime};

fn run(script: &str) -> JsonValue {
    let rt = Runtime::new().unwrap();
    let cx = Context::full(&rt).unwrap();
    let reply: String = cx
        .with(|cx| cx.eval(start_script(script, "test-request")))
        .unwrap();
    let mut reply: JsonValue = serde_json::from_str(&reply).unwrap();
    while rt.execute_pending_job().unwrap() {}
    if reply["status"] == "pending" {
        let raw: String = cx.with(|cx| cx.eval(poll_script("test-request"))).unwrap();
        reply = serde_json::from_str(&raw).unwrap();
    }
    reply
}

#[test]
fn web_evaluation_returns_primitives_nested_json_and_script_completion() {
    for (script, value) in [
        ("null", serde_json::json!(null)),
        ("true", serde_json::json!(true)),
        ("42", serde_json::json!(42)),
        ("'日本語\\n'", serde_json::json!("日本語\n")),
        (
            "({a:[1,false,null,{x:'yes'}]})",
            serde_json::json!({"a":[1,false,null,{"x":"yes"}]}),
        ),
        ("var x = 4; x + 3", serde_json::json!(7)),
    ] {
        let result = run(script);
        assert_eq!(
            result,
            serde_json::json!({"status":"ok","value":value}),
            "{script}"
        );
    }
    assert_eq!(run("'__NSH_KEY__'")["value"], "__NSH_KEY__");
}

#[test]
fn web_evaluation_rejects_non_json_values_without_silent_coercion() {
    for script in [
        "undefined",
        "NaN",
        "Infinity",
        "1n",
        "(()=>{})",
        "Symbol('x')",
        "({x:undefined})",
        "[1,undefined]",
        "new Date()",
        "new Map()",
        "(()=>{const x={};x.self=x;return x})()",
    ] {
        assert_eq!(run(script)["code"], "ERR_NSH_WEBVIEW_SCRIPT", "{script}");
    }
    assert_eq!(run("'x'.repeat(1048577)")["status"], "error");
    assert_eq!(
        run("'日本語'.repeat(200000)")["code"],
        "ERR_NSH_QUOTA_EXCEEDED"
    );
}

#[test]
fn web_evaluation_awaits_promises_and_catches_throws_and_rejections() {
    assert_eq!(
        run("Promise.resolve({a:[1,2]})")["value"],
        serde_json::json!({"a":[1,2]})
    );
    for script in [
        "throw new Error('boom')",
        "Promise.reject(new Error('boom'))",
        "(()",
    ] {
        assert_eq!(run(script)["code"], "ERR_NSH_WEBVIEW_SCRIPT");
    }
}

#[test]
fn web_evaluation_correlates_out_of_order_promises_and_cleans_up() {
    let rt = Runtime::new().unwrap();
    let cx = Context::full(&rt).unwrap();
    for (key, script) in [
        ("a", "new Promise(resolve => globalThis.first = resolve)"),
        ("b", "new Promise(resolve => globalThis.second = resolve)"),
    ] {
        let raw: String = cx.with(|cx| cx.eval(start_script(script, key))).unwrap();
        assert_eq!(
            serde_json::from_str::<JsonValue>(&raw).unwrap()["status"],
            "pending"
        );
    }
    cx.with(|cx| cx.eval::<(), _>("second(2); first(1)"))
        .unwrap();
    while rt.execute_pending_job().unwrap() {}
    for (key, value) in [("a", 1), ("b", 2)] {
        let raw: String = cx.with(|cx| cx.eval(poll_script(key))).unwrap();
        assert_eq!(
            serde_json::from_str::<JsonValue>(&raw).unwrap()["value"],
            value
        );
        assert!(
            !cx.with(|cx| cx.eval::<bool, _>(format!("Object.hasOwn(globalThis, '{}')", key)))
                .unwrap()
        );
    }
    cx.with(|cx| {
        cx.eval::<String, _>(start_script(
            "new Promise(resolve => globalThis.late = resolve)",
            "cancelled",
        ))
    })
    .unwrap();
    cx.with(|cx| cx.eval::<bool, _>(cleanup_script("cancelled")))
        .unwrap();
    cx.with(|cx| cx.eval::<(), _>("late(99)")).unwrap();
    while rt.execute_pending_job().unwrap() {}
    assert!(
        !cx.with(|cx| cx.eval::<bool, _>("Object.hasOwn(globalThis, 'cancelled')"))
            .unwrap()
    );
}

#[test]
fn web_evaluation_reads_then_once_and_accepts_large_in_limit_arrays() {
    assert_eq!(
        run("({get then(){delete this.then;return resolve=>resolve(42)}})")["value"],
        42
    );
    let reply = run("Array(200000).fill(0)");
    assert_eq!(reply["status"], "ok");
    assert_eq!(reply["value"].as_array().unwrap().len(), 200000);
    assert_eq!(run("'x'.repeat(1048577)")["code"], "ERR_NSH_QUOTA_EXCEEDED");
}
