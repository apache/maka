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

//! The shared NSH bootstrap and native Host bindings used by each shell.
//! The deployment selects its root UI from ordinary installed packages.

mod attachment_paths;
pub mod bindings;
mod clipboard;
mod composer_input;
pub mod host;
pub mod quick_tools;
pub mod reload;

use nsh_engine::{Bundle, Capabilities, EngineConfig, Limits, Policy};
use tokio::sync::watch;

/// Whether the terminal or window the workbench shows in is in the
/// foreground; the shell puts it in the engine context. Without one the
/// workbench counts as in the background.
#[derive(Clone)]
pub struct Foreground(pub watch::Receiver<bool>);

/// Reads and previews interface scale from the shell's pixel renderer.
/// The shell puts it in the engine context.
pub struct UiScale {
    pub preview: Box<dyn Fn(f32) -> Result<(), String> + Send + Sync>,
    pub current: Box<dyn Fn() -> Result<f32, String> + Send + Sync>,
}

/// The common loader for trusted UI packages, without a product root or assets.
pub fn bootstrap_bundle() -> Bundle {
    let mut capabilities = Capabilities::all();
    capabilities.host = vec!["*".into()];
    quick_tools_capabilities(&mut capabilities);
    Bundle::source(include_str!(concat!(env!("OUT_DIR"), "/bootstrap.js")).into()).with_policy(
        Policy {
            declared: Some(capabilities),
            ..Policy::development()
        },
    )
}

/// The dedicated, trusted system-permission surface; it observes original interactions.
fn system_permission_bundle() -> Bundle {
    let mut capabilities = Capabilities::all();
    capabilities.host = vec![
        "computerPermissions.close".into(),
        "appearance.textSize".into(),
    ];
    Bundle::source(include_str!(concat!(env!("OUT_DIR"), "/computer-permission-setup.js")).into())
        .with_policy(Policy {
            declared: Some(capabilities),
            ..Policy::development()
        })
}

// Quick Tools runs in the trusted local UI VM, never in a remote Host.
fn quick_tools_capabilities(capabilities: &mut Capabilities) {
    capabilities.host.push("quickTools.*".into());
    capabilities.fs.read = vec![
        "${dataDir}".into(),
        "/Applications".into(),
        "/System/Applications".into(),
        "${homeDir}".into(),
    ];
    capabilities.fs.write = vec!["${dataDir}".into()];
    capabilities.process.execute = vec![
        "/usr/bin/open".into(),
        "/usr/bin/mdfind".into(),
        "/usr/sbin/screencapture".into(),
        "/bin/chmod".into(),
        "xdg-open".into(),
    ];
    capabilities.process.env = vec!["MAKA_QUICK_NATIVE".into()];
    if let Some(helper) = std::env::var_os("MAKA_QUICK_NATIVE") {
        let helper = std::path::PathBuf::from(helper);
        if helper.is_absolute() {
            capabilities
                .process
                .execute
                .push(helper.to_string_lossy().into_owned());
        }
    }
}

