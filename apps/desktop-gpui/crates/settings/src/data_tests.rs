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

//! The Data page and its configuration file against Maka Desktop's own:
//! the files and Host transcripts in fixtures/config_transfer were recorded
//! by running Desktop's `config:export` and `config:import` handlers under
//! Node over a fake Host that checks every request and answer with the
//! protocol's decoders (scripts/config-transfer-fixtures.sh). An export
//! here replays Desktop's export transcript and must write Desktop's file;
//! an import of Desktop's file replays Desktop's import transcript and must
//! send the Host the same writes, in the same order, and report the same;
//! and Desktop's import of the files written here (`gpui_export_*.json`)
//! must do what it does with its own.
//!
//! `MAKA_WRITE_CONFIG_FIXTURES=1` writes `gpui_export_*.json` afresh; run
//! the script after it to record Desktop importing them.

// The fixtures and the files the dialogs pick are read and written directly;
// no UI thread is involved.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_lite::future::{Boxed, block_on};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Entity, TestAppContext};
use host_client::{ConnectionEvent, HostEvent};
use serde_json::{Value, json};
use shared::copy::Locale;
use shared::copy::system as copy;
use shared::domain_element_id;
use workspace::{HostRequestError, HostRequester, HostTransport};

use crate::config_transfer::{
    self, ConfigBundle, ConfigCategory, ConflictStrategy, ImportSummary, ParseFailure,
    TransferError,
};
use crate::tests::{Harness, ScriptedHost, catalog_page, policy};
use crate::{DataNotice, DataPage, SettingsSection};

const EXPORTED_AT: &str = "2026-09-29T00:00:00.000Z";
const APP_VERSION: &str = "0.1.0";

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/config_transfer").join(name)
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(fixture_path(name)).unwrap_or_else(|error| {
        panic!(
            "{name}: {error}. Record it with MAKA_WRITE_CONFIG_FIXTURES=1 cargo test -p settings \
             data_tests, then scripts/config-transfer-fixtures.sh"
        )
    })
}

fn fixture_json(name: &str) -> Value {
    serde_json::from_str(&fixture(name)).expect(name)
}

fn bundle(name: &str) -> ConfigBundle {
    ConfigBundle::parse(&fixture(name)).expect(name)
}

/// A request that changes the Host's state; everything else reads it.
fn is_write(operation: &str) -> bool {
    !(operation.ends_with(".query") || operation == "configuration.credentials.export")
}

/// Answers from a recorded transcript. A write must be the transcript's
/// next write, with the same input; a read is answered by a recorded read
/// with the same input since the last write and before the next, so a read
/// Desktop makes only to return what it wrote may be left out, and one
/// made twice between two writes answers the same.
struct Replay {
    exchanges: Vec<(String, Value, Value)>,
    state: Mutex<ReplayState>,
}

#[derive(Default)]
struct ReplayState {
    position: usize,
    consumed: Vec<bool>,
    unmatched: Vec<String>,
    requests: Vec<(String, Value)>,
}

impl Replay {
    fn new(transcript: &Value) -> Arc<Self> {
        let exchanges: Vec<(String, Value, Value)> = transcript
            .as_array()
            .expect("a transcript")
            .iter()
            .map(|exchange| {
                (
                    exchange["operation"].as_str().expect("operation").to_owned(),
                    exchange["input"].clone(),
                    exchange["output"].clone(),
                )
            })
            .collect();
        let consumed = vec![false; exchanges.len()];
        Arc::new(Self {
            exchanges,
            state: Mutex::new(ReplayState { consumed, ..ReplayState::default() }),
        })
    }

    fn of(name: &str) -> Arc<Self> {
        Self::new(&fixture_json(name))
    }

    fn requester(self: &Arc<Self>) -> HostRequester {
        HostRequester::new(self.clone())
    }

    fn unmatched(&self) -> Vec<String> {
        self.state.lock().expect("state").unmatched.clone()
    }

    fn requests(&self) -> usize {
        self.state.lock().expect("state").requests.len()
    }

