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

//! UI integration tests of the Models page and General's Full access
//! question: the provider catalog, the setup form (the verified route and
//! Desktop's create path), a connection's detail and its every action, and
//! a model's parameters, driven through their buttons, fields, and dialogs
//! against the scripted Host of [`crate::tests`], whose answers follow the
//! TS decoders (`packages/runtime-host/src/protocol/connection-effects.ts`,
//! `runtime-policy.ts`).

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{Entity, TestAppContext};
use serde_json::{Value, json};
use shared::copy::models as copy;
use shared::copy::settings as settings_copy;
use shared::domain_element_id;

use crate::connection_ops::{self, ModelsFetchFailure};
use crate::tests::{Harness, header, policy, row, three_connections};
use crate::{AddConnectionForm, AddConnectionPhase, ConnectionDetail, FormFields, SettingsSection};

impl Harness {
    /// Opens Models on `catalog`, which every later read of the catalog
    /// finds too, until a test changes it.
    fn models(catalog: Value, cx: &mut TestAppContext) -> Self {
        let harness = Self::open_on(SettingsSection::Models, catalog.clone(), cx);
        harness.transport.always("connection.catalog.query", Ok(catalog));
        harness
    }

    /// The setup form of `provider`, as picking it in the catalog opens it.
    fn pick(&self, provider: &'static str, cx: &mut TestAppContext) -> Entity<AddConnectionForm> {
        self.click("settings-add-connection", cx);
        let providers =
            self.view.read_with(cx, |view, cx| view.connections().read(cx).providers().clone());
        providers.update(cx, |providers, cx| providers.pick(provider, cx));
        cx.run_until_parked();
        self.view
            .read_with(cx, |view, cx| view.connections().read(cx).form().cloned())
            .expect("the form shows")
    }

    fn fill(
        &self,
        form: &Entity<AddConnectionForm>,
        fields: FormFields<'_>,
        cx: &mut TestAppContext,
    ) {
        self.with_window(cx, |window, cx| {
            form.update(cx, |form, cx| form.fill(fields, window, cx));
        });
    }

    fn detail(&self, cx: &mut TestAppContext) -> Option<Entity<ConnectionDetail>> {
        self.view.read_with(cx, |view, cx| view.connections().read(cx).detail().cloned())
    }

    /// Opens the detail of `id`, its key set and its headers `headers`.
    fn open_detail(
        &self,
        id: &str,
        headers: &[&str],
        cx: &mut TestAppContext,
    ) -> Entity<ConnectionDetail> {
        self.transport.reply("credential.vault.query", Ok(key_status(id, true)));
        self.transport.reply(
            "connection.request-headers.query",
            Ok(json!({"kind": "found", "names": headers})),
        );
        self.click(row(id), cx);
        self.detail(cx).expect("the detail shows")
    }

    fn label(&self, id: impl Into<gpui_kit::ElementId>, cx: &mut TestAppContext) -> Option<String> {
        let id = id.into();
        self.with_window(cx, |window, _| {
            window.try_find(id).and_then(|e| e.label().map(str::to_owned))
        })
    }

    fn shows(&self, id: impl Into<gpui_kit::ElementId>, cx: &mut TestAppContext) -> bool {
        let id = id.into();
        self.with_window(cx, |window, _| window.try_find(id).is_some())
    }

    /// Replaces the text of the focused field with `text`.
    fn type_over(&self, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| {
            window.press("cmd-a", cx);
            window.press("backspace", cx);
            window.input(text, cx);
        });
    }
}

/// `credential.vault.query`'s answer for the key of the connection `id`.
fn key_status(id: &str, configured: bool) -> Value {
    let locator = json!({"scope": "connection", "connectionId": id, "kind": "api_key"});
    let status = if configured {
        json!({"locator": locator, "configured": true,
               "credentialId": "00000000-0000-4000-8000-000000000009", "revision": 3,
               "updatedAt": 1})
    } else {
        json!({"locator": locator, "configured": false, "credentialId": null, "revision": null,
               "updatedAt": null})
    };
    json!({"kind": "status", "status": status})
}

/// A `catalog_entry` item: a model as the Host resolved it.
fn entry(index: u64, item: u64, id: &str, name: Option<&str>) -> Value {
    let mut entry = json!({"id": id, "canUseAsChatDefault": true, "isDefault": item == 0,
                           "supportsVision": false, "thinkingLevels": []});
    if let Some(name) = name {
        entry["displayName"] = json!(name);
    }
    json!({"kind": "catalog_entry", "connectionIndex": index, "itemIndex": item, "entry": entry})
}

