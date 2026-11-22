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

use deno_core::{JsRuntime, RuntimeOptions};
use deno_error::JsErrorBox;
use deno_permissions::{PermissionsContainer, RuntimePermissionDescriptorParser};
use std::{io::Read, process::ExitCode, rc::Rc, sync::Arc};

pub const WORKER: &str = "__maka-automation-script";

/// The CLI invokes this only in a fresh process. Its parent owns the sandbox and process tree.
pub fn run() -> ExitCode {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        rustls::crypto::aws_lc_rs::default_provider()
            .install_default()
            .map_err(|_| "Automation TLS provider already initialized")?;
        let mut source = String::new();
        std::io::stdin().read_to_string(&mut source)?;
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(evaluate(source))
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

async fn evaluate(source: String) -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let main = deno_core::resolve_path(".maka-automation.ts", &cwd)?;
    let loader = loader::Loader::new(cwd, main.clone(), source).await?;
    let fs = deno_fs::sync::MaybeArc::new(deno_fs::RealFs);
    let mut extensions = vec![
        deno_webidl::deno_webidl::init(),
        deno_web::deno_web::init(
            Arc::new(deno_web::BlobStore::default()),
            None,
            false,
            Default::default(),
        ),
        deno_telemetry::deno_telemetry::init(),
        deno_io::deno_io::init(Some(Default::default())),
        deno_fs::deno_fs::init(fs.clone()),
        deno_os::deno_os::init(Some(Default::default())),
        deno_process::deno_process::init(None),
        deno_net::deno_net::init(None, None),
        deno_fetch::deno_fetch::init(Default::default()),
        deno_websocket::deno_websocket::init(),
        deno_http::deno_http::init(Default::default()),
        deno_crypto::deno_crypto::init(None),
        deno_node_crypto::deno_node_crypto::init(),
        deno_node::deno_node::init(Some(loader.node_services()?), fs),
    ];
    crate::embedded::embed(&mut extensions)?;
    extensions.extend([
        deno_napi::deno_napi::init(None),
        deno_node_sqlite::deno_node_sqlite::init(),
        node_host::maka_automation_node_host::init(),
    ]);
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions,
        module_loader: Some(Rc::new(loader)),
        inspector: true,
        ..Default::default()
    })?;
    let inspector = runtime.inspector();
    runtime.op_state().borrow_mut().put(inspector);
    runtime
        .op_state()
        .borrow_mut()
        .put(PermissionsContainer::allow_all(Arc::new(
            RuntimePermissionDescriptorParser::new(sys_traits::impls::RealSys),
        )));
    runtime.execute_script(
        "maka:automation/bootstrap",
        format!(
            "const bootstrap = {}\nbootstrap({}, {}, {});",
            include_str!("automation/bootstrap.js"),
            serde_json::to_string(main.as_str())?,
            serde_json::to_string(env!("MAKA_DENO_TARGET"))?,
            serde_json::to_string(deno_core::v8::V8::get_version())?,
        ),
    )?;
    let id = runtime.load_main_es_module(&main).await?;
    let evaluation = runtime.mod_evaluate(id);
    runtime.run_event_loop(Default::default()).await?;
    evaluation.await?;
    Ok(())
}

#[path = "automation/loader.rs"]
mod loader;
#[path = "automation/node_host.rs"]
mod node_host;

fn js_error(error: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(error.to_string())
}
