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

use serde::{Deserialize, Serialize};

mod browser_wait;
pub use browser_wait::BrowserWaitOperation;

mod browser_download;
pub use browser_download::{BrowserDownloadOptions, BrowserMediaTarget};

fn deserialize_numbers<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    // Reconstruct numbers after enum buffering before decoding numeric payloads.
    let value = serde_json::Value::deserialize(deserializer)?;
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

mod browser_mutation;
pub use browser_mutation::{
    BrowserCheckOptions, BrowserClickOptions, BrowserKeyboardModifier, BrowserMouseButton,
    BrowserMutationOperation, BrowserSelectOption, BrowserTextOptions,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "id",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Handle {
    App(String),
    Tab(String),
}

pub use crate::browser_clipboard::{
    Entry as ClipboardEntry, Item as ClipboardItem, Items as ClipboardItems,
    Payload as ClipboardPayload, PresentationStyle as ClipboardPresentationStyle,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Documentation,
    StartAudioRecording {
        options: AudioOptions,
    },
    StopAudioRecording,
    ConfigureCursor {
        options: crate::cursor::Options,
    },
    CursorState {
        options: InventoryOptions,
    },
    GetState {
        options: InventoryOptions,
    },
    ListApps {
        options: InventoryOptions,
    },
    ListWindows {
        options: InventoryOptions,
    },
    GetApp {
        target: AppReference,
    },
    LaunchApp {
        app: String,
    },
    Observe {
        handle: Handle,
        kind: ObservationKind,
        options: ObservationOptions,
    },
    Action {
        handle: Handle,
        action: Action,
    },
    ListBrowsers {
        options: InventoryOptions,
    },
    ListTabs {
        options: InventoryOptions,
    },
    GetBrowser {
        options: BrowserOptions,
    },
    BrowserTab {
        #[serde(rename = "browserId")]
        browser_id: String,
        reference: BrowserTabReference,
    },
    BrowserManagedTabs {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    BrowserUserOpenTabs {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    BrowserUserClaimTab {
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    TabMetadata {
        handle: Handle,
    },
    ClipboardRead {
        handle: Handle,
    },
    ClipboardReadText {
        handle: Handle,
    },
    ClipboardWrite {
        handle: Handle,
        items: ClipboardItems,
    },
    ClipboardWriteText {
        handle: Handle,
        text: String,
    },
    GetJsDialog {
        handle: Handle,
    },
    HandleJsDialog {
        handle: Handle,
        #[serde(rename = "dialogId")]
        dialog_id: String,
        action: DialogAction,
        #[serde(
            default,
            rename = "promptText",
            deserialize_with = "dialog_prompt_text",
            skip_serializing_if = "Option::is_none"
        )]
        prompt_text: Option<String>,
    },
    BrowserRead {
        handle: Handle,
        locator: LocatorPlan,
        operation: BrowserReadOperation,
        #[serde(default)]
        options: BrowserReadOptions,
    },
    BrowserMutation {
        handle: Handle,
        locator: LocatorPlan,
        operation: BrowserMutationOperation,
    },
    BrowserWait {
        handle: Handle,
        operation: BrowserWaitOperation,
    },
    BrowserDownloadWait {
        handle: Handle,
        #[serde(default)]
        options: BrowserDownloadOptions,
    },
    BrowserDownloadPath {
        handle: Handle,
        scope: String,
        #[serde(rename = "downloadId")]
        download_id: String,
        #[serde(default)]
        options: BrowserDownloadOptions,
    },
    BrowserDownloadMedia {
        handle: Handle,
        target: BrowserMediaTarget,
        #[serde(default)]
        options: BrowserDownloadOptions,
    },
    GetTab {
        reference: TabReference,
        options: InventoryOptions,
    },
    CreateBrowserTab {
        #[serde(rename = "browserId")]
        browser_id: String,
        url: Option<String>,
        options: CreateTabOptions,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DialogAction {
    Accept,
    Dismiss,
}

fn dialog_prompt_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioOptions {
    pub max_duration_ms: Option<u64>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InventoryOptions {
    pub emit: Option<bool>,
    pub browser: Option<String>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ObservationOptions {
    pub emit: Option<bool>,
    #[serde(default)]
    pub disable_diffing: bool,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    Ax,
    Screenshot,
    Both,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AppReference {
    Name(String),
    Window {
        #[serde(rename = "windowId")]
        window_id: u64,
    },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TabReference {
    Id(String),
    Url { url: String },
    Mention { mention: String },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "id",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum BrowserTabReference {
    Existing(String),
    New,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocatorPlan {
    pub selector: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserReadOperation {
    WaitDiagnostics,
    DomSnapshot,
    Count,
    AllTextContents,
    TextContent,
    InnerText,
    GetAttribute { name: String },
    IsEnabled,
    IsVisible,
    Rows { relative: Option<LocatorPlan> },
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserReadOptions {
    pub timeout_ms: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrowserOptions {
    pub id: Option<String>,
    pub url: Option<String>,
    pub extension_instance_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateTabOptions {
    pub visible: Option<bool>,
    pub session_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Position {
    Element(u64),
    Point(#[serde(deserialize_with = "deserialize_numbers")] [f64; 2]),
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClickOptions {
    pub mouse_button: Option<MouseButton>,
    pub click_count: Option<u32>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}
impl MouseButton {
    pub fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}
impl Direction {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Distance {
    Pages(#[serde(deserialize_with = "deserialize_numbers")] f64),
    Pixels {
        #[serde(deserialize_with = "deserialize_numbers")]
        pixels: f64,
    },
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PasteOptions {
    pub format: Option<PasteFormat>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PasteFormat {
    Text,
    Md,
    Html,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SelectOptions {
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub selection_type: Option<SelectionType>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionType {
    Text,
    CursorBefore,
    CursorAfter,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    MoveCursor {
        target: Position,
    },
    Click {
        target: Position,
        options: ClickOptions,
    },
    LinuxClick {
        input: serde_json::Value,
    },
    LinuxScroll {
        input: serde_json::Value,
    },
    LinuxDrag {
        input: serde_json::Value,
    },
    Drag {
        #[serde(deserialize_with = "deserialize_numbers")]
        from: [f64; 2],
        #[serde(deserialize_with = "deserialize_numbers")]
        to: [f64; 2],
    },
    Scroll {
        target: Position,
        direction: Direction,
        #[serde(
            default,
            deserialize_with = "scroll_distance",
            skip_serializing_if = "Option::is_none"
        )]
        distance: Option<Distance>,
    },
    SetValue {
        index: u64,
        value: String,
    },
    SelectText {
        index: u64,
        text: String,
        options: SelectOptions,
    },
    Secondary {
        index: u64,
        action: String,
    },
    TypeText {
        index: Option<u64>,
        text: String,
    },
    Paste {
        index: Option<u64>,
        text: String,
        options: PasteOptions,
    },
    PressKey {
        index: Option<u64>,
        key: String,
    },
    Navigate {
        url: String,
    },
    Back,
    Forward,
    Reload,
    Close,
}

fn scroll_distance<'de, D>(deserializer: D) -> Result<Option<Distance>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Distance::deserialize(deserializer).map(Some)
}