/// One custom relay, `c-relay`, at `revision`: models `m1` (enabled) and
/// `m2`, last tested healthy. `edit` changes its items.
fn relay(revision: u64, edit: impl FnOnce(&mut Vec<Value>)) -> Value {
    let mut relay = header(0, "c-relay", "my-relay", "My relay", "custom:openai-chat", true);
    relay["baseUrl"] = json!("https://relay.example/v1");
    relay["modelSource"] = json!("fetched");
    relay["lastTest"] = json!({"status": "verified", "checkedAt": "2026-09-28T10:00:00.000Z"});
    let mut items = vec![
        relay,
        json!({"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 0, "modelId": "m1"}),
        json!({"kind": "model", "connectionIndex": 0, "itemIndex": 0, "model": {"id": "m1"}}),
        json!({"kind": "model", "connectionIndex": 0, "itemIndex": 1, "model": {"id": "m2"}}),
        entry(0, 0, "m1", Some("Model One")),
        entry(0, 1, "m2", None),
    ];
    edit(&mut items);
    json!({"kind": "page", "revision": revision, "defaultTarget": null, "connectionCount": 1,
           "items": items, "nextCursor": null})
}

/// [`three_connections`] with `connection` added as its fourth.
fn with_new(catalog: Value, id: &str, slug: &str, provider: &str) -> Value {
    let mut catalog = catalog;
    let items = catalog["items"].as_array_mut().expect("items");
    items.push(header(3, id, slug, "New", provider, true));
    catalog
}

fn committed(id: &str, revision: u64) -> Value {
    json!({"kind": "committed", "catalogRevision": 20,
           "connection": {"connectionId": id, "revision": revision}})
}

fn field_error(key: &str) -> gpui_kit::ElementId {
    domain_element_id("connection-field-error", key)
}

fn status(key: &str) -> gpui_kit::ElementId {
    domain_element_id("settings-status", key)
}

#[gpui_kit::test]
fn add_connection_opens_desktops_catalog_with_its_groups_and_search(cx: &mut TestAppContext) {
    let harness = Harness::models(three_connections(8), cx);
    harness.click("settings-add-connection", cx);
    let pane = harness.view.read_with(cx, |view, _| view.connections().clone());
    assert!(pane.read_with(cx, |pane, _| pane.catalog_open()));
    for group in ["recommended", "plans", "api", "aggregators", "local"] {
        assert!(harness.shows(domain_element_id("provider-group", group), cx), "{group}");
    }
    // The account sign-ins are listed after the providers that work and
    // say they need Maka Desktop; they are not buttons.
    let last_provider = harness.with_window(cx, |window, _| {
        window
            .within(domain_element_id("provider-group", "recommended"))
            .find(domain_element_id("provider-row", "opencode-go"))
            .bounds()
    });
    for account in ["openai-codex", "github-copilot", "xai-oauth"] {
        assert_eq!(
            harness.label(domain_element_id("account-note", account), cx).as_deref(),
            Some(copy::ACCOUNT_NEEDS_DESKTOP.en())
        );
        assert!(!harness.shows(domain_element_id("provider-row", account), cx));
        let row = harness.with_window(cx, |window, _| {
            window.find(domain_element_id("account-row", account)).bounds()
        });
        assert!(row.top() >= last_provider.bottom(), "{account} comes last");
    }
    assert!(
        harness.shows(domain_element_id("provider-row", "custom"), cx),
        "custom is listed once"
    );
    assert!(harness.shows(domain_element_id("provider-row", "ollama"), cx));
    // The custom provider's form is titled for what it does.
    harness.click(domain_element_id("provider-row", "custom"), cx);
    assert_eq!(
        harness.label("settings-group-title:setup", cx).as_deref(),
        Some(copy::ADD_CUSTOM_TITLE.en())
    );
    harness.click("connections-back", cx);

    // Typing collapses the groups into one list.
    harness.with_window(cx, |window, cx| {
        window.click("provider-search", cx);
        window.input("deep", cx);
    });
    assert!(!harness.shows(domain_element_id("provider-group", "plans"), cx));
    assert!(harness.shows(domain_element_id("provider-row", "deepseek"), cx));
    assert!(harness.shows(domain_element_id("provider-row", "deepinfra"), cx));
    assert!(!harness.shows(domain_element_id("provider-row", "openai"), cx));
    // The search survives a trip to a provider's form and back.
    harness.click(domain_element_id("provider-row", "deepseek"), cx);
    assert!(pane.read_with(cx, |pane, _| pane.form().is_some()));
    assert_eq!(
        harness.label("settings-group-title:setup", cx).as_deref(),
        Some("Connect DeepSeek")
    );
    harness.click("connections-back", cx);
    assert!(pane.read_with(cx, |pane, _| pane.catalog_open()), "back to the catalog");
    let typed = harness
        .with_window(cx, |window, _| window.find("provider-search").value().map(str::to_owned));
    assert_eq!(typed.as_deref(), Some("deep"));
    harness.with_window(cx, |window, cx| window.input("zzz", cx));
    assert!(harness.shows("provider-no-match", cx));
    harness.click("provider-clear-search", cx);
    assert!(harness.shows(domain_element_id("provider-group", "recommended"), cx));
    harness.click("connections-back", cx);
    assert!(harness.shows("connections-list", cx));
}

#[gpui_kit::test]
fn the_quick_form_verifies_the_key_then_saves_the_models_chosen(cx: &mut TestAppContext) {
    let harness = Harness::models(three_connections(8), cx);
    let form = harness.pick("deepseek", cx);
    // A key, and nothing else, is asked for.
    assert!(harness.shows("connection-api-key", cx));
    assert!(!harness.shows("connection-slug", cx));
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.label(field_error("api-key"), cx).as_deref(),
        Some("Enter the DeepSeek API key.")
    );
    assert!(harness.transport.requests("connection.onboarding.verify").is_empty());

    harness.fill(&form, FormFields { api_key: Some("sk-secret"), ..FormFields::default() }, cx);
    let answer = harness.transport.hold("connection.onboarding.verify");
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.transport.requests("connection.onboarding.verify"),
        [json!({"target": {"kind": "create", "providerType": "deepseek"},
                "apiKey": "sk-secret", "baseUrl": null})]
    );
    assert_eq!(form.read_with(cx, |form, _| form.phase()), AddConnectionPhase::Verifying);
    harness.click("submit-connection", cx);
    assert_eq!(harness.transport.requests("connection.onboarding.verify").len(), 1);
    answer
        .try_send(Ok(json!({"kind": "verified", "models": [
            {"id": "deepseek-reasoner"},
            {"id": "deepseek-flash", "displayName": "DeepSeek Flash"},
            {"id": "deepseek-chat"}
        ]})))
        .expect("answer");
    cx.run_until_parked();
    assert_eq!(form.read_with(cx, |form, _| form.phase()), AddConnectionPhase::Models);
    // By name; the registry's recommended model starts selected, alone.
    assert_eq!(
        form.read_with(cx, |form, _| form.models()),
        [
            ("deepseek-flash".into(), true),
            ("deepseek-chat".into(), false),
            ("deepseek-reasoner".into(), false)
        ]
    );
    assert_eq!(harness.label("connection-models-count", cx).as_deref(), Some("1 of 3 selected"));
    harness.click(domain_element_id("model", "deepseek-reasoner"), cx);
    harness.click("connection-models-all", cx);
    assert_eq!(harness.label("connection-models-count", cx).as_deref(), Some("3 of 3 selected"));
    // Unticking the default hands the role to the first model still ticked.
    harness.click(domain_element_id("model", "deepseek-flash"), cx);
    assert_eq!(
        form.read_with(cx, |form, _| form.default_model().cloned()),
        Some("deepseek-chat".into())
    );
    harness.click(domain_element_id("model", "deepseek-flash"), cx);
    form.update(cx, |form, cx| form.set_default_model(&"deepseek-reasoner".into(), cx));

    harness.transport.always(
        "connection.catalog.query",
        Ok(with_new(three_connections(9), "c-new", "deepseek", "deepseek")),
    );
    harness.transport.reply(
        "connection.onboarding.save",
        Ok(json!({"kind": "saved", "connection": {"connectionId": "c-new", "revision": 1,
                  "slug": "deepseek", "providerType": "deepseek"}})),
    );
    harness.transport.reply("credential.vault.query", Ok(key_status("c-new", true)));
    harness
        .transport
        .reply("connection.request-headers.query", Ok(json!({"kind": "found", "names": []})));
    harness.click("save-connection", cx);
    // The default first, then the rest in the list's order.
    assert_eq!(
        harness.transport.requests("connection.onboarding.save"),
        [json!({"target": {"kind": "create", "providerType": "deepseek"},
                "apiKey": "sk-secret", "baseUrl": null,
                "enabledModelIds": ["deepseek-reasoner", "deepseek-flash", "deepseek-chat"]})]
    );
    // The new connection's detail, not the list.
    let detail = harness.detail(cx).expect("the detail of the new connection");
    assert_eq!(detail.read_with(cx, |detail, _| detail.connection_id().clone()), "c-new");
    // The key is nowhere in the page.
    let debug = harness.view.read_with(cx, |view, cx| {
        format!("{:?} {:?}", view.connections().read(cx), detail.read(cx))
    });
    assert!(!debug.contains("sk-secret"), "{debug}");
    assert!(!harness.shows("connection-api-key", cx));
}