/// Runs the UI bootstrap with the admitted Host bindings on `runtime`.
/// The backend sets the viewport and environment it presents in.
pub fn configuration(
    registry: nsh_core::element::Registry,
    runtime: tokio::runtime::Handle,
) -> EngineConfig {
    EngineConfig {
        header_heights: nsh_core::NO_NATIVE_HEADER,
        limits: Limits::standalone(),
        ui_sets: vec![nsh_base::registry(), registry],
        network: Some(nsh_engine::net::network()),
        runtime: Some(runtime),
        ..EngineConfig::new(bootstrap_bundle())
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{
        Size,
        element::Instance,
        platform::{Environment, Os},
        prelude::px,
    };

    #[nsh_core::element::class]
    struct CompletionHost;

    #[nsh_core::element::class]
    impl CompletionHost {
        #[getter]
        pub fn system_locale(&self) -> String {
            "en".into()
        }
    }

    #[test]
    fn recycled_completion_cells_refresh_labels_and_press_actions() {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/composer-completion.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        let mut app = nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(480.0), px(200.0)),
            environment: Environment {
                os: Os::MacOs,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap();

        app.wait_for("role:button[skill-00]").unwrap();
        app.scroll("label:Skills", px(900.0)).unwrap();
        app.wait_for("text:/Description of skill-15/").unwrap();
        app.press("role:button[skill-15]").unwrap();
        app.wait_for("text:/1:skill:skill-15/").unwrap();

        app.press("id:refresh").unwrap();
        app.press("role:button[skill-15]").unwrap();
        app.wait_for("text:/2:skill:skill-15/").unwrap();
    }
    #[test]
    fn independent_quick_panel_follows_language_and_appearance() {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/quick-preferences.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let main = nsh_engine::HostChannel::new();
        let panel = nsh_engine::HostChannel::new();
        main.set_params(
            serde_json::from_value(serde_json::json!({"nativeQuickTools":true})).unwrap(),
        );
        panel.set_params(
            serde_json::from_value(serde_json::json!({"quickToolsPanel":true})).unwrap(),
        );
        for (source, target) in [(&main, &panel), (&panel, &main)] {
            let target = target.clone();
            source.handle("quickTools.preferences.update", move |call| {
                target
                    .send("quickTools.preferences", call.data().clone())
                    .unwrap();
                call.resolve(serde_json::Value::Null);
            });
            source.handle("quickTools.preferences.read", |call| {
                call.resolve(serde_json::Value::Null)
            });
        }
        let mut capabilities = nsh_engine::Capabilities::all();
        super::quick_tools_capabilities(&mut capabilities);
        let config = |host, name| nsh_engine::EngineConfig {
            ui_sets: sets.clone(),
            host,
            data_dir: Some(root.path().join(name)),
            environment: Environment {
                os: Os::MacOs,
                ..Environment::default()
            },
            ..nsh_engine::EngineConfig::new(
                nsh_engine::Bundle::source(bundle.code.clone()).with_policy(nsh_engine::Policy {
                    declared: Some(capabilities.clone()),
                    ..nsh_engine::Policy::development()
                }),
            )
        };
        let mut first = nsh_testing::Headless::start(config(main.clone(), "main")).unwrap();
        let mut second = nsh_testing::Headless::start(config(panel.clone(), "panel")).unwrap();
        first.wait_for("id:chinese").unwrap();
        first.press("id:chinese").unwrap();
        first.press("id:dark").unwrap();
        first.wait_for("text:zh-CN|dark|default").unwrap();
        second.wait_for("text:zh-CN|dark|default").unwrap();
        second.press("id:sage").unwrap();
        first.wait_for("text:zh-CN|dark|sage").unwrap();
        first.press("id:english").unwrap();
        second.wait_for("text:en|dark|sage").unwrap();
        main.remove_handler("quickTools.preferences.update");
        panel.remove_handler("quickTools.preferences.update");
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn native_quick_tools_search_and_language() {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/quick-tools.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let mut capabilities = nsh_engine::Capabilities::all();
        super::quick_tools_capabilities(&mut capabilities);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut config = nsh_engine::EngineConfig {
            viewport: Size::new(px(900.0), px(700.0)),
            environment: Environment {
                os: Os::MacOs,
                native_focus_scopes: true,
                ..Environment::default()
            },
            ui_sets: sets,
            data_dir: Some(root.path().to_path_buf()),
            runtime: Some(runtime.handle().clone()),
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code).with_policy(
                nsh_engine::Policy {
                    declared: Some(capabilities),
                    ..nsh_engine::Policy::development()
                },
            ))
        };
        super::quick_tools::attach(&mut config);
        config.host.handle("quickTools.package.pick", |call| {
            let bundle=serde_json::json!({"format":1,"manifest":{
                "apiVersion":1,"id":"test.external","name":"External plugin","version":"1.0.0",
                "description":"Native isolated plugin regression","permissions":[],
                "commands":[{"id":"open","name":"External plugin","kind":"Tool","actions":[{"id":"open","title":"Open"}]}]
            },"code":r#"module.exports.default=async ctx=>{
                let state=await ctx.storage.read({count:0});
                return {run:async()=>{state.count++;await ctx.storage.write(state);return {navigate:'home'};},
                    view:()=>({title:'External plugin',rows:[{id:'count',name:'Persisted '+state.count,actions:[]}]})};
            };"#});
            call.resolve(serde_json::Value::String(bundle.to_string()));
        });
        config
            .host
            .handle("quickTools.shortcuts.configure", |call| {
                call.resolve(serde_json::Value::Null)
            });
        let mut app = nsh_testing::Headless::start(config).unwrap();
        app.wait_for("role:button[Quicklinks]").unwrap();
        assert!(
            !app.screen()
                .texts()
                .iter()
                .any(|text| text.starts_with("Error:")),
            "{:?}",
            app.screen().texts()
        );
        app.press("role:button[Quicklinks]").unwrap();
        app.press("role:button[Open ↵]").unwrap();
        app.wait_for("role:button[Create]").unwrap();
        app.press("role:button[Create]").unwrap();
        app.type_text("label:Name", "Example Search").unwrap();
        app.press("role:button[Cancel]").unwrap();
        app.press("role:button[Create]").unwrap();

        let target = "label:Target (website, app deep link, or file path)";
        app.type_text(target, "https://").unwrap();
        app.press("role:button[Save]").unwrap();
        app.wait_for("text:Add a domain to the URL, for example https://example.com.")
            .unwrap();
        app.clear(target).unwrap();
        assert!(
            !app.screen()
                .texts()
                .iter()
                .any(|text| text.contains("Add a domain"))
        );
        app.type_text(target, "example.com/search?q={argument name=\"Query\"}")
            .unwrap();
        app.press("role:button[Save]").unwrap();
        app.wait_for("role:button[Example Search]").unwrap();
        let saved: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("default/quick-tools/maka.links.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(saved[0]["name"], "Example Search");
        assert_eq!(
            saved[0]["target"],
            "example.com/search?q={argument name=\"Query\"}"
        );
        app.press("role:button[Actions ⌘ K]").unwrap();
        app.type_text("label:Search actions", "Settings").unwrap();
        app.press("role:button[Settings]").unwrap();
        app.wait_for("label:Alias").unwrap();
        app.type_text("label:Alias", "example-alias").unwrap();
        app.press("role:checkbox[Favorite]").unwrap();
        app.press("role:button[Save]").unwrap();
        app.wait_for("role:button[Item settings]").unwrap();
        let preferences: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("default/quick-tools/preferences.json"))
                .unwrap(),
        )
        .unwrap();
        assert!(
            preferences
                .as_object()
                .unwrap()
                .values()
                .any(|value| value["alias"] == "example-alias" && value["favorite"] == true)
        );

        app.press("role:button[Back]").unwrap();
        app.type_text("label:Search", "example-alias").unwrap();
        app.wait_for("role:button[Example Search]").unwrap();
        app.press("role:button[Open ↵]").unwrap();
        app.wait_for("label:Query").unwrap();
        app.press("role:button[Cancel]").unwrap();
        let key = format!("maka.links:{}", saved[0]["id"].as_str().unwrap());
        app.send_host_event("quickTools.execute", serde_json::json!({"id":key}))
            .unwrap();
        app.wait_for("label:Query").unwrap();
        app.press("role:button[Cancel]").unwrap();
        app.press("role:button[Quick Tools Settings]").unwrap();
        app.press("role:button[Install plugin]").unwrap();
        app.wait_for("role:button[Install]").unwrap();
        app.press("role:button[Install]").unwrap();
        app.wait_for("role:button[Plugin details: External plugin]")
            .unwrap();
        app.press("role:button[Back]").unwrap();
        app.wait_for("role:button[External plugin]").unwrap();
        app.press("role:button[External plugin]").unwrap();
        app.press("role:button[Open ↵]").unwrap();
        app.wait_for("role:button[Persisted 1]").unwrap();
        let external: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.path().join("default/quick-tools/test.external.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(external["count"], 1);
        app.press("role:button[Back]").unwrap();
        app.type_text("label:Search", "2+2").unwrap();
        app.wait_for("role:button[4]").unwrap();
        app.press("role:button[4]").unwrap();
        app.press("role:button[Item settings]").unwrap();
        app.type_text("label:Alias", "my-sum").unwrap();
        app.press("role:button[Save]").unwrap();
        app.send_host_event(
            "quickTools.visibility",
            serde_json::json!({"visible":true,"home":true}),
        )
        .unwrap();
        app.type_text("label:Search", "my-sum").unwrap();
        app.wait_for("role:button[4]").unwrap();
        app.send_host_event(
            "quickTools.visibility",
            serde_json::json!({"visible":true,"home":true}),
        )
        .unwrap();
        app.send_host_event(
            "quickTools.visibility",
            serde_json::json!({"visible":false}),
        )
        .unwrap();
        app.press("id:chinese").unwrap();
        app.press("id:reopen").unwrap();
        app.wait_for("role:button[快捷链接]").unwrap();
    }

    #[test]
    fn skills_edit_as_units_and_sent_messages_preserve_copy_and_shortcuts() {
        let mut registry = crate::bindings::ui_registry();
        registry.value("host", || Instance::new(CompletionHost));
        let sets = vec![nsh_base::registry(), registry];
        let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
            entry: std::path::Path::new("tests/fixtures/skill-input.tsx")
                .canonicalize()
                .unwrap(),
            minify: false,
            split: false,
            ui_sets: sets.iter().map(Into::into).collect(),
        })
        .unwrap();
        let mut app = nsh_testing::Headless::start(nsh_engine::EngineConfig {
            viewport: Size::new(px(640.0), px(480.0)),
            environment: Environment {
                os: Os::MacOs,
                ..Environment::default()
            },
            ui_sets: sets,
            ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
        })
        .unwrap();
        app.wait_for("text:Ready").unwrap();
        app.type_text("label:Draft", "").unwrap();
        for key in ["left", "left", "left", "shift+right", "mod+c"] {
            app.press_key(key).unwrap();
        }
        assert_eq!(app.screen().clipboard(), Some("/skill:review"));
        app.press_key("backspace").unwrap();
        app.wait_for(r#"text:Draft "前😀  后""#).unwrap();
        app.press_key("mod+z").unwrap();
        app.wait_for(r#"text:Draft "前😀 /skill:review 后""#)
            .unwrap();
        app.press_key("mod+a").unwrap();
        let mut paste = nsh_core::PasteEvent::new("a\nb");
        paste.html = "<pre>a\nb</pre>".into();
        app.paste("label:Draft", &paste).unwrap();
        app.wait_for(r#"text:Draft "a\nb""#).unwrap();
        let input = app
            .screen()
            .commands()
            .iter()
            .rev()
            .find_map(|(id, command)| matches!(command, nsh_core::Command::Focus).then_some(*id))
            .unwrap();
        let compose = |app: &mut nsh_testing::Headless, active| {
            app.engine().control().dispatch_event(
                input,
                nsh_core::EventKind::CompositionChange,
                nsh_core::EventPayload::Map(vec![
                    ("composing", nsh_core::PayloadValue::Bool(active)),
                    ("text", nsh_core::PayloadValue::Str(String::new())),
                ]),
            );
            app.wait_for(if active {
                "text:Composing"
            } else {
                "text:Idle"
            })
            .unwrap();
        };
        compose(&mut app, true);
        app.press_key("left").unwrap();
        app.wait_for("text:IME key released").unwrap();
        app.press("label:Reset").unwrap();
        app.wait_for(r#"text:Draft """#).unwrap();
        compose(&mut app, false);
        app.press_key("mod+z").unwrap();
        assert!(app.shows("Draft \"\""));
        app.press_key("mod+i").unwrap();
        app.wait_for(r#"text:Draft "/skill:fix ""#).unwrap();
        app.press_key("enter").unwrap();
        app.wait_for(r#"text:Submitted "/skill:fix ""#).unwrap();
        app.press_key("mod+a").unwrap();
        app.paste("label:Draft", &nsh_core::PasteEvent::new("ab"))
            .unwrap();
        compose(&mut app, true);
        app.press("label:Reset").unwrap();
        app.wait_for(r#"text:Draft """#).unwrap();
        app.engine().control().dispatch_event(
            input,
            nsh_core::EventKind::ChangeText,
            nsh_core::EventPayload::Text {
                text: "文".into(),
                count: 0,
            },
        );
        compose(&mut app, false);
        app.wait_for(r#"text:Draft "ab文""#).unwrap();
        assert!(app.type_text("label:前😀 /skill:review 后", "x").is_err());
        app.press("text:/前😀/").unwrap();
        app.press_key("mod+a").unwrap();
        app.press_key("mod+c").unwrap();
        assert_eq!(app.screen().clipboard(), Some("前😀 /skill:review 后"));
        app.press_key("mod+n").unwrap();
        app.wait_for("text:Shortcut received").unwrap();
    }
}
