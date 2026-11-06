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

//! AppKit preview of the workbench's fake permission client, or a file-drag-only
//! surface with --application. Neither mode connects a Host or requests TCC access.

#[cfg(target_os = "macos")]
#[path = "../src/permission_application.rs"]
mod permission_application;

#[cfg(target_os = "macos")]
mod preview {
    use nsh_core::element::{Instance, Registry, class};
    use nsh_engine::{Bundle, Capabilities, EngineConfig, JsonValue, Limits, Policy};
    use nsh_platform_macos::{
        AppOptions, Appearance, Components,
        objc2::MainThreadMarker,
        objc2_app_kit::{NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility},
        quit_app, run_app_with_config, with_running_view,
    };

    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    #[class]
    struct CompletionHost {
        locale: String,
    }

    #[class]
    impl CompletionHost {
        #[getter]
        pub fn system_locale(&self) -> String {
            self.locale.clone()
        }
    }

    pub(super) fn run() -> Result<(), String> {
        let mut dark = false;
        let mut locale = None;
        let mut application = None;
        let mut arguments = std::env::args().skip(1);
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--dark" => dark = true,
                "--application" => {
                    let path = PathBuf::from(
                        arguments
                            .next()
                            .ok_or("--application requires an absolute .app path")?,
                    );
                    if !path.is_absolute() {
                        return Err("--application requires an absolute .app path".into());
                    }
                    let path = path.canonicalize().map_err(|error| error.to_string())?;
                    if path.extension().is_none_or(|ext| ext != "app")
                        || !path.join("Contents/Info.plist").is_file()
                    {
                        return Err(
                            "--application requires an application bundle with Contents/Info.plist"
                                .into(),
                        );
                    }
                    application = Some(path);
                }
                "--locale" => {
                    let value = arguments
                        .next()
                        .ok_or("--locale requires en, zh-CN or zh-TW")?;
                    if !matches!(value.as_str(), "en" | "zh-CN" | "zh-TW") {
                        return Err("--locale requires en, zh-CN or zh-TW".into());
                    }
                    locale = Some(value);
                }
                _ => return Err(format!("unknown argument: {argument}")),
            }
        }
        let locale = locale.unwrap_or_else(maka_ui_support::locale::system);
        let title = match locale.as_str() {
            "zh-CN" => "Maka — 电脑权限预览",
            "zh-TW" => "Maka — 電腦權限預覽",
            _ => "Maka permission setup preview",
        };
        let mut registry = Registry::ui_set("maka/host");
        registry.value("host", move || {
            Instance::new(CompletionHost {
                locale: locale.clone(),
            })
        });
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../workbench/tests/fixtures/computer-permission-setup.tsx")
                .canonicalize()
                .map_err(|error| error.to_string())?,
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .map_err(|error| error.to_string())?;
        let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
        let mut capabilities = Capabilities::default();
        capabilities.host = vec![
            "computerPermissions.close".into(),
            "appearance.textSize".into(),
        ];
        let app = Bundle::source(bundle.code).with_policy(Policy {
            declared: Some(capabilities),
            ..Policy::development()
        });
        let config = EngineConfig {
            ui_sets: sets,
            runtime: Some(runtime.handle().clone()),
            limits: Limits::standalone(),
            ..EngineConfig::new(app)
        };
        let components = Components::default();
        let alive = Arc::new(AtomicBool::new(true));
        if let Some(application) = &application {
            crate::permission_application::register(
                &components,
                MainThreadMarker::new().ok_or("the preview must start on AppKit's main thread")?,
                application,
                alive.clone(),
            )?;
            eprintln!(
                "Permission setup preview: native drag application={}",
                application.display()
            );
        }
        let mut params = serde_json::Map::from_iter([
            ("previewNativeWindow".into(), JsonValue::Bool(true)),
            (
                "nativeApplicationDrag".into(),
                JsonValue::Bool(application.is_some()),
            ),
        ]);
        if let Some(application) = &application {
            let name = application
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or("the preview application needs a UTF-8 bundle name")?;
            params.insert(
                "previewApplicationName".into(),
                JsonValue::String(name.into()),
            );
        }
        config.host.set_params(params);
        let closing_alive = alive.clone();
        config
            .host
            .handle("computerPermissions.close", move |call| {
                closing_alive.store(false, Ordering::Release);
                eprintln!("Permission setup preview: computerPermissions.close received");
                call.resolve(JsonValue::Null);
                quit_app();
            });
        config.host.handle("appearance.textSize", |call| {
            match call.data()["scale"].as_f64().map(|scale| scale as f32) {
                Some(scale) if scale.is_finite() && scale > 0.0 => {
                    with_running_view(move |view| view.set_font_scale(Some(scale)));
                    call.resolve(JsonValue::Null);
                }
                _ => call.reject("expected a finite positive text scale"),
            }
        });
        eprintln!(
            "Permission setup preview: {}; no Host or TCC calls",
            if application.is_some() {
                "real application file drag only; no permission status"
            } else {
                "fake permission client"
            }
        );
        with_running_view(|view| {
            if let Some(window) = view.view().window() {
                let content_size = view.view().frame().size;
                window.setStyleMask(window.styleMask() | NSWindowStyleMask::FullSizeContentView);
                window.setTitlebarAppearsTransparent(true);
                window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    if let Some(button) = window.standardWindowButton(kind) {
                        button.setHidden(true);
                    }
                }
                window.setMovableByWindowBackground(true);
                window.setContentSize(content_size);
                window.center();
            }
        });
        run_app_with_config(
            config,
            AppOptions {
                components,
                app_id: "org.apache.maka.permission-preview".into(),
                title: title.into(),
                size: (560, 640),
                min_size: Some((480, 520)),
                appearance: if dark {
                    Appearance::Dark
                } else {
                    Appearance::Light
                },
                ..Default::default()
            },
            |_| {},
        );
        alive.store(false, Ordering::Release);
        runtime.shutdown_background();
        Ok(())
    }
}

fn main() {
    #[cfg(target_os = "macos")]
    if let Err(error) = preview::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    #[cfg(not(target_os = "macos"))]
    eprintln!("This preview uses AppKit and runs only on macOS");
}
