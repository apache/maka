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

use nsh_core::{
    Size,
    element::Instance,
    platform::{Environment, Idiom, Os},
    prelude::px,
};
use nsh_testing::Headless;

#[nsh_core::element::class]
struct NoticesHost;
#[nsh_core::element::class]
impl NoticesHost {
    #[getter]
    pub fn system_locale(&self) -> String {
        "en".into()
    }

    pub fn dictation_storage_prefix(&self) -> String {
        "test:".into()
    }
}

fn start(idiom: Idiom) -> Headless {
    let mut registry = crate::bindings::ui_registry();
    registry.value("host", || Instance::new(NoticesHost));
    let sets = vec![nsh_base::registry(), registry];
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: std::path::Path::new("tests/fixtures/composer-notices.tsx")
            .canonicalize()
            .unwrap(),
        minify: false,
        split: false,
        ui_sets: sets
            .iter()
            .flat_map(nsh_core::element::Registry::sets)
            .map(Into::into)
            .collect(),
        asset_root_from: Some(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")),
        ..Default::default()
    })
    .unwrap();
    let config = nsh_engine::EngineConfig {
        viewport: Size::new(px(900.0), px(700.0)),
        environment: Environment {
            os: Os::MacOs,
            idiom,
            native_focus_scopes: true,
            fallback_key_bindings: true,
            ..Environment::default()
        },
        ui_sets: sets,
        ..nsh_engine::EngineConfig::new(nsh_engine::Bundle::source(bundle.code))
    };
    Headless::start(config).unwrap()
}

fn assert_main_composer_deduplicates_blocks(idiom: Idiom) {
    let mut app = start(idiom);

    // 1. Workspace block: owned by request InlineCallout, never duplicated in Composer.
    app.wait_for("text:The workspace for this task is unavailable.")
        .unwrap();
    assert_eq!(
        app.screen()
            .count("text:The workspace for this task is unavailable.")
            .unwrap(),
        1
    );
    assert!(!app.screen().enabled("label:Send message").unwrap());

    // 2. Attachments block: owned by DraftAttachments tray, not repeated in Composer warning.
    app.press_key("f2").unwrap();
    app.wait_for("text:Disk read failed").unwrap();
    assert_eq!(app.screen().count("text:Disk read failed").unwrap(), 1);
    assert_eq!(
        app.screen()
            .count("text:Remove the failed attachment or choose it again.")
            .unwrap(),
        0
    );
    assert!(!app.screen().enabled("label:Send message").unwrap());

    // 3. Draft block: owned by Composer shelf (desktop) / warning row (terminal), appears once.
    app.press_key("f3").unwrap();
    app.wait_for(
        "text:This conversation is archived. Restore it in Sessions to send; your draft is kept.",
    )
    .unwrap();
    assert_eq!(
        app.screen()
            .count(
                "text:This conversation is archived. Restore it in Sessions to send; your draft is kept."
            )
            .unwrap(),
        1
    );
    assert!(!app.screen().enabled("label:Send message").unwrap());
}

#[test]
fn desktop_composer_renders_each_send_block_only_in_its_owning_surface() {
    assert_main_composer_deduplicates_blocks(Idiom::Desktop);
}

#[test]
fn terminal_composer_renders_each_send_block_only_in_its_owning_surface() {
    assert_main_composer_deduplicates_blocks(Idiom::Terminal);
}

#[test]
fn compact_composer_renders_owned_blocks_immediately_without_duplicating_workspace_callout() {
    let mut app = start(Idiom::Desktop);
    app.wait_for("label:Send message").unwrap();
    app.press_key("f4").unwrap();
    app.wait_for("label:Ask Maka").unwrap();

    // Workspace block stays only in request; submitting does not duplicate it or send.
    assert_eq!(
        app.screen()
            .count("text:The workspace for this task is unavailable.")
            .unwrap(),
        1
    );
    app.submit("label:Ask Maka").unwrap();
    assert!(app.settle());
    assert_eq!(
        app.screen()
            .count("text:The workspace for this task is unavailable.")
            .unwrap(),
        1
    );
    assert!(app.screen().matches("text:submissions:0").unwrap());

    // Draft block shows immediately without submitting, once, and blocks submission.
    app.press_key("f3").unwrap();
    app.wait_for(
        "text:This conversation is archived. Restore it in Sessions to send; your draft is kept.",
    )
    .unwrap();
    assert_eq!(
        app.screen()
            .count(
                "text:This conversation is archived. Restore it in Sessions to send; your draft is kept."
            )
            .unwrap(),
        1
    );
    app.submit("label:Ask Maka").unwrap();
    assert!(app.settle());
    assert!(app.screen().matches("text:submissions:0").unwrap());

    // Attachments block shows once in CompactComposer because it has no DraftAttachments tray.
    app.press_key("f2").unwrap();
    app.wait_for("text:Remove the failed attachment or choose it again.")
        .unwrap();
    assert_eq!(
        app.screen()
            .count("text:Remove the failed attachment or choose it again.")
            .unwrap(),
        1
    );
    app.submit("label:Ask Maka").unwrap();
    assert!(app.settle());
    assert!(app.screen().matches("text:submissions:0").unwrap());

    // Once unblocked, submitting the same input dispatches normally.
    app.press_key("f5").unwrap();
    app.submit("label:Ask Maka").unwrap();
    app.wait_for("text:submissions:1").unwrap();
}