    /// The recorded writes nothing sent.
    fn unsent_writes(&self) -> Vec<String> {
        let state = self.state.lock().expect("state");
        self.exchanges
            .iter()
            .zip(&state.consumed)
            .filter(|((operation, ..), consumed)| is_write(operation) && !**consumed)
            .map(|((operation, input, _), _)| format!("{operation} {input}"))
            .collect()
    }

    fn answer(&self, operation: &str, input: &Value) -> Result<Value, HostRequestError> {
        let mut state = self.state.lock().expect("state");
        state.requests.push((operation.to_owned(), input.clone()));
        let count = self.exchanges.len();
        let next_write = (state.position..count)
            .find(|&at| is_write(&self.exchanges[at].0) && !state.consumed[at])
            .unwrap_or(count);
        let matches =
            |at: usize| self.exchanges[at].0 == operation && self.exchanges[at].1 == *input;
        let found = if is_write(operation) {
            (next_write < count && matches(next_write)).then_some(next_write)
        } else {
            let window = state.position..next_write;
            window
                .clone()
                .find(|&at| !state.consumed[at] && matches(at))
                .or_else(|| window.rev().find(|&at| matches(at)))
        };
        match found {
            Some(at) => {
                state.consumed[at] = true;
                if is_write(operation) {
                    state.position = at + 1;
                }
                Ok(self.exchanges[at].2.clone())
            }
            None => {
                state.unmatched.push(format!("{operation} {input}"));
                Err(HostRequestError::Transport(format!("unrecorded {operation} {input}").into()))
            }
        }
    }
}

impl HostTransport for Replay {
    fn request(
        &self,
        operation: &'static str,
        input: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        let answer = self.answer(operation, &input);
        Box::pin(async move { answer })
    }
}

/// `ConfigImportResult` as Desktop's handler returns it.
fn summary_json(summary: &ImportSummary) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(counts) = summary.connections {
        out.insert(
            "connections".into(),
            json!({"created": counts.created, "overwritten": counts.overwritten,
                   "skipped": counts.skipped}),
        );
    }
    if summary.settings {
        out.insert("settings".into(), json!({"applied": true}));
    }
    if let Some(counts) = summary.credentials {
        out.insert(
            "credentials".into(),
            json!({"applied": counts.applied, "skipped": counts.skipped}),
        );
    }
    if summary.memory {
        out.insert("memory".into(), json!({"applied": true}));
    }
    Value::Object(out)
}

/// Desktop's settings payload without its own windows' preferences, which
/// this client neither writes nor reads.
fn host_settings(settings: &Value) -> Value {
    let mut out = settings.clone();
    let map = out.as_object_mut().expect("settings");
    for key in [
        "schemaVersion",
        "botChat",
        "usage",
        "appearance",
        "onboarding",
        "projects",
        "notifications",
        "workHub",
        "system",
    ] {
        map.remove(key);
    }
    if let Some(personalization) = map.get_mut("personalization").and_then(Value::as_object_mut) {
        personalization.remove("uiLocale");
        personalization.remove("selectedPetId");
    }
    out
}

/// This client's file for a scenario, as recorded for Desktop to import.
fn golden(name: &str, text: &str) {
    if std::env::var_os("MAKA_WRITE_CONFIG_FIXTURES").is_some() {
        std::fs::write(fixture_path(name), text).expect(name);
        return;
    }
    assert_eq!(
        fixture(name),
        text,
        "{name} is not what this client writes: record it again with \
         MAKA_WRITE_CONFIG_FIXTURES=1, then run scripts/config-transfer-fixtures.sh"
    );
}

use ConfigCategory::{Connections, Credentials, Memory, Settings};