#[gpui_kit::test]
fn a_custom_connection_takes_its_identity_protocol_and_endpoint(cx: &mut TestAppContext) {
    let harness = Harness::models(three_connections(8), cx);
    let form = harness.pick("custom", cx);
    let value = |id: &'static str, harness: &Harness, cx: &mut TestAppContext| {
        harness.with_window(cx, |window, _| window.find(id).value().map(str::to_owned))
    };
    assert_eq!(value("connection-slug", &harness, cx).as_deref(), Some("custom"));
    assert_eq!(value("connection-name", &harness, cx).as_deref(), Some("Custom connection"));
    // Desktop's order: the identifier, the key, then the endpoint.
    harness.fill(&form, FormFields { slug: Some("Bad_Id"), ..FormFields::default() }, cx);
    harness.click("submit-connection", cx);
    assert_eq!(harness.label(field_error("slug"), cx).as_deref(), Some(copy::SLUG_FORMAT.en()));
    harness.fill(&form, FormFields { slug: Some("ollama-local"), ..FormFields::default() }, cx);
    harness.click("submit-connection", cx);
    assert_eq!(harness.label(field_error("slug"), cx).as_deref(), Some(copy::SLUG_DUPLICATE.en()));
    harness.fill(&form, FormFields { slug: Some("relay"), ..FormFields::default() }, cx);
    harness.click("submit-connection", cx);
    assert!(harness.label(field_error("api-key"), cx).is_some());
    harness.fill(&form, FormFields { api_key: Some("sk-relay"), ..FormFields::default() }, cx);
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.label(field_error("base-url"), cx).as_deref(),
        Some(settings_copy::SERVICE_URL_MISSING.en())
    );
    harness.fill(
        &form,
        FormFields { base_url: Some("https://relay.example/v1"), ..FormFields::default() },
        cx,
    );
    assert_eq!(
        harness.label("connection-request-url", cx).as_deref(),
        Some("Request URL: https://relay.example/v1/chat/completions")
    );
    harness.with_window(cx, |window, cx| {
        form.update(cx, |form, cx| {
            form.set_protocol(host_protocol::ModelApiProtocol::AnthropicMessages, window, cx)
        });
    });
    assert!(!harness.shows("connection-request-url", cx), "Anthropic Messages has no preview");
    harness.transport.reply(
        "connection.onboarding.verify",
        Ok(json!({"kind": "rejected", "reason": "slug_taken"})),
    );
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.transport.requests("connection.onboarding.verify"),
        [json!({"target": {"kind": "create", "providerType": "custom", "slug": "relay",
                           "name": "Custom connection", "defaultApiProtocol": "anthropic-messages"},
                "apiKey": "sk-relay", "baseUrl": "https://relay.example/v1"})]
    );
    assert_eq!(
        harness.label(field_error("slug"), cx).as_deref(),
        Some(settings_copy::REJECTED_SLUG_TAKEN.en())
    );
    // Escape in a field stays in it; on the section list it leaves.
    harness.with_window(cx, |window, cx| {
        window.click("connection-slug", cx);
        window.press("escape", cx);
    });
    assert!(!harness.went_back());
    harness.with_window(cx, |window, cx| {
        window.click(crate::tests::nav("models"), cx);
        window.press("escape", cx);
    });
    assert!(harness.went_back());
}

#[gpui_kit::test]
fn a_provider_without_a_key_takes_desktops_create_path(cx: &mut TestAppContext) {
    let harness = Harness::models(three_connections(8), cx);
    let _form = harness.pick("ollama", cx);
    assert!(!harness.shows("connection-api-key", cx), "Ollama keeps no key");
    assert!(!harness.shows("connection-default-model", cx), "the registry recommends one");
    assert_eq!(harness.label("submit-connection", cx).as_deref(), Some(copy::SAVE_PROVIDER.en()));
    harness.transport.reply("connection.catalog.create", Ok(committed("c-new", 1)));
    harness.transport.reply(
        "connection.models.fetch",
        Ok(json!({"kind": "committed", "catalogRevision": 21, "connection":
                  {"connectionId": "c-new", "revision": 2}, "modelCount": 4,
                  "source": "fetched", "fetchedAt": 1})),
    );
    harness.transport.always(
        "connection.catalog.query",
        Ok(with_new(three_connections(8), "c-new", "ollama", "ollama")),
    );
    harness
        .transport
        .reply("connection.request-headers.query", Ok(json!({"kind": "found", "names": []})));
    harness.click("submit-connection", cx);
    // The registry's endpoint is not sent back; its recommended model is.
    assert_eq!(
        harness.transport.requests("connection.catalog.create"),
        [json!({"expectedCatalogRevision": 8,
                "connection": {"slug": "ollama", "name": "Ollama", "providerType": "ollama",
                               "enabled": true, "enabledModelIds": ["llama3.2"]}})]
    );
    assert!(harness.transport.requests("credential.vault.set").is_empty());
    assert_eq!(
        harness.transport.requests("connection.models.fetch"),
        [json!({"connectionId": "c-new"})]
    );
    assert!(harness.detail(cx).is_some(), "the new connection's detail");
}

