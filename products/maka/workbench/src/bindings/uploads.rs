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

//! Native intake snapshots files and images; upload observations contain only metadata.

use super::{EDITOR, Owner, Scope, ScopedHost, execute};
use maka_agent_facts::attachment::sniff_mime;
use maka_app_client::Client;
use maka_capabilities::call::ReadResource;
use maka_ui_support::file::{FileSnapshot, read_selected};
use nsh_base::{Button, ButtonEvent, ButtonProps, input};
use nsh_core::prelude::*;
use nsh_core::{
    JsonValue,
    element::{self, Arg, JsHost, JsIn, JsOwned, JsValue, PropError, Ret, TsTypes},
    image::loader::MAX_BYTES,
};
use std::{rc::Rc, sync::Arc};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// An immutable local selection that has not been uploaded to a session yet.
#[class]
pub struct StagedFile {
    id: Uuid,
    owner: Arc<Owner>,
    snapshot: Arc<FileSnapshot>,
}

#[class]
pub struct StagedClipboard {
    owner: Arc<Owner>,
    text: Option<String>,
    files: Vec<Arc<FileSnapshot>>,
}

#[class]
impl StagedClipboard {
    #[getter]
    pub fn text(&self) -> Option<String> {
        self.text.clone()
    }

    pub fn files(&self) -> Vec<Instance<StagedFile>> {
        self.files
            .iter()
            .cloned()
            .map(|file| staged_file(self.owner.clone(), file))
            .collect()
    }
}

#[class]
impl StagedFile {
    #[getter]
    pub fn id(&self) -> String {
        self.id.to_string()
    }

    pub fn metadata(&self) -> JsonValue {
        self.snapshot.metadata()
    }

    /// Selects this snapshot's bytes for the renderer, so they stay out of the JS heap.
    pub fn image_uri(&self) -> Option<String> {
        has_preview(&self.snapshot).then(|| format!("{STAGED_IMAGE_PREFIX}{}", self.id))
    }
}

impl Drop for StagedFile {
    fn drop(&mut self) {
        self.owner
            .staged_images
            .lock()
            .expect("staged images")
            .remove(&self.id);
    }
}

pub(super) const STAGED_IMAGE_PREFIX: &str = "asset:/staged-image/";

/// Selection accepts any size, but reading a preview copies the whole snapshot.
fn has_preview(snapshot: &FileSnapshot) -> bool {
    let contents = snapshot.contents();
    contents.len() as u64 <= MAX_BYTES
        && sniff_mime(contents).is_some_and(|mime| mime.starts_with("image/"))
}

pub(super) fn staged_image(owner: &Owner, id: &str) -> Result<Vec<u8>, String> {
    let id = Uuid::parse_str(id).map_err(|_| "Invalid staged image selector")?;
    let snapshot = owner
        .staged_images
        .lock()
        .expect("staged images")
        .get(&id)
        .cloned()
        .ok_or("The staged image was removed")?;
    Ok(snapshot.contents().to_vec())
}