#[test]
fn an_export_writes_the_file_desktop_writes() {
    let proxy_target = json!({"protocol": "http", "host": "proxy.example", "port": 8080,
                              "username": "ada"});
    for (name, categories) in [
        ("full", &[Connections, Settings, Memory, Credentials][..]),
        ("basic", &[Connections, Settings][..]),
        ("credentials", &[Credentials][..]),
        ("proxy", &[Connections, Settings, Memory, Credentials][..]),
    ] {
        let desktop = bundle(&format!("desktop_export_{name}.json"));
        let replay = Replay::of(&format!("desktop_export_{name}.transcript.json"));
        let ours = block_on(config_transfer::export(
            &replay.requester(),
            categories,
            APP_VERSION,
            EXPORTED_AT.into(),
        ))
        .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(replay.unmatched(), Vec::<String>::new(), "{name}: only Desktop's reads");
        assert_eq!(ours.included(), desktop.included(), "{name}");
        for category in [Connections, Credentials, Memory] {
            assert_eq!(ours.get(category), desktop.get(category), "{name}: {category:?}");
        }
        if let Some(settings) = desktop.get(Settings) {
            let mut expected =
                if name == "credentials" { settings.clone() } else { host_settings(settings) };
            if name == "proxy" {
                // Where Desktop's own import needs it (see config_transfer).
                expected["network"]["proxy"]["credentialTarget"] = proxy_target.clone();
            }
            assert_eq!(ours.get(Settings), Some(&expected), "{name}: settings");
        }
        if matches!(name, "full" | "proxy") {
            golden(&format!("gpui_export_{name}.json"), &ours.to_file());
        }
    }
}

#[test]
fn desktops_file_imports_as_desktop_imports_it() {
    for (file, run, strategy) in [
        ("full", "full", ConflictStrategy::Skip),
        ("credentials", "credentials", ConflictStrategy::Skip),
        ("full", "overwrite", ConflictStrategy::Overwrite),
    ] {
        let replay = Replay::of(&format!("desktop_import_{run}.transcript.json"));
        let summary = block_on(config_transfer::import(
            &replay.requester(),
            &bundle(&format!("desktop_export_{file}.json")),
            strategy,
            Locale::English,
        ))
        .unwrap_or_else(|error| panic!("{run}: {error:?}"));
        assert_eq!(replay.unmatched(), Vec::<String>::new(), "{run}");
        assert_eq!(replay.unsent_writes(), Vec::<String>::new(), "{run}: every write Desktop sent");
        assert_eq!(
            summary_json(&summary),
            fixture_json(&format!("desktop_import_{run}.result.json")),
            "{run}"
        );
    }
}

#[test]
fn desktops_file_with_the_proxy_password_is_refused_as_desktop_refuses_it() {
    let desktop = fixture_json("desktop_import_proxy.result.json");
    assert_eq!(desktop["reason"], "malformed");
    let replay = Replay::new(&json!([]));
    let result = block_on(config_transfer::import(
        &replay.requester(),
        &bundle("desktop_export_proxy.json"),
        ConflictStrategy::Skip,
        Locale::English,
    ));
    assert_eq!(result, Err(TransferError::File(ParseFailure::Malformed)));
    assert_eq!(replay.requests(), 0, "nothing is written before the refusal");
}

#[test]
fn desktop_imports_the_files_this_client_writes() {
    // Without Desktop's own preferences in it, the file makes Desktop send
    // the Host what its own file makes it send.
    assert_eq!(
        fixture_json("desktop_import_gpui_full.transcript.json"),
        fixture_json("desktop_import_full.transcript.json")
    );
    assert_eq!(
        fixture_json("desktop_import_gpui_full.result.json"),
        fixture_json("desktop_import_full.result.json")
    );
    // With the proxy's password and the proxy it belongs to, Desktop takes
    // the file it refuses in its own shape.
    let result = fixture_json("desktop_import_gpui_proxy.result.json");
    assert_eq!(
        result,
        json!({"connections": {"created": 2, "overwritten": 0, "skipped": 0},
               "settings": {"applied": true}, "credentials": {"applied": 3, "skipped": 0},
               "memory": {"applied": true}})
    );
    let transcript = fixture_json("desktop_import_gpui_proxy.transcript.json");
    let update = transcript
        .as_array()
        .expect("transcript")
        .iter()
        .find(|exchange| exchange["operation"] == "runtime.policy.network-proxy.update")
        .expect("the proxy");
    assert_eq!(
        update["input"]["credential"],
        json!({"kind": "replace", "secret": "proxy-pw",
               "expectedTarget": {"protocol": "http", "host": "proxy.example", "port": 8080,
                                  "username": "ada"}})
    );
    // And this client imports its own file as Desktop does.
    let replay = Replay::new(&transcript);
    let summary = block_on(config_transfer::import(
        &replay.requester(),
        &bundle("gpui_export_proxy.json"),
        ConflictStrategy::Skip,
        Locale::English,
    ))
    .expect("imported");
    assert_eq!(replay.unmatched(), Vec::<String>::new());
    assert_eq!(replay.unsent_writes(), Vec::<String>::new());
    assert_eq!(summary_json(&summary), result);
}

