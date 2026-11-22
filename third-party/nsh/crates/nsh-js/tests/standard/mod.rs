//! Behavioral conformance at the public NSH Host boundary.
//!
//! Fixtures use only in-memory standard modules: no filesystem, subprocess,
//! network, clocks or random outputs. Module APIs were checked against LLRT
//! d9fd873e793c6551c5d92b2e31480f3279e3cd8d.

mod imports;
mod safety;
mod utilities;

use nsh_core::Op;
use nsh_js::Host;

/// Evaluate a real ESM import in the application's VM and read its native text
/// output. A fresh Host isolates globals, listeners and module state per test.
fn run(script: &str) -> String {
    let host = Host::new().expect("create test Host");
    host.eval_source(&format!(
        "import {{ text as __report }} from 'nsh:rt';\n{script}\n__report(JSON.stringify(globalThis.out));"
    ))
    .expect("evaluate standard module fixture");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        host.run_system();
        host.run_timers(nsh_core::time::Instant::now());
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        if let Some(output) = ops.into_iter().rev().find_map(|op| match op {
            Op::CreateText { text, .. } => Some(text.to_string()),
            _ => None,
        }) {
            return output;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "standard module fixture did not settle"
        );
        // The production engine is woken by the host. This isolated test has no
        // engine, so bounded pumping stands in for that wake delivery.
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}