pub(super) async fn stage_files(
    owner: Arc<Owner>,
    files: Vec<String>,
    directory_text: bool,
) -> Result<StagedClipboard, String> {
    let (text, files) = execute(owner.clone(), async move {
        tokio::task::spawn_blocking(move || {
            if directory_text
                && let Some(text) = crate::attachment_paths::pasted_directories(&files)?
            {
                return Ok((Some(text), vec![]));
            }
            let snapshots = crate::attachment_paths::resolve(&files)?
                .into_iter()
                .map(|path| read_selected(&path).map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok((None, snapshots))
        })
        .await
        .map_err(|error| format!("Selected file worker failed: {error}"))?
    })
    .await?;
    Ok(StagedClipboard { owner, text, files })
}

pub(super) fn staged_file(owner: Arc<Owner>, snapshot: Arc<FileSnapshot>) -> Instance<StagedFile> {
    let id = Uuid::new_v4();
    if has_preview(&snapshot) {
        owner
            .staged_images
            .lock()
            .expect("staged images")
            .insert(id, snapshot.clone());
    }
    Instance::new(StagedFile {
        id,
        owner,
        snapshot,
    })
}

pub(super) async fn stage_clipboard(owner: Arc<Owner>) -> Result<StagedClipboard, String> {
    let selected = execute(owner.clone(), async move {
        tokio::task::spawn_blocking(crate::clipboard::read)
            .await
            .map_err(|error| format!("Clipboard worker failed: {error}"))?
    })
    .await?;
    match selected {
        crate::clipboard::Selection::Files(files) => stage_files(owner, files, true).await,
        crate::clipboard::Selection::Image(file) => Ok(StagedClipboard {
            owner,
            text: None,
            files: vec![file],
        }),
        crate::clipboard::Selection::Text(text) => {
            if let Some(files) = nsh_core::platform::clipboard::files_from_text(&text) {
                stage_files(owner, files, true).await
            } else {
                Ok(StagedClipboard {
                    owner,
                    text: Some(text),
                    files: vec![],
                })
            }
        }
        crate::clipboard::Selection::Empty => Ok(StagedClipboard {
            owner,
            text: None,
            files: vec![],
        }),
    }
}

/// A subscription to this Client's journal invalidations, not another Host call.
#[class]
pub struct UploadSubscription {
    scope: Arc<Scope>,
    updates: Arc<Mutex<UploadWatch>>,
    closed: CancellationToken,
}

struct UploadWatch {
    receiver: watch::Receiver<()>,
    initial: bool,
}

impl UploadSubscription {
    pub(super) fn new(scope: Arc<Scope>) -> Self {
        let receiver = scope.owner.client.watch_uploads();
        Self {
            scope,
            updates: Arc::new(Mutex::new(UploadWatch {
                receiver,
                initial: true,
            })),
            closed: CancellationToken::new(),
        }
    }
}

impl Drop for UploadSubscription {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

#[class]
impl UploadSubscription {
    /// Read the original journal initially and after each invalidation.
    pub async fn next(this: Instance<Self>) -> Result<JsonValue, String> {
        let (scope, updates, closed) = this.with(|watch| {
            (
                watch.scope.clone(),
                watch.updates.clone(),
                watch.closed.clone(),
            )
        });
        drop(this);
        // Waiting observes no native IO and owns no launcher task. An idle UI
        // subscription must not keep Bindings::close waiting for another upload.
        let mut updates = updates.lock().await;
        if !updates.initial {
            tokio::select! {
                biased;
                () = closed.cancelled() => return Ok(JsonValue::Null),
                changed = updates.receiver.changed() => {
                    if changed.is_err() { return Ok(JsonValue::Null); }
                }
            }
        }
        if closed.is_cancelled() {
            return Ok(JsonValue::Null);
        }
        updates.initial = false;
        // Mark before reading. A journal write during the query wakes the next call.
        updates.receiver.borrow_and_update();
        drop(updates);
        execute(scope.owner.clone(), async move {
            let client = scope.client.local(&scope.owner).await?;
            let operations = client.pending_uploads(&scope.session, EDITOR).await?;
            serde_json::to_value(operations).map_err(|error| error.to_string())
        })
        .await
    }

    /// Closing observation never cancels the original upload or waits for next().
    pub fn close(&self) {
        self.closed.cancel();
    }
}

/// Props carry the actual native instance, rather than an ID resolved in a table.
#[derive(Clone, Debug)]
pub(super) struct AttachmentScope(Instance<ScopedHost>);

impl PartialEq for AttachmentScope {
    fn eq(&self, other: &Self) -> bool {
        self.0.ptr_eq(&other.0)
    }
}

impl JsValue for AttachmentScope {
    fn ts_type(types: &mut TsTypes) -> String {
        <Instance<ScopedHost> as Arg>::ts_type(types)
    }
    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        <Instance<ScopedHost> as Arg>::from_js(value).map(Self)
    }
    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        <Instance<ScopedHost> as Ret>::into_js(self.0.clone(), host)
    }
}

#[derive(Clone, Debug, PartialEq, Props)]
pub(super) struct AttachmentPickerProps {
    pub client: Prop<Option<AttachmentScope>>,
    pub path_label: Prop<String>,
    pub path_placeholder: Prop<String>,
    pub upload_label: Prop<String>,
    pub uploading_label: Prop<String>,
    pub text_style: Prop<element::TextPartStyle>,
    pub border_color: Prop<Hsla>,
    #[prop(default)]
    pub visible: Prop<bool>,
    #[prop(default)]
    pub disabled: Prop<bool>,
}