#[gpui_kit::test]
fn advanced_settings_are_checked_and_saved_with_the_new_connection(cx: &mut TestAppContext) {
    let harness = Harness::models(three_connections(8), cx);
    let form = harness.pick("deepseek", cx);
    harness.click("add-connection-advanced", cx);
    harness.fill(&form, FormFields { api_key: Some("sk-secret"), ..FormFields::default() }, cx);
    harness.with_window(cx, |window, cx| {
        form.update(cx, |form, cx| form.fill_body("{\"reasoning\": ", window, cx));
    });
    assert_eq!(harness.label("submit-connection", cx).as_deref(), Some(copy::SAVE_PROVIDER.en()));
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.label(field_error("advanced"), cx).as_deref(),
        Some(copy::REQUEST_CUSTOMIZATION_INVALID.en())
    );
    assert!(harness.transport.requests("connection.catalog.create").is_empty());

    harness.with_window(cx, |window, cx| {
        form.update(cx, |form, cx| {
            form.fill_body(r#"{"reasoning": {"effort": "high"}}"#, window, cx);
            form.fill_header(0, "X-Title", "Maka", window, cx);
        });
    });
    harness.transport.reply("connection.catalog.create", Ok(committed("c-new", 1)));
    harness.transport.reply(
        "credential.vault.set",
        Ok(json!({"kind": "committed", "vaultRevision": 4,
                  "status": key_status("c-new", true)["status"]})),
    );
    harness.transport.reply(
        "connection.request-headers.replace",
        Ok(json!({"kind": "committed", "names": ["X-Title"]})),
    );
    harness
        .transport
        .reply("connection.models.fetch", Ok(json!({"kind": "failed", "errorClass": "network"})));
    harness.transport.always(
        "connection.catalog.query",
        Ok(with_new(three_connections(8), "c-new", "deepseek", "deepseek")),
    );
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.create"),
        [json!({"expectedCatalogRevision": 8,
                "connection": {"slug": "deepseek", "name": "DeepSeek", "providerType": "deepseek",
                               "enabled": true, "enabledModelIds": ["deepseek-flash"],
                               "requestBodyOverlay": {"reasoning": {"effort": "high"}}}})]
    );
    assert_eq!(
        harness.transport.requests("credential.vault.set"),
        [json!({"locator": {"scope": "connection", "connectionId": "c-new", "kind": "api_key"},
                "expected": null, "secret": "sk-secret"})]
    );
    assert_eq!(
        harness.transport.requests("connection.request-headers.replace"),
        [json!({"connectionId": "c-new", "headers": [{"name": "X-Title", "value": "Maka"}]})]
    );
    // The connection exists; its models could not be listed, and the page
    // says so.
    assert!(harness.detail(cx).is_some());
    let notice =
        harness.view.read_with(cx, |view, cx| view.connections().read(cx).notice().cloned());
    assert!(
        notice.as_deref().is_some_and(|notice| notice.starts_with(copy::MODELS_FETCH_FAILED.en())
            && notice.contains(copy::KEY_TROUBLESHOOTING.en())),
        "{notice:?}"
    );
}

#[gpui_kit::test]
fn a_new_connection_whose_key_cannot_be_saved_is_removed_again(cx: &mut TestAppContext) {
    let harness = Harness::models(three_connections(8), cx);
    let form = harness.pick("deepseek", cx);
    harness.fill(&form, FormFields { api_key: Some("sk-secret"), ..FormFields::default() }, cx);
    harness.with_window(cx, |window, cx| {
        form.update(cx, |form, cx| form.fill_header(0, "X-Title", "Maka", window, cx));
    });
    harness.transport.reply("connection.catalog.create", Ok(committed("c-new", 1)));
    harness.transport.reply("credential.vault.set", Ok(json!({"kind": "connection_not_found"})));
    harness.transport.reply(
        "connection.catalog.remove",
        Ok(json!({"kind": "committed", "catalogRevision": 22})),
    );
    harness.click("submit-connection", cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.remove"),
        [json!({"expected": {"connectionId": "c-new", "revision": 1}})]
    );
    assert!(harness.transport.requests("connection.request-headers.replace").is_empty());
    assert_eq!(
        form.read_with(cx, |form, _| form.error().cloned()).as_deref(),
        Some(
            format!("{} {}", settings_copy::SAVE_FAILED.en(), copy::CREATE_ROLLED_BACK.en())
                .as_str()
        )
    );
    // A connection another took has the identifier: said at the field.
    harness.transport.reply(
        "connection.catalog.create",
        Ok(json!({"kind": "connection_exists", "slug": "deepseek"})),
    );
    harness.click("submit-connection", cx);
    assert!(
        harness.shows(field_error("slug"), cx)
            || form.read_with(cx, |form, _| form.error().is_some())
    );
}

#[gpui_kit::test]
fn a_custom_connection_takes_the_generic_mark(cx: &mut TestAppContext) {
    cx.update(|cx| shared::copy::Locale::SimplifiedChinese.apply(cx));
    let harness = Harness::models(relay(8, |_| {}), cx);
    let mark = domain_element_id("connection-mark", "c-relay");
    // Desktop's GenericProviderMark (the Cpu glyph, decoration), not a
    // letter: neither 自 from 自定义连接 nor M from "My relay".
    assert!(harness.shows(mark.clone(), cx));
    assert_eq!(harness.label(mark.clone(), cx), None);
    harness.open_detail("c-relay", &[], cx);
    assert_eq!(harness.label(mark, cx), None, "in the detail too");
}

