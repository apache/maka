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

pub(crate) mod browser_capability;
pub use browser_capability::{
    BundleOptions as PageAssetBundleOptions, Viewport as BrowserViewport,
};

mod browser_cua;
pub use browser_cua::BrowserCuaOperation;

mod browser_filechooser;
pub use browser_filechooser::BrowserFileChooserOptions;

mod browser_wait;
pub use browser_wait::BrowserWaitOperation;

mod browser_download;
pub use browser_download::{BrowserDownloadOptions, BrowserMediaTarget};

pub(crate) fn deserialize_numbers<'de, D, T>(deserializer: D) -> Result<T, D::Error>
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
    BrowserViewportSet {
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(deserialize_with = "deserialize_numbers")]
        options: BrowserViewport,
    },
    BrowserViewportReset {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    TabPageAssetsList {
        handle: Handle,
    },
    TabPageAssetsBundle {
        handle: Handle,
        options: PageAssetBundleOptions,
    },

    NativeComputer {
        call: NativeComputerCall,
    },
    Documentation,
    ReadDocumentation {
        name: String,
    },
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
    BrowserRelease {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    BrowserTab {
        #[serde(rename = "browserId")]
        browser_id: String,
        reference: BrowserTabReference,
    },
    BrowserSelect {
        selection: BrowserSelection,
    },
    BrowserSelectedTab {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    BrowserNameSession {
        #[serde(rename = "browserId")]
        browser_id: String,
        name: String,
    },
    BrowserHistory {
        #[serde(rename = "browserId")]
        browser_id: String,
        options: BrowserHistoryOptions,
    },
    BrowserManagedTabs {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    BrowserUserOpenTabs {
        #[serde(rename = "browserId")]
        browser_id: String,
    },
    BrowserUserGetTabContext {
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    BrowserUserClaimTab {
        #[serde(rename = "browserId")]
        browser_id: String,
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    BrowserScreenshot {
        handle: Handle,
        options: BrowserScreenshotOptions,
    },
    BrowserMarkTab {
        handle: Handle,
        status: BrowserTabMark,
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
    BrowserEvaluate {
        handle: Handle,
        locator: Option<LocatorPlan>,
        mode: BrowserEvaluateMode,
        #[serde(rename = "scriptJson")]
        script_json: String,
        options: BrowserEvaluateOptions,
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
    BrowserCua {
        handle: Handle,
        operation: BrowserCuaOperation,
    },
    BrowserWait {
        handle: Handle,
        operation: BrowserWaitOperation,
    },
    BrowserFileChooserWait {
        handle: Handle,
        #[serde(default)]
        options: BrowserFileChooserOptions,
    },
    BrowserFileChooserSetFiles {
        handle: Handle,
        #[serde(rename = "fileChooserId")]
        file_chooser_id: String,
        files: Vec<String>,
        #[serde(default)]
        options: BrowserFileChooserOptions,
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

/// End-of-turn retention intent; it grants no new browser control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserTabMark {
    /// Keep custody for the same session until a later actual turn resumes it.
    Handoff,
    /// Keep the tab open while returning it to the user.
    Deliverable,
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
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrowserScreenshotOptions {
    pub full_page: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_numbers")]
    pub clip: Option<BrowserScreenshotClip>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserScreenshotClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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

/// The fixed scope passed to one read-only browser evaluation.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserEvaluateMode {
    Page,
    Element,
    All,
}

/// Evaluate preserves the selected runtime's numeric timeout clamp independently
/// of locator read option validation. Other JavaScript values use the default.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserEvaluateOptions {
    pub timeout_ms: Option<serde_json::Value>,
}
impl BrowserEvaluateOptions {
    #[cfg(feature = "native-desktop")]
    pub(crate) fn budget(&self) -> std::time::Duration {
        let milliseconds = self
            .timeout_ms
            .as_ref()
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(3000.0)
            .clamp(0.0, 3000.0);
        std::time::Duration::from_secs_f64(milliseconds / 1000.0)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum BrowserSelection {
    Default,
    Url { url: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserHistoryOptions {
    pub queries: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_numbers")]
    pub limit: Option<f64>,
    pub from: Option<String>,
    pub to: Option<String>,
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

// The Command variant is: NativeComputer { call: NativeComputerCall }.
// Input stays raw until the selected platform boundary; it grants no authority.
// Existing audio commands retain their original Host consent/admission path.

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeComputerCall {
    Invoke {
        operation: NativeComputerMethod,
        args: Vec<serde_json::Value>,
    },
    DragStart {
        handle: String,
        point: serde_json::Value,
    },
    DragMove {
        handle: String,
        point: serde_json::Value,
    },
    DragEnd {
        handle: String,
    },
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeComputerMethod {
    PerformSecondaryAction,
    Click,
    Drag,
    ActivateWindow,
    GetScreenshot,
    ListApps,
    ListWindows,
    Move,
    MoveRelative,
    PressKey,
    Scroll,
    TypeText,
    LaunchApp,
    GetWindowState,
    GetAppState,
    Paste,
    SelectText,
    SetValue,
    GetWindow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_numeric_options_survive_command_buffering() {
        let cases = [
            r#"{"method":"browserViewportSet","browserId":"browser","options":{"width":1920.0,"height":1080.0}}"#,
            r#"{"method":"browserScreenshot","handle":{"kind":"tab","id":"tab"},"options":{"clip":{"x":10.5,"y":20.25,"width":300.75,"height":200.5}}}"#,
            r#"{"method":"browserHistory","browserId":"browser","options":{"limit":5.0}}"#,
        ];
        let mut failures = Vec::new();
        for text in cases {
            for buffered in [false, true] {
                let decoded: Result<Command, _> = if buffered {
                    serde_json::from_value(serde_json::from_str::<serde_json::Value>(text).unwrap())
                } else {
                    serde_json::from_str(text)
                };
                match decoded {
                    Ok(Command::BrowserViewportSet { options, .. }) => {
                        assert_eq!((options.width, options.height), (1920.0, 1080.0));
                    }
                    Ok(Command::BrowserScreenshot { options, .. }) => {
                        let clip = options.clip.unwrap();
                        assert_eq!(
                            (clip.x, clip.y, clip.width, clip.height),
                            (10.5, 20.25, 300.75, 200.5)
                        );
                    }
                    Ok(Command::BrowserHistory { options, .. }) => {
                        assert_eq!(options.limit, Some(5.0));
                    }
                    Ok(_) => panic!("unexpected command"),
                    Err(error) => failures.push(format!("{text} (buffered={buffered}): {error}")),
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        let screenshot: Command = serde_json::from_str(
            r#"{"method":"browserScreenshot","handle":{"kind":"tab","id":"tab"},"options":{}}"#,
        )
        .unwrap();
        assert!(matches!(
            screenshot,
            Command::BrowserScreenshot {
                options: BrowserScreenshotOptions { clip: None, .. },
                ..
            }
        ));
        let history: Command = serde_json::from_str(
            r#"{"method":"browserHistory","browserId":"browser","options":{}}"#,
        )
        .unwrap();
        assert!(matches!(
            history,
            Command::BrowserHistory {
                options: BrowserHistoryOptions { limit: None, .. },
                ..
            }
        ));
    }
}