#[test]
fn a_secret_whose_connection_moved_is_skipped() {
    let mut file = fixture_json("desktop_export_full.json");
    file["data"]["credentials"][0]["connection"]["effectiveBaseUrl"] =
        json!("https://elsewhere.example/v1");
    let mut transcript = fixture_json("desktop_import_full.transcript.json");
    // The relay's key is the write that must not happen.
    transcript.as_array_mut().expect("transcript").retain(|exchange| {
        !(exchange["operation"] == "credential.vault.set"
            && exchange["input"]["locator"]["kind"] == "api_key"
            && exchange["input"]["expectedConnection"]["slug"] == "relay")
    });
    let replay = Replay::new(&transcript);
    let bundle = ConfigBundle::parse(&file.to_string()).expect("bundle");
    let summary = block_on(config_transfer::import(
        &replay.requester(),
        &bundle,
        ConflictStrategy::Skip,
        Locale::English,
    ))
    .expect("imported");
    assert_eq!(replay.unmatched(), Vec::<String>::new());
    assert_eq!(replay.unsent_writes(), Vec::<String>::new());
    assert_eq!(summary.credentials.map(|c| (c.applied, c.skipped)), Some((2, 1)));
}

/// A Host that answers `operation` with `reply` every time.
fn scripted(replies: &[(&str, Value)]) -> Arc<ScriptedHost> {
    let transport = Arc::new(ScriptedHost::default());
    for (operation, reply) in replies {
        transport.always(operation, Ok(reply.clone()));
    }
    transport
}

fn not_configured(locator: Value) -> Value {
    json!({"kind": "status", "status": {"locator": locator, "configured": false,
           "credentialId": null, "revision": null, "updatedAt": null}})
}

/// The furnished Host's first catalog page (relay and deepseek).
fn furnished_catalog() -> Value {
    fixture_json("desktop_export_full.transcript.json")[0]["output"].clone()
}

#[test]
fn an_export_stops_when_the_connections_keep_changing() {
    let transport = scripted(&[
        ("connection.catalog.query", furnished_catalog()),
        (
            "configuration.credentials.export",
            json!({"credential": null,
                   "connectionStale": {"expected": {"connectionId": "c", "revision": 3},
                                       "actual": {"connectionId": "c", "revision": 4}}}),
        ),
    ]);
    let result = block_on(config_transfer::export(
        &HostRequester::new(transport.clone()),
        &[Credentials],
        APP_VERSION,
        EXPORTED_AT.into(),
    ));
    assert!(matches!(result, Err(TransferError::Failed(_))), "{result:?}");
    assert_eq!(transport.requests("connection.catalog.query").len(), 3, "three tries");
    assert_eq!(
        transport.requests("configuration.credentials.export").len(),
        3,
        "each stops at the connection that moved"
    );
}

#[test]
fn an_export_stops_when_the_proxy_keeps_changing() {
    let proxy = json!({"scope": "network_proxy", "kind": "password"});
    let desktop = fixture_json("desktop_export_full.transcript.json");
    let furnished_policy = desktop
        .as_array()
        .expect("transcript")
        .iter()
        .find(|exchange| exchange["operation"] == "runtime.policy.query")
        .expect("policy")["output"]
        .clone();
    let transport = scripted(&[
        ("connection.catalog.query", catalog_page(1)),
        (
            "configuration.credentials.export",
            json!({"credential": {"locator": proxy, "secretBase64": "cHc=",
                   "proxyTarget": {"protocol": "http", "host": "other.example", "port": 8080,
                                   "username": "ada"}}}),
        ),
        ("runtime.policy.query", furnished_policy),
        ("credential.vault.query", not_configured(proxy.clone())),
    ]);
    let result = block_on(config_transfer::export(
        &HostRequester::new(transport.clone()),
        &[Settings, Credentials],
        APP_VERSION,
        EXPORTED_AT.into(),
    ));
    assert!(matches!(result, Err(TransferError::Failed(_))), "{result:?}");
    assert_eq!(transport.requests("runtime.policy.query").len(), 3);
}