#[gpui_kit::test]
fn the_detail_renames_replaces_the_key_and_edits_the_endpoint(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    let detail = harness.open_detail("c-relay", &[], cx);
    assert_eq!(harness.label("connection-detail-name", cx).as_deref(), Some("My relay"));
    assert_eq!(
        harness.label(domain_element_id("detail-edit", "model-key"), cx).as_deref(),
        Some("Change: Model key"),
        "a key is set; it is never shown"
    );

    harness.click(domain_element_id("detail-edit", "connection-name"), cx);
    harness.type_over("Renamed", cx);
    harness.transport.reply("connection.catalog.update", Ok(committed("c-relay", 5)));
    harness.click(domain_element_id("detail-save", "connection-name"), cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.update"),
        [json!({"expected": {"connectionId": "c-relay", "revision": 4},
                "changes": {"name": "Renamed", "baseUrl": "https://relay.example/v1",
                            "enabled": true, "enabledModelIds": ["m1"]}})]
    );
    assert_eq!(detail.read_with(cx, |detail, _| detail.editing()), None, "the editor closes");

    // A new key is written over the one there is, then the models are
    // listed again; the field empties.
    harness.click(domain_element_id("detail-edit", "model-key"), cx);
    harness.with_window(cx, |window, cx| window.input("sk-new", cx));
    harness.transport.reply("credential.vault.query", Ok(key_status("c-relay", true)));
    harness.transport.reply(
        "credential.vault.set",
        Ok(json!({"kind": "committed", "vaultRevision": 5,
                  "status": key_status("c-relay", true)["status"]})),
    );
    harness.transport.reply(
        "connection.models.fetch",
        Ok(json!({"kind": "committed", "catalogRevision": 21, "connection":
                  {"connectionId": "c-relay", "revision": 6}, "modelCount": 2,
                  "source": "fetched", "fetchedAt": 1})),
    );
    harness.click(domain_element_id("detail-save", "model-key"), cx);
    assert_eq!(
        harness.transport.requests("credential.vault.set"),
        [json!({"locator": {"scope": "connection", "connectionId": "c-relay", "kind": "api_key"},
                "expected": {"credentialId": "00000000-0000-4000-8000-000000000009", "revision": 3},
                "secret": "sk-new"})]
    );
    assert_eq!(harness.transport.requests("connection.models.fetch").len(), 1);
    let debug = detail.read_with(cx, |detail, _| format!("{detail:?}"));
    assert!(!debug.contains("sk-new"), "{debug}");
    assert_eq!(detail.read_with(cx, |detail, _| detail.editing()), None);

    // The endpoint; an empty one clears it.
    harness.click(domain_element_id("detail-edit", "endpoint"), cx);
    harness.type_over("https://other.example/v1", cx);
    harness.transport.reply("connection.catalog.update", Ok(committed("c-relay", 7)));
    harness
        .transport
        .reply("connection.models.fetch", Ok(json!({"kind": "failed", "errorClass": "auth"})));
    harness.click(domain_element_id("detail-save", "endpoint"), cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.update")[1]["changes"]["baseUrl"],
        json!("https://other.example/v1")
    );
    let note = harness.label(status("endpoint"), cx);
    assert!(
        note.as_deref().is_some_and(|note| note.starts_with(copy::MODELS_FETCH_FAILED.en())),
        "saved, but the refresh after it failed: {note:?}"
    );
}

#[gpui_kit::test]
fn a_test_says_what_it_found(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    harness.open_detail("c-relay", &[], cx);
    let test = |harness: &Harness, answer: Value, cx: &mut TestAppContext| {
        harness.transport.reply("connection.test.run", Ok(answer));
        harness.click("connection-test", cx);
        harness.label(status("status"), cx).unwrap_or_default()
    };
    let run = |test: Value| {
        json!({"kind": "committed", "catalogRevision": 9,
                                  "connection": {"connectionId": "c-relay", "revision": 5},
                                  "test": test})
    };
    let verified = |model: &str| {
        run(json!({"kind": "verified", "checkedAt": "2026-09-28T10:00:00.000Z",
                   "modelId": model, "latencyMs": 812}))
    };
    assert_eq!(test(&harness, verified("m1"), cx), "Connected · m1 · 812 ms");
    assert_eq!(
        harness.transport.requests("connection.test.run")[0],
        json!({"connectionId": "c-relay", "modelId": null})
    );
    let fallback = test(&harness, verified("m2"), cx);
    assert!(fallback.contains("Model One") && fallback.contains("m2"), "{fallback}");
    let failed = run(json!({"kind": "failed", "checkedAt": "2026-09-28T10:00:00.000Z",
                            "modelId": null, "latencyMs": null, "statusCode": 401,
                            "errorClass": "auth"}));
    assert_eq!(
        test(&harness, failed, cx),
        "Connection failed. Authentication failed. Check model key, service URL, and proxy \
         settings and try again."
    );
    let limited = run(json!({"kind": "failed", "checkedAt": "2026-09-28T10:00:00.000Z",
                             "modelId": "m1", "latencyMs": 3, "statusCode": 429,
                             "errorClass": "provider_unavailable"}));
    assert_eq!(
        test(&harness, limited, cx),
        format!("{} {}", copy::CONNECTION_FAILED.en(), copy::RATE_LIMITED.en())
    );
    let refused = test(&harness, json!({"kind": "rejected", "reason": "connection_disabled"}), cx);
    assert_eq!(
        refused,
        format!("{} {}", copy::CONNECTION_TEST_ERROR.en(), copy::EFFECT_CONNECTION_DISABLED.en())
    );
}