#[derive(Clone, Debug, PartialEq, Event)]
pub(super) enum AttachmentPickerEvent {
    #[args(event)]
    Status(JsonValue),
}

/// A native private-path input; only an actual press or Enter admits a file read.
/// Keep the component mounted per session; visible only controls its inner views.
#[component]
pub(super) fn AttachmentPicker(
    props: AttachmentPickerProps,
    cx: element::Scope<AttachmentPickerEvent>,
) -> impl IntoElement {
    let path = signal(String::new());
    let busy = signal(false);
    let observer_owner = element::Owner::current();
    let begin: Rc<dyn Fn()> = Rc::new(move || {
        if busy.get_untracked() || props.disabled.get_untracked() || !props.visible.get_untracked()
        {
            return;
        }
        let Some(client) = props.client.get_untracked() else {
            return;
        };
        let scope = client.0.with(|client| client.scope.clone());
        let selected = path.get_untracked();
        let selected = selected.trim();
        if selected.is_empty() {
            return;
        }
        let files = nsh_core::platform::clipboard::files_from_text(selected)
            .unwrap_or_else(|| vec![selected.to_owned()]);
        busy.set(true);
        let intake = UploadIntake::begin(scope, Selection::Files(files));
        // Inner views may hide while IO continues. Observe under the component root.
        observer_owner.run(|| {
            element::spawn(async move {
                while let Some(update) = intake.next_update().await {
                    cx.emit(AttachmentPickerEvent::Status(update));
                }
                busy.set(false);
            });
        });
    });
    view()
        .inline_style(move || element::Style::from(props.text_style.get()))
        .child(when(props.visible, move || {
            let submit = begin.clone();
            let click = begin.clone();
            view()
                .gap(px(8.0))
                .child(text(move || props.path_label.get()))
                .child(
                    input()
                        .value(path)
                        .placeholder(move || props.path_placeholder.get())
                        .label(move || props.path_label.get())
                        .auto_focus(true)
                        .readonly(move || busy.get() || props.disabled.get())
                        .on_change(move |value: &str| path.set(value.to_owned()))
                        .on_submit(move |value: &str| {
                            path.set(value.to_owned());
                            submit();
                        })
                        .h(px(32.0))
                        .px_2()
                        .border_1()
                        .border_color(move || AdaptiveColor::from(props.border_color.get()))
                        .rounded_md(),
                )
                .child(
                    Button::element(ButtonProps {
                        disabled: Prop::bind(move || {
                            busy.get() || props.disabled.get() || path.get().is_empty()
                        }),
                        accessibility_label: Prop::bind(move || {
                            Some(props.upload_label.get().into())
                        }),
                        ..Default::default()
                    })
                    .on_event(move |event: &ButtonEvent| {
                        if matches!(event, ButtonEvent::Press) {
                            click();
                        }
                    })
                    .child(text(move || {
                        if busy.get() {
                            props.uploading_label.get()
                        } else {
                            props.upload_label.get()
                        }
                    }))
                    .px_3()
                    .py_2()
                    .border_1()
                    .border_color(move || AdaptiveColor::from(props.border_color.get()))
                    .rounded_md(),
                )
        }))
}

fn status(id: Uuid, kind: &str, name: &str, error: Option<&str>) -> JsonValue {
    let mut value = serde_json::json!({"operationId": id, "kind": kind, "name": name});
    if let Some(error) = error {
        value["error"] = error.into();
    }
    value
}

#[class]
pub struct UploadIntake {
    updates: Arc<Mutex<mpsc::UnboundedReceiver<JsonValue>>>,
    closed: CancellationToken,
}

#[derive(Clone)]
struct Updates {
    sender: mpsc::UnboundedSender<JsonValue>,
    closed: CancellationToken,
}
impl Updates {
    fn emit(&self, value: JsonValue) {
        if !self.closed.is_cancelled() {
            let _ = self.sender.send(value);
        }
    }
}

enum Selection {
    Files(Vec<String>),
    Paste(Vec<String>),
    Clipboard,
}