#[test]
fn an_import_stops_where_the_host_refuses() {
    let file = fixture_json("desktop_export_full.json");
    let text = json!({"schemaVersion": 1, "includedData": ["connections", "memory"],
                      "data": {"connections": file["data"]["connections"], "memory": "# M\n"}});
    let transport = scripted(&[
        ("connection.catalog.query", catalog_page(1)),
        ("connection.catalog.create", json!({"kind": "connection_exists", "slug": "relay"})),
    ]);
    let result = block_on(config_transfer::import(
        &HostRequester::new(transport.clone()),
        &ConfigBundle::parse(&text.to_string()).expect("bundle"),
        ConflictStrategy::Skip,
        Locale::English,
    ));
    assert!(matches!(result, Err(TransferError::Failed(_))), "{result:?}");
    assert_eq!(transport.requests("connection.catalog.create").len(), 1, "it stops at the first");
    assert!(transport.requests("memory.query").is_empty(), "nothing after it is written");
}

// --- the page

fn open(cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    Harness::open_with_transport(SettingsSection::Data, transport, cx)
}

fn data_page(harness: &Harness, cx: &mut TestAppContext) -> Entity<DataPage> {
    harness.view.read_with(cx, |view, _| view.data().clone())
}

fn notice(harness: &Harness, cx: &mut TestAppContext) -> Option<DataNotice> {
    let page = data_page(harness, cx);
    page.read_with(cx, |page, _| page.notice().cloned())
}

fn said(ok: bool, title: &str, detail: Option<&str>) -> Option<DataNotice> {
    Some(DataNotice { ok, title: title.to_owned(), detail: detail.map(str::to_owned) })
}

/// A folder of its own under the system's temporary folder.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("maka-data-page-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch");
    dir
}

#[gpui_kit::test]
fn the_workspace_path_shows_copies_and_opens(cx: &mut TestAppContext) {
    let harness = open(cx);
    harness.with_window(cx, |window, _| {
        let value = window.find(domain_element_id("settings-value", "data-workspace"));
        assert_eq!(value.label(), Some("/tmp/.dev-root"));
        assert!(window.find(domain_element_id("settings-row", "data-backup")).visible());
    });
    harness.click("data-copy-path", cx);
    let copied = cx.read_from_clipboard().and_then(|item| item.text());
    assert_eq!(copied.as_deref(), Some("/tmp/.dev-root"));
    assert_eq!(notice(&harness, cx), said(true, copy::DATA_PATH_COPIED.en(), None));

    let dir = scratch("open");
    let opened = Arc::new(Mutex::new(Vec::new()));
    let page = data_page(&harness, cx);
    let record = opened.clone();
    page.update(cx, |page, _| {
        page.set_opener(move |path, _| record.lock().expect("opened").push(path.to_owned()));
        page.set_workspace(dir.join("missing"));
    });
    harness.click("data-open-workspace", cx);
    let failed = |detail| said(false, copy::DATA_OPEN_FAILED.en(), Some(detail));
    assert_eq!(notice(&harness, cx), failed(copy::DATA_FOLDER_MISSING.en()));
    std::fs::write(dir.join("file"), "").expect("file");
    page.update(cx, |page, _| page.set_workspace(dir.join("file")));
    harness.click("data-open-workspace", cx);
    assert_eq!(notice(&harness, cx), failed(copy::DATA_NOT_A_FOLDER.en()));
    page.update(cx, |page, _| page.set_workspace(dir.clone()));
    harness.click("data-open-workspace", cx);
    assert_eq!(*opened.lock().expect("opened"), std::slice::from_ref(&dir));
    std::fs::remove_dir_all(&dir).ok();
}