#[gpui_kit::test]
fn without_a_key_nothing_is_tested_or_listed(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    harness.transport.reply("credential.vault.query", Ok(key_status("c-relay", false)));
    harness
        .transport
        .reply("connection.request-headers.query", Ok(json!({"kind": "found", "names": []})));
    harness.click(row("c-relay"), cx);
    assert_eq!(
        harness.label(domain_element_id("detail-edit", "model-key"), cx).as_deref(),
        Some("Set: Model key")
    );
    harness.click("connection-test", cx);
    harness.click("connection-refresh-models", cx);
    assert!(harness.transport.requests("connection.test.run").is_empty());
    assert!(harness.transport.requests("connection.models.fetch").is_empty());
}

#[gpui_kit::test]
fn models_refresh_and_switch_on_and_off(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    harness.open_detail("c-relay", &[], cx);
    harness.transport.reply(
        "connection.models.fetch",
        Ok(json!({"kind": "committed", "catalogRevision": 9, "connection":
                  {"connectionId": "c-relay", "revision": 5}, "modelCount": 3,
                  "source": "fetched", "fetchedAt": 1})),
    );
    harness.click("connection-refresh-models", cx);
    assert_eq!(harness.label(status("models"), cx).as_deref(), Some("Fetched 3 models"));
    harness.transport.reply(
        "connection.models.fetch",
        Ok(json!({"kind": "superseded", "changed": ["credential"]})),
    );
    harness.click("connection-refresh-models", cx);
    let note = harness.label(status("models"), cx).unwrap_or_default();
    assert!(
        note.starts_with(copy::MODELS_FETCH_FAILED.en())
            && note.contains(copy::EFFECT_SUPERSEDED.en()),
        "{note}"
    );

    harness.transport.reply("connection.catalog.update", Ok(committed("c-relay", 5)));
    harness.click(domain_element_id("model-enabled", "m2"), cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.update")[0]["changes"]["enabledModelIds"],
        json!(["m1", "m2"])
    );
    harness.transport.reply(
        "connection.catalog.update",
        Ok(json!({"kind": "connection_stale", "expected": {"connectionId": "c-relay", "revision": 4},
                  "actual": {"connectionId": "c-relay", "revision": 6}})),
    );
    harness.transport.reply(
        "connection.catalog.update",
        Ok(json!({"kind": "connection_stale", "expected": {"connectionId": "c-relay", "revision": 4},
                  "actual": {"connectionId": "c-relay", "revision": 6}})),
    );
    harness.click(domain_element_id("model-enabled", "m1"), cx);
    assert_eq!(harness.transport.requests("connection.catalog.update").len(), 3, "one retry");
    assert_eq!(
        harness.label(status("models"), cx).as_deref(),
        Some(
            format!("{} {}", copy::SAVE_MODELS_FAILED.en(), settings_copy::CONNECTION_CHANGED.en())
                .as_str()
        )
    );
}

#[gpui_kit::test]
fn a_models_parameters_are_checked_and_saved_in_their_table(cx: &mut TestAppContext) {
    let harness = Harness::models(
        relay(8, |items| {
            items[5]["modelOverride"] = json!({"displayName": "Second", "knowledgeCutoff": "2025"});
        }),
        cx,
    );
    let detail = harness.open_detail("c-relay", &[], cx);
    harness.click(domain_element_id("model-parameters-open", "m1"), cx);
    assert!(harness.shows("model-parameters", cx));
    let editor = detail
        .read_with(cx, |detail, _| detail.parameters().cloned())
        .expect("the dialog's editor");
    harness.with_window(cx, |window, cx| {
        editor.update(cx, |editor, cx| {
            editor.fill("context-window", "128K", window, cx);
            editor.fill("input-limit", "200K", window, cx);
        });
    });
    assert_eq!(
        harness.label(domain_element_id("model-parameters-note", "input-limit"), cx).as_deref(),
        Some(copy::LIMITS_CONFLICT.en())
    );
    harness.click("model-parameters-save", cx);
    assert!(harness.transport.requests("connection.catalog.update").is_empty());
    harness.with_window(cx, |window, cx| {
        editor.update(cx, |editor, cx| editor.fill("input-limit", "1.5x", window, cx));
    });
    assert_eq!(
        harness.label(domain_element_id("model-parameters-note", "input-limit"), cx).as_deref(),
        Some(copy::TOKEN_COUNT_INVALID.en())
    );
    harness.with_window(cx, |window, cx| {
        editor.update(cx, |editor, cx| editor.fill("input-limit", "64K", window, cx));
    });
    harness.transport.reply("connection.catalog.update", Ok(committed("c-relay", 5)));
    harness.click("model-parameters-save", cx);
    // The whole table goes back, the other model's facts kept.
    assert_eq!(
        harness.transport.requests("connection.catalog.update"),
        [json!({"expected": {"connectionId": "c-relay", "revision": 4},
                "changes": {"name": "My relay", "baseUrl": "https://relay.example/v1",
                            "enabled": true, "enabledModelIds": ["m1"],
                            "modelOverrides": {
                                "m1": {"contextWindow": 128000, "inputLimit": 64000},
                                "m2": {"displayName": "Second", "knowledgeCutoff": "2025"}}}})]
    );
    assert!(!harness.shows("model-parameters", cx), "the dialog closes once saved");

    // Parameters that changed since the dialog opened are not overwritten.
    harness.click(domain_element_id("model-parameters-open", "m2"), cx);
    harness.transport.always(
        "connection.catalog.query",
        Ok(relay(9, |items| items[5]["modelOverride"] = json!({"displayName": "Elsewhere"}))),
    );
    let editor = detail.read_with(cx, |detail, _| detail.parameters().cloned()).expect("editor");
    harness.with_window(cx, |window, cx| {
        editor.update(cx, |editor, cx| editor.fill("display-name", "Mine", window, cx));
    });
    harness.click("model-parameters-save", cx);
    assert_eq!(harness.transport.requests("connection.catalog.update").len(), 1);
    let error = harness.label("model-parameters-error", cx).unwrap_or_default();
    assert!(error.ends_with(copy::PARAMETERS_CHANGED.en()), "{error}");
}