impl UploadIntake {
    pub(super) fn staged(scope: Arc<Scope>, file: Instance<StagedFile>) -> Result<Self, String> {
        let snapshot = file
            .with(|file| Arc::ptr_eq(&file.owner, &scope.owner).then(|| file.snapshot.clone()))
            .ok_or("Selected file belongs to a different client")?;
        let (sender, receiver) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let updates = Updates {
            sender,
            closed: closed.clone(),
        };
        let failed = updates.clone();
        let id = Uuid::new_v4();
        let name = snapshot.metadata()["name"]
            .as_str()
            .map(clean_name)
            .unwrap_or_else(|| "Selected file".into());
        let worker_name = name.clone();
        let owner = scope.owner.clone();
        let admitted = owner.spawn(async move {
            match scope.client.local(&scope.owner).await {
                Ok(client) => settle(scope, client, snapshot, id, &worker_name, &updates).await,
                Err(error) => updates.emit(status(id, "failed", &worker_name, Some(&error))),
            }
        });
        if let Err(error) = admitted {
            failed.emit(status(id, "failed", &name, Some(&error)));
        }
        Ok(Self {
            updates: Arc::new(Mutex::new(receiver)),
            closed,
        })
    }
    pub(super) fn files(scope: Arc<Scope>, files: Vec<String>) -> Self {
        Self::begin(scope, Selection::Paste(files))
    }
    pub(super) fn clipboard(scope: Arc<Scope>) -> Self {
        Self::begin(scope, Selection::Clipboard)
    }
    fn begin(scope: Arc<Scope>, selection: Selection) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let updates = Updates {
            sender,
            closed: closed.clone(),
        };
        let failed = updates.clone();
        let id = Uuid::new_v4();
        let is_clipboard = matches!(&selection, Selection::Clipboard);
        let name = match &selection {
            Selection::Files(files) | Selection::Paste(files) => files
                .first()
                .map(|path| display_name(path))
                .unwrap_or_else(|| "Selected file".into()),
            Selection::Clipboard => "Clipboard".into(),
        };
        let worker_name = name.clone();
        let owner = scope.owner.clone();
        let admitted = owner.spawn(async move {
            if let Err(error) = intake(scope, selection, &updates, id).await {
                updates.emit(if is_clipboard {
                    serde_json::json!({"kind": "notice", "error": error})
                } else {
                    status(id, "failed", &worker_name, Some(&error))
                });
            }
        });
        if let Err(error) = admitted {
            failed.emit(if is_clipboard {
                serde_json::json!({"kind": "notice", "error": error})
            } else {
                status(id, "failed", &name, Some(&error))
            });
        }
        Self {
            updates: Arc::new(Mutex::new(receiver)),
            closed,
        }
    }
    async fn next_update(&self) -> Option<JsonValue> {
        next_update(self.updates.clone(), self.closed.clone()).await
    }
}
impl Drop for UploadIntake {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}
#[class]
impl UploadIntake {
    /// Observe metadata for the already admitted original selection and upload.
    pub async fn next(this: Instance<Self>) -> Result<JsonValue, String> {
        let (updates, closed) = this.with(|intake| (intake.updates.clone(), intake.closed.clone()));
        drop(this);
        Ok(next_update(updates, closed)
            .await
            .unwrap_or(JsonValue::Null))
    }
    /// End observation. The original owner continues reading and settling uploads.
    pub fn close(&self) {
        self.closed.cancel();
    }
}
async fn next_update(
    updates: Arc<Mutex<mpsc::UnboundedReceiver<JsonValue>>>,
    closed: CancellationToken,
) -> Option<JsonValue> {
    let mut updates = tokio::select! {
        biased;
        () = closed.cancelled() => return None,
        updates = updates.lock() => updates,
    };
    tokio::select! {
        biased;
        () = closed.cancelled() => None,
        update = updates.recv() => update,
    }
}