#[gpui_kit::test]
fn the_export_writes_the_chosen_categories_where_the_person_says(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    let page = data_page(&harness, cx);
    let selected = |cx: &mut TestAppContext| page.read_with(cx, |page, _| page.selected());
    assert_eq!(selected(cx), [Connections, Settings], "Desktop's defaults");
    let warning = domain_element_id("settings-warning", "data-sensitive");
    harness.with_window(cx, |window, _| assert!(window.try_find(warning.clone()).is_none()));
    harness.click(domain_element_id("data-category", "credentials"), cx);
    harness.with_window(cx, |window, _| assert!(window.find(warning.clone()).visible()));
    harness.click(domain_element_id("data-category", "credentials"), cx);
    harness.with_window(cx, |window, _| assert!(window.try_find(warning.clone()).is_none()));

    transport.always("connection.catalog.query", Ok(catalog_page(6)));
    transport.reply("runtime.policy.query", Ok(policy(4, "ask")));
    let jev = json!({"scope": "jev", "kind": "api_key"});
    transport.always("credential.vault.query", Ok(not_configured(jev)));
    harness.click("data-export", cx);
    assert!(cx.did_prompt_for_new_path());
    let dir = scratch("export");
    let file = dir.join("maka-config.json");
    let target = file.clone();
    cx.simulate_new_path_selection(move |_| Some(target));
    cx.run_until_parked();
    let written = ConfigBundle::parse(&std::fs::read_to_string(&file).expect("written"))
        .expect("a configuration file");
    assert_eq!(written.included(), [Connections, Settings]);
    assert_eq!(written.get(Connections), Some(&json!([])));
    let settings = written.get(Settings).expect("settings");
    assert_eq!(settings["chatDefaults"]["permissionMode"], "ask");
    // No key saved: the status Desktop's defaults give it, without the key.
    assert_eq!(
        settings["webSearch"]["providers"]["tavily"],
        json!({"credentialSource": "none", "credentialVersion": 0,
               "credentialStatus": "not_configured"})
    );
    assert_eq!(settings["jev"], json!({"enabled": false}));
    assert_eq!(
        notice(&harness, cx),
        said(true, copy::DATA_EXPORTED.en(), Some("Included: Model connections, App settings"))
    );

    // Cancelled: nothing is read or said.
    let reads = transport.requests("runtime.policy.query").len();
    harness.click("data-export", cx);
    cx.simulate_new_path_selection(|_| None);
    cx.run_until_parked();
    assert_eq!(transport.requests("runtime.policy.query").len(), reads);
    assert!(!page.read_with(cx, |page, _| page.is_busy()));

    // The Host refuses.
    transport.reply(
        "connection.catalog.query",
        Err(HostRequestError::Operation {
            operation: "connection.catalog.query",
            code: host_protocol::HostOperationErrorCode::HostDraining,
            message: "the host is shutting down".into(),
        }),
    );
    harness.click("data-export", cx);
    let target = file.clone();
    cx.simulate_new_path_selection(move |_| Some(target));
    cx.run_until_parked();
    let refused = notice(&harness, cx).expect("said");
    assert!(!refused.ok);
    assert_eq!(refused.title, copy::DATA_EXPORT_FAILED.en());

    // Nothing chosen: nothing to write.
    harness.click(domain_element_id("data-category", "connections"), cx);
    harness.click(domain_element_id("data-category", "settings"), cx);
    harness.click("data-export", cx);
    assert!(!cx.did_prompt_for_new_path());
    assert_eq!(notice(&harness, cx), said(false, copy::DATA_SELECT_CATEGORY.en(), None));
    std::fs::remove_dir_all(&dir).ok();
}