#[gpui_kit::test]
fn a_model_is_added_by_hand_with_its_parameters(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    let detail = harness.open_detail("c-relay", &[], cx);
    harness.click("connection-add-model", cx);
    let editor = detail.read_with(cx, |detail, _| detail.parameters().cloned()).expect("editor");
    harness.click("model-parameters-save", cx);
    assert_eq!(
        harness.label(domain_element_id("model-parameters-note", "id"), cx).as_deref(),
        Some(copy::MODEL_ID_REQUIRED.en())
    );
    harness.with_window(cx, |window, cx| {
        editor.update(cx, |editor, cx| editor.fill("id", "m2", window, cx));
    });
    assert_eq!(
        harness.label(domain_element_id("model-parameters-note", "id"), cx).as_deref(),
        Some(copy::MODEL_ID_DUPLICATE.en())
    );
    harness.with_window(cx, |window, cx| {
        editor.update(cx, |editor, cx| {
            editor.fill("id", "new-model", window, cx);
            editor.fill("context-window", "1M", window, cx);
        });
    });
    harness.transport.reply("connection.catalog.update", Ok(committed("c-relay", 5)));
    harness.click("model-parameters-save", cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.update")[0]["changes"],
        json!({"name": "My relay", "baseUrl": "https://relay.example/v1", "enabled": true,
               "enabledModelIds": ["m1", "new-model"],
               "modelOverrides": {"new-model": {"contextWindow": 1000000}}})
    );
}

#[gpui_kit::test]
fn request_headers_and_body_are_edited_checked_and_saved(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    let detail = harness.open_detail("c-relay", &["X-Title"], cx);
    harness.click(domain_element_id("detail-edit", "request-headers"), cx);
    assert!(harness.shows(domain_element_id("detail-headers", "header-1"), cx), "the saved one");
    harness.click(domain_element_id("detail-headers", "add"), cx);
    harness.with_window(cx, |window, cx| window.input("HTTP-Referer", cx));
    harness.click(domain_element_id("detail-headers", "value-2"), cx);
    harness.with_window(cx, |window, cx| window.input("https://maka.dev", cx));
    harness.transport.reply(
        "connection.request-headers.replace",
        Ok(json!({"kind": "committed", "names": ["X-Title", "HTTP-Referer"]})),
    );
    harness.click(domain_element_id("detail-save", "request-headers"), cx);
    // The saved header keeps its value; the new one sends its own.
    assert_eq!(
        harness.transport.requests("connection.request-headers.replace"),
        [json!({"connectionId": "c-relay",
                "headers": [{"name": "X-Title"}, {"name": "HTTP-Referer", "value": "https://maka.dev"}]})]
    );
    assert_eq!(detail.read_with(cx, |detail, _| detail.editing()), None);
    // A header Maka sends itself is refused before anything is sent.
    harness.click(domain_element_id("detail-edit", "request-headers"), cx);
    harness.click(domain_element_id("detail-headers", "add"), cx);
    harness.with_window(cx, |window, cx| window.input("Authorization", cx));
    harness.click(domain_element_id("detail-headers", "value-5"), cx);
    harness.with_window(cx, |window, cx| window.input("Bearer x", cx));
    harness.click(domain_element_id("detail-save", "request-headers"), cx);
    assert_eq!(harness.transport.requests("connection.request-headers.replace").len(), 1);
    assert_eq!(
        harness.label(status("request-headers"), cx).as_deref(),
        Some(copy::REQUEST_HEADERS_INVALID.en())
    );
    harness.click(domain_element_id("detail-cancel", "request-headers"), cx);

    harness.click(domain_element_id("detail-edit", "request-body"), cx);
    harness.with_window(cx, |window, cx| window.input("[1, 2]", cx));
    harness.click(domain_element_id("detail-save", "request-body"), cx);
    assert!(harness.transport.requests("connection.catalog.update").is_empty());
    assert_eq!(
        harness.label(status("request-body"), cx).as_deref(),
        Some(copy::REQUEST_BODY_INVALID.en())
    );
    harness.type_over(r#"{"provider": {"order": ["Anthropic"]}}"#, cx);
    harness.transport.reply("connection.catalog.update", Ok(committed("c-relay", 5)));
    harness.click(domain_element_id("detail-save", "request-body"), cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.update")[0]["changes"]["requestBodyOverlay"],
        json!({"provider": {"order": ["Anthropic"]}})
    );
    assert_eq!(detail.read_with(cx, |detail, _| detail.editing()), None);
}

#[gpui_kit::test]
fn delete_asks_first_and_set_as_default_uses_the_first_model(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    harness.open_detail("c-relay", &[], cx);
    harness.transport.reply(
        "connection.catalog.set-default-target",
        Ok(json!({"kind": "committed", "catalogRevision": 9})),
    );
    harness.click("connection-set-default", cx);
    assert_eq!(
        harness.transport.requests("connection.catalog.set-default-target"),
        [
            json!({"expectedCatalogRevision": 8, "target": {"connectionId": "c-relay", "modelId": "m1"}})
        ]
    );

    harness.click("connection-delete", cx);
    harness.with_window(cx, |window, cx| window.click("cancel", cx));
    assert!(harness.transport.requests("connection.catalog.remove").is_empty());
    harness.transport.reply(
        "connection.catalog.remove",
        Ok(json!({"kind": "connection_stale", "expected": {"connectionId": "c-relay", "revision": 4},
                  "actual": {"connectionId": "c-relay", "revision": 5}})),
    );
    harness.transport.reply(
        "connection.catalog.remove",
        Ok(json!({"kind": "committed", "catalogRevision": 10})),
    );
    harness.click("connection-delete", cx);
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(harness.transport.requests("connection.catalog.remove").len(), 2, "tried again");
    assert!(harness.detail(cx).is_none());
    assert!(harness.shows("connections-list", cx));
}

#[gpui_kit::test]
fn full_access_becomes_the_default_only_once_confirmed(cx: &mut TestAppContext) {
    let transport = std::sync::Arc::new(crate::tests::ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy(3, "ask")));
    let harness = Harness::open_with_transport(SettingsSection::General, transport, cx);
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Auto"));
    harness.choose("default-permission", &["down"], cx);
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty(), "asked first");
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Auto"));
    assert!(harness.shows("cancel", cx), "the question shows");
    harness.with_window(cx, |window, cx| window.click("cancel", cx));
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty(), "Keep Auto keeps it");
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Auto"));

    harness.choose("default-permission", &["down"], cx);
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 4})));
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(
        harness.transport.requests("runtime.policy.mutate"),
        [json!({"expectedRevision": 3, "operation": {"kind": "set_chat_defaults",
                "value": {"permissionMode": "bypass", "codeModeEnabled": true}}})]
    );
    assert_eq!(harness.chosen("default-permission", cx).as_deref(), Some("Full access"));
    // Back to Auto asks nothing.
    harness
        .transport
        .reply("runtime.policy.mutate", Ok(json!({"kind": "committed", "revision": 5})));
    harness.choose("default-permission", &["up"], cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate").len(), 2);
}