async fn intake(
    scope: Arc<Scope>,
    selection: Selection,
    updates: &Updates,
    clipboard_id: Uuid,
) -> Result<(), String> {
    let client = scope.client.local(&scope.owner).await?;
    let directory_text = !matches!(&selection, Selection::Files(_));
    let selected = match selection {
        Selection::Files(files) | Selection::Paste(files) => {
            crate::clipboard::Selection::Files(files)
        }
        Selection::Clipboard => {
            tokio::task::spawn_blocking(move || -> Result<crate::clipboard::Selection, String> {
                match crate::clipboard::read()? {
                    crate::clipboard::Selection::Text(text) => Ok(
                        match nsh_core::platform::clipboard::files_from_text(&text) {
                            Some(files) => crate::clipboard::Selection::Files(files),
                            None => crate::clipboard::Selection::Text(text),
                        },
                    ),
                    selected => Ok(selected),
                }
            })
            .await
            .map_err(|error| format!("Clipboard worker failed: {error}"))??
        }
    };
    match selected {
        crate::clipboard::Selection::Files(files) => {
            if directory_text {
                let (text, files) = tokio::task::spawn_blocking(move || {
                    crate::attachment_paths::pasted_directories(&files).map(|text| (text, files))
                })
                .await
                .map_err(|error| format!("Selected path worker failed: {error}"))??;
                if let Some(text) = text {
                    updates.emit(serde_json::json!({"kind": "text", "text": text}));
                    return Ok(());
                }
                upload_files(scope, client, files, updates).await;
            } else {
                upload_files(scope, client, files, updates).await;
            }
        }
        crate::clipboard::Selection::Image(snapshot) => {
            let name = snapshot.metadata()["name"]
                .as_str()
                .map(clean_name)
                .unwrap_or_else(|| "Clipboard image".into());
            updates.emit(status(clipboard_id, "reading", &name, None));
            settle(scope, client, snapshot, clipboard_id, &name, updates).await;
        }
        crate::clipboard::Selection::Text(text) => {
            updates.emit(serde_json::json!({"kind": "text", "text": text}));
        }
        crate::clipboard::Selection::Empty => {}
    }
    Ok(())
}

async fn upload_files(scope: Arc<Scope>, client: Client, files: Vec<String>, updates: &Updates) {
    for selected in files {
        let id = Uuid::new_v4();
        let name = display_name(&selected);
        updates.emit(status(id, "reading", &name, None));
        let captured = tokio::task::spawn_blocking(move || {
            let paths = crate::attachment_paths::resolve(&[selected])?;
            let path = paths
                .into_iter()
                .next()
                .ok_or("Selected file is unavailable")?;
            read_selected(&path).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("Selected file worker failed: {error}"))
        .and_then(|result| result);
        match captured {
            Ok(snapshot) => {
                let name = snapshot.metadata()["name"]
                    .as_str()
                    .map(clean_name)
                    .unwrap_or(name);
                settle(scope.clone(), client.clone(), snapshot, id, &name, updates).await;
            }
            Err(error) => updates.emit(status(id, "failed", &name, Some(&error))),
        }
    }
}

async fn settle(
    scope: Arc<Scope>,
    client: Client,
    snapshot: Arc<FileSnapshot>,
    id: Uuid,
    name: &str,
    updates: &Updates,
) {
    let result = upload(scope, client, snapshot, id, name, updates).await;
    match result {
        Ok(()) => updates.emit(status(id, "complete", name, None)),
        Err(error) => updates.emit(status(id, "failed", name, Some(&error))),
    }
}
async fn upload(
    scope: Arc<Scope>,
    client: Client,
    snapshot: Arc<FileSnapshot>,
    id: Uuid,
    name: &str,
    updates: &Updates,
) -> Result<(), String> {
    updates.emit(status(id, "uploading", name, None));
    let mutation = client
        .upload_attachment(id, &scope.session, EDITOR, snapshot)
        .await?;
    mutation.prepare().await?;
    mutation.confirm().await?;
    Ok(())
}
fn display_name(path: &str) -> String {
    if let Ok(uri) = url::Url::parse(path)
        && uri.scheme() == "file"
    {
        let name = uri.path().rsplit('/').next().unwrap_or_default();
        return clean_name(&percent_encoding::percent_decode_str(name).decode_utf8_lossy());
    }
    let bytes = path.as_bytes();
    if path.starts_with("\\\\")
        || bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    {
        return clean_name(path.rsplit(['/', '\\']).next().unwrap_or_default());
    }
    std::path::Path::new(path)
        .file_name()
        .map(|name| clean_name(&name.to_string_lossy()))
        .unwrap_or_else(|| "Selected file".into())
}
fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|ch| !ch.is_control()).collect();
    if name.is_empty() {
        "Selected file".into()
    } else {
        name
    }
}