#[gpui_kit::test]
fn the_import_reads_the_file_and_says_what_it_wrote(cx: &mut TestAppContext) {
    let harness = open(cx);
    let transport = harness.transport.clone();
    let page = data_page(&harness, cx);
    harness.choose("data-conflict", &["down"], cx);
    assert_eq!(page.read_with(cx, |page, _| page.strategy()), ConflictStrategy::Overwrite);

    // Desktop's answers to the MEMORY.md upload.
    let desktop = fixture_json("desktop_import_full.transcript.json");
    for exchange in desktop.as_array().expect("transcript") {
        if let Some(operation @ ("memory.query" | "memory.mutate")) = exchange["operation"].as_str()
        {
            transport.reply(operation, Ok(exchange["output"].clone()));
        }
    }
    let dir = scratch("import");
    let import = |name: &str, text: &str, cx: &mut TestAppContext| {
        let file = dir.join(name);
        std::fs::write(&file, text).expect("file");
        harness.click("data-import", cx);
        assert!(cx.did_prompt_for_paths());
        cx.simulate_path_prompt_response(move |_| Some(vec![file]));
        cx.run_until_parked();
    };
    let memory = json!({"schemaVersion": 1, "includedData": ["memory"],
                        "data": {"memory": "# Memory\n\n- Prefers tea.\n"}});
    import("memory.json", &memory.to_string(), cx);
    assert_eq!(
        notice(&harness, cx),
        said(true, copy::DATA_IMPORTED.en(), Some(copy::DATA_SUMMARY_MEMORY.en()))
    );
    let kinds: Vec<Value> =
        transport.requests("memory.mutate").iter().map(|input| input["kind"].clone()).collect();
    assert_eq!(kinds, ["replace_begin", "replace_chunk", "replace_commit"]);

    let failed = |detail: &str| said(false, copy::DATA_IMPORT_FAILED.en(), Some(detail));
    import("broken.json", "{not json", cx);
    assert_eq!(notice(&harness, cx), failed(copy::DATA_NOT_JSON.en()));
    import("future.json", r#"{"schemaVersion": 2, "includedData": []}"#, cx);
    assert_eq!(notice(&harness, cx), failed(copy::DATA_UNSUPPORTED_VERSION.en()));
    import("odd.json", r#"{"schemaVersion": 1, "includedData": ["themes"]}"#, cx);
    assert_eq!(notice(&harness, cx), failed(copy::DATA_MALFORMED.en()));
    import("empty.json", r#"{"schemaVersion": 1, "includedData": []}"#, cx);
    assert_eq!(
        notice(&harness, cx),
        said(true, copy::DATA_IMPORTED.en(), Some(copy::DATA_SUMMARY_EMPTY.en()))
    );

    // The Host refuses the file's MEMORY.md.
    transport.reply(
        "memory.query",
        Err(HostRequestError::Operation {
            operation: "memory.query",
            code: host_protocol::HostOperationErrorCode::HostDraining,
            message: "the host is shutting down".into(),
        }),
    );
    import("memory.json", &memory.to_string(), cx);
    let refused = notice(&harness, cx).expect("said");
    assert_eq!((refused.ok, refused.title.as_str()), (false, copy::DATA_IMPORT_FAILED.en()));

    // Cancelled: nothing happens.
    harness.click("data-import", cx);
    cx.simulate_path_prompt_response(|_| None);
    cx.run_until_parked();
    assert!(!page.read_with(cx, |page, _| page.is_busy()));
    std::fs::remove_dir_all(&dir).ok();
}

#[gpui_kit::test]
fn offline_the_configuration_waits_for_the_host(cx: &mut TestAppContext) {
    let harness = open(cx);
    harness.host.update(cx, |host, cx| {
        host.handle_host_event(
            HostEvent::Connection(ConnectionEvent::Disconnected { reason: "gone".into() }),
            cx,
        )
    });
    cx.run_until_parked();
    harness.with_window(cx, |window, _| {
        let offline = window.find(domain_element_id("settings-status", "data-offline"));
        assert_eq!(offline.label(), Some(copy::DATA_OFFLINE.en()));
    });
    harness.click("data-export", cx);
    harness.click("data-import", cx);
    assert!(!cx.did_prompt_for_new_path() && !cx.did_prompt_for_paths());
    // The workspace is this machine's and stays at hand.
    harness.click("data-copy-path", cx);
    assert_eq!(notice(&harness, cx), said(true, copy::DATA_PATH_COPIED.en(), None));
}