#[test]
fn every_effect_refusal_and_failure_reads_as_a_sentence() {
    use host_protocol::ConnectionEffectFailureClass as F;
    use host_protocol::ConnectionEffectRejection as R;
    use shared::copy::Locale;
    for reason in [
        R::ConnectionNotFound,
        R::ConnectionDisabled,
        R::ProviderActionUnavailable,
        R::CredentialNotConfigured,
        R::Other("future".into()),
    ] {
        let message = connection_ops::effect_refusal(&reason, "DeepSeek", Locale::English);
        assert!(message.ends_with('.'), "{reason}: {message}");
    }
    for class in [
        F::Auth,
        F::Timeout,
        F::ProviderUnavailable,
        F::Network,
        F::InvalidResponse,
        F::Unknown,
        F::Other("x".into()),
    ] {
        let message = connection_ops::provider_failure(&class, Locale::English);
        assert!(message.ends_with('.'), "{class}: {message}");
        let refresh = crate::add_connection::models_fetch_message(
            &ModelsFetchFailure::Provider(class),
            crate::add_connection::ModelsTroubleshooting::Endpoint,
            Locale::SimplifiedChinese,
        );
        assert!(!refresh.is_empty());
    }
}

/// The places `--open-settings models:<target>` opens for screenshots.
#[gpui_kit::test]
fn launch_targets_open_the_pages_places(cx: &mut TestAppContext) {
    let harness = Harness::models(relay(8, |_| {}), cx);
    let open = |harness: &Harness, target: &'static str, cx: &mut TestAppContext| {
        let view = harness.view.clone();
        harness.with_window(cx, |window, cx| {
            view.update(cx, |view, cx| view.open_target(target, window, cx))
        })
    };
    assert!(open(&harness, "catalog", cx));
    assert!(harness.shows("provider-catalog", cx));
    assert!(open(&harness, "add:custom", cx));
    assert!(harness.shows("connection-slug", cx));
    assert!(!open(&harness, "add:no-such-provider", cx));
    harness.click("cancel-connection", cx);
    assert!(open(&harness, "connection:my-relay", cx));
    assert!(harness.detail(cx).is_some());
    assert!(open(&harness, "parameters:my-relay:m1", cx));
    assert!(harness.shows("model-parameters", cx));
    let editor = harness
        .detail(cx)
        .and_then(|detail| detail.read_with(cx, |detail, _| detail.parameters().cloned()));
    assert!(editor.is_some(), "the dialog edits m1");
    harness.with_window(cx, |window, cx| window.press("escape", cx));
    assert!(open(&harness, "parameters:my-relay:qwen2.5:7b", cx), "a model id with a colon");
    let editor = harness
        .detail(cx)
        .and_then(|detail| detail.read_with(cx, |detail, _| detail.parameters().cloned()));
    let mode = editor.map(|editor| editor.read_with(cx, |editor, _| format!("{editor:?}")));
    assert!(mode.as_deref().is_some_and(|mode| mode.contains("\"qwen2.5:7b\"")), "{mode:?}");
    assert!(!open(&harness, "connection:nobody", cx));
    assert!(!open(&harness, "nonsense", cx));
}

#[gpui_kit::test]
fn command_f_focuses_the_search_or_filter_of_each_models_view(cx: &mut TestAppContext) {
    let field = |harness: &Harness, cx: &mut TestAppContext| {
        harness.view.read_with(cx, |view, cx| view.connections().read(cx).search_field(cx))
    };
    // The list's search, with connections to narrow.
    let harness = Harness::models(three_connections(8), cx);
    assert!(harness.shows("connections-search", cx));
    crate::tests::command_f_focuses(&harness, &field(&harness, cx).expect("the list's"), cx);
    // The catalog's.
    harness.click("settings-add-connection", cx);
    assert!(harness.shows("provider-search", cx));
    let search = field(&harness, cx).expect("the catalog's");
    let providers =
        harness.view.read_with(cx, |view, cx| view.connections().read(cx).providers().clone());
    assert_eq!(search, providers.read_with(cx, |providers, _| providers.search().clone()));
    crate::tests::command_f_focuses(&harness, &search, cx);

    // A provider's models to choose from, more than fit unfiltered.
    harness.click("connections-back", cx);
    let form = harness.pick("deepseek", cx);
    assert!(field(&harness, cx).is_none(), "nothing to filter while the key is asked for");
    harness.fill(&form, FormFields { api_key: Some("sk-secret"), ..FormFields::default() }, cx);
    let models: Vec<Value> = (0..9).map(|n| json!({"id": format!("model-{n}")})).collect();
    harness
        .transport
        .reply("connection.onboarding.verify", Ok(json!({"kind": "verified", "models": models})));
    harness.click("submit-connection", cx);
    assert_eq!(form.read_with(cx, |form, _| form.phase()), AddConnectionPhase::Models);
    assert!(harness.shows("connection-models-filter", cx));
    crate::tests::command_f_focuses(&harness, &field(&harness, cx).expect("the models'"), cx);

    // A connection's models in its detail.
    let catalog = relay(8, |items| {
        items.extend((2..9).map(|n| entry(0, n, &format!("m{}", n + 1), None)));
    });
    let harness = Harness::models(catalog, cx);
    harness.open_detail("c-relay", &[], cx);
    assert!(harness.shows("connection-models-filter", cx));
    crate::tests::command_f_focuses(&harness, &field(&harness, cx).expect("the detail's"), cx);
}
