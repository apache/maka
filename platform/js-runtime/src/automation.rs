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

use deno_core::{
    JsRuntime, ModuleLoadOptions, ModuleLoadReferrer, ModuleLoadResponse, ModuleLoader,
    ModuleSource, ModuleSourceCode, ModuleSpecifier, ModuleType, ResolutionKind, RuntimeOptions,
};
use deno_error::JsErrorBox;
use deno_permissions::{PermissionsContainer, RuntimePermissionDescriptorParser};
use std::{io::Read, path::Path, process::ExitCode, rc::Rc, sync::Arc};

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
        deno_fs::deno_fs::init(deno_fs::sync::MaybeArc::new(deno_fs::RealFs)),
        deno_os::deno_os::init(Some(Default::default())),
        deno_process::deno_process::init(None),
        deno_net::deno_net::init(None, None),
        deno_fetch::deno_fetch::init(Default::default()),
    ];
    crate::embedded::embed(&mut extensions)?;
    let mut runtime = JsRuntime::try_new(RuntimeOptions {
        extensions,
        module_loader: Some(Rc::new(Loader)),
        ..Default::default()
    })?;
    runtime
        .op_state()
        .borrow_mut()
        .put(PermissionsContainer::allow_all(Arc::new(
            RuntimePermissionDescriptorParser::new(sys_traits::impls::RealSys),
        )));
    runtime.execute_script(
        "maka:automation/bootstrap",
        include_str!("automation/bootstrap.js"),
    )?;
    let path = std::env::current_dir()?.join(".maka-automation.ts");
    let main = deno_core::resolve_path(&path.to_string_lossy(), Path::new("."))?;
    let source = typescript::transpile(&source, &path)?;
    let id = runtime.load_main_es_module_from_code(&main, source).await?;
    let evaluation = runtime.mod_evaluate(id);
    runtime.run_event_loop(Default::default()).await?;
    evaluation.await?;
    Ok(())
}

struct Loader;

impl ModuleLoader for Loader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _: ResolutionKind,
    ) -> Result<ModuleSpecifier, JsErrorBox> {
        deno_core::resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        _: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        let specifier = specifier.clone();
        ModuleLoadResponse::Async(Box::pin(async move {
            let (source, found) = match specifier.scheme() {
                "file" => {
                    let path = specifier
                        .to_file_path()
                        .map_err(|_| JsErrorBox::generic("Invalid module file path"))?;
                    (
                        tokio::fs::read_to_string(path).await.map_err(js_error)?,
                        specifier.clone(),
                    )
                }
                "http" | "https" => {
                    let response = reqwest::get(specifier.clone())
                        .await
                        .map_err(js_error)?
                        .error_for_status()
                        .map_err(js_error)?;
                    let found = response.url().clone();
                    (response.text().await.map_err(js_error)?, found)
                }
                scheme => {
                    return Err(JsErrorBox::generic(format!(
                        "Unsupported module scheme: {scheme}"
                    )));
                }
            };
            let path = Path::new(found.path());
            let (source, kind) = if matches!(
                options.requested_module_type,
                deno_core::RequestedModuleType::Json
            ) {
                (source, ModuleType::Json)
            } else if matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("ts" | "mts" | "cts")
            ) {
                (
                    typescript::transpile(&source, path).map_err(js_error)?,
                    ModuleType::JavaScript,
                )
            } else {
                (source, ModuleType::JavaScript)
            };
            Ok(ModuleSource::new_with_redirect(
                kind,
                ModuleSourceCode::String(source.into()),
                &specifier,
                &found,
                None,
            ))
        }))
    }
}

#[path = "automation/transpile.rs"]
mod typescript;

fn js_error(error: impl std::fmt::Display) -> JsErrorBox {
    JsErrorBox::generic(error.to_string())
}
