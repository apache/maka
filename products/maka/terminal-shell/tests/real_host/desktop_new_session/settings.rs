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

use super::*;

pub(super) async fn desktop_settings_page_shell_preserves_state_and_overlays() {
    let fixture = Fixture::open().await;
    let mut mod_key = Modifiers::default();
    mod_key.platform = cfg!(target_os = "macos");
    mod_key.control = !cfg!(target_os = "macos");

    // 1. Wide desktop: draft & Rooms mode preservation, idempotent mod+, / mod+g,
    // focused-input Escape blur, Select Escape isolation, and Back to app / Escape return.
    let desktop = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(1120),
            nsh_terminal::DevicePixels(900),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    desktop.press("Focus message composer").await;
    desktop.type_text("PRESERVED_SETTINGS_DRAFT").await;
    desktop.press("Open settings").await;

    let back = desktop.control("Back to app").await;
    let general = desktop.control("Settings section General").await;
    assert!(
        desktop.controls("Close settings").is_empty(),
        "page-mode Settings must not render a modal close button"
    );
    assert_eq!(back.left(), general.left());
    assert!(back.bottom() < general.top());

    desktop.press("Settings section General").await;
    let language = desktop.control("Language").await;
    assert!(back.right() <= language.left());

    // Pressing mod+, while Settings is already open is idempotent and keeps the current category.
    desktop.key_with(",", mod_key);
    desktop.pump();
    desktop.control("Language").await;

    // Pressing Escape inside a focused Settings <Input> blurs the field first without leaving the page.
    desktop.press("Edit personalization").await;
    desktop.control("Change avatar").await;
    desktop
        .until("Display name input did not focus", || {
            desktop.platform.text_input_target().is_some().then_some(())
        })
        .await;
    desktop.key("escape", false);
    desktop
        .until("Escape did not blur Display name", || {
            desktop.platform.text_input_target().is_none().then_some(())
        })
        .await;
    desktop.control("Change avatar").await;

    // Second Escape steps back from Personalization to General while keeping Settings open.
    desktop.key("escape", false);
    desktop.control("Language").await;

    // Opening a Select inside Settings and pressing Escape closes only the popup.
    desktop.press("Language").await;
    desktop.control("English").await;
    desktop.key("escape", false);
    desktop
        .until("Language dropdown did not close on Escape", || {
            desktop.controls("English").is_empty().then_some(())
        })
        .await;
    desktop.control("Language").await;

    // Back to app returns to the mounted conversation with its draft intact.
    desktop.press("Back to app").await;
    desktop.press("Focus message composer").await;
    desktop.expect_text("PRESERVED_SETTINGS_DRAFT").await;

    // Clean-root Escape also returns to Conversations with the draft intact.
    desktop.press("Open settings").await;
    desktop.control("Back to app").await;
    desktop.key("escape", false);
    desktop.press("Focus message composer").await;
    desktop.expect_text("PRESERVED_SETTINGS_DRAFT").await;

    // On an empty draft conversation (selected() === null), mod+g while Settings is open
    // stays idempotent instead of dismissing and remounting Settings.
    desktop.new_draft().await;
    desktop.press("Open settings").await;
    desktop.press("Settings section General").await;
    desktop.control("Language").await;
    desktop.key_with("g", mod_key);
    desktop.pump();
    desktop.control("Language").await;
    desktop.key("escape", false);
    desktop.control("Focus message composer").await;

    // Entering and leaving Settings from Rooms preserves workspaceMode === 'rooms'.
    desktop.press("More features").await;
    desktop.press("Rooms").await;
    desktop
        .until("Rooms workspace did not appear", || {
            desktop.controls("New room").first().copied()
        })
        .await;
    desktop.press("Settings").await;
    desktop.control("Back to app").await;
    desktop.key("escape", false);
    desktop
        .until("Escape from Settings did not return to Rooms", || {
            desktop.controls("New room").first().copied()
        })
        .await;
    desktop.close().await;

    // 2. Single narrow (WINDOW_MIN_SIZE 640x480) folded-rail non-overlap check.
    let narrow = Desktop::open_at(
        &fixture,
        &fixture.address,
        size(
            nsh_terminal::DevicePixels(640),
            nsh_terminal::DevicePixels(480),
        ),
        nsh_core::platform::Appearance::Dark,
    )
    .await;
    narrow.press("Expand session browser").await;
    narrow.press("Open settings").await;
    let narrow_back = narrow.control("Back to app").await;
    let narrow_general = narrow.control("Settings section General").await;
    narrow.press("Settings section General").await;
    let narrow_content = narrow.control("Edit personalization").await;
    assert!(narrow_back.bottom() <= narrow_general.top());
    assert!(narrow_general.bottom() <= narrow_content.top());
    narrow.close().await;

    fixture.finish().await;
}
