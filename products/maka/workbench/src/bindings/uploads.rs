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
use image::{ImageFormat, codecs::png::PngEncoder};
use maka_agent_facts::attachment::sniff_mime;
use maka_app_client::Client;
use maka_capabilities::call::ReadResource;
use maka_ui_support::file::{FileSnapshot, FileSnapshotWriter, read_selected};
use nsh_base::{Button, ButtonEvent, ButtonProps, input, rich_editor::view::RichEditorFile};
use nsh_core::prelude::*;
use nsh_core::{
    JsonValue,
    element::{self, Arg, JsHost, JsIn, JsOwned, JsValue, PropError, Ret, TsTypes},
    image::loader::MAX_BYTES,
};
use std::{io::Write, rc::Rc, sync::Arc};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Native boundary decoder for `@maka-agent/plugin-sdk` `ComposerIntake`.
pub enum IntakeInput {
    Clipboard,
    Paste {
        uris: Vec<String>,
        files: Vec<RichEditorFile>,
    },
    Files {
        paths: Vec<String>,
    },
}

#[derive(PropEnum)]
enum IntakeKind {
    Clipboard,
    Paste,
    Files,
}

impl Arg for IntakeInput {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("ComposerIntake", |types| {
            let file = <RichEditorFile as JsValue>::ts_type(types);
            format!(
                "export type ComposerIntake = {{ kind: 'clipboard' }} | \
                 {{ kind: 'paste'; uris: string[]; files: {file}[] }} | \
                 {{ kind: 'files'; paths: string[] }};"
            )
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        let kind = value.field("kind")?;
        let kind = <IntakeKind as JsValue>::from_js(kind.get())?;
        let fields: &[&str] = match kind {
            IntakeKind::Clipboard => &["kind"],
            IntakeKind::Paste => &["kind", "uris", "files"],
            IntakeKind::Files => &["kind", "paths"],
        };
        for key in value.keys()? {
            if !fields.contains(&key.as_str()) {
                return Err(PropError(format!("unknown field `{key}`")));
            }
        }
        match kind {
            IntakeKind::Clipboard => Ok(Self::Clipboard),
            IntakeKind::Paste => Ok(Self::Paste {
                uris: <Vec<String> as JsValue>::from_js(value.field("uris")?.get())?,
                files: <Vec<RichEditorFile> as JsValue>::from_js(value.field("files")?.get())?,
            }),
            IntakeKind::Files => Ok(Self::Files {
                paths: <Vec<String> as JsValue>::from_js(value.field("paths")?.get())?,
            }),
        }
    }
}

/// An immutable local selection that has not been uploaded to a session yet.
#[class]
pub struct StagedFile {
    id: Uuid,
    owner: Arc<Owner>,
    snapshot: Arc<FileSnapshot>,
}

/// Captured pre-session intake: either inserted path text or immutable staged files.
pub type StagedIntake = Selection<Instance<StagedFile>>;

impl Ret for StagedIntake {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("StagedIntake", |types| {
            let files = <Vec<Instance<StagedFile>> as Ret>::ts_type(types);
            format!(
                "export type StagedIntake = {{ kind: 'text'; text: string }} | \
                 {{ kind: 'files'; files: {files} }};"
            )
        })
    }

    fn into_js<'a>(self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let owned = JsOwned::new(host, host.new_object()?);
        let object = owned.get().raw();
        match self {
            Self::Text(text) => {
                host.set_field(object, "kind", host.new_string("text")?)?;
                host.set_field(object, "text", host.new_string(&text)?)?;
            }
            Self::Files(files) => {
                host.set_field(object, "kind", host.new_string("files")?)?;
                host.set_field(object, "files", files.into_js(host)?.into_raw())?;
            }
        }
        Ok(owned)
    }

    fn classes(out: &mut Vec<&'static element::ClassDef>) {
        <Vec<Instance<StagedFile>> as Ret>::classes(out);
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

pub(super) async fn stage_intake(
    owner: Arc<Owner>,
    input: IntakeInput,
) -> Result<StagedIntake, String> {
    let selection = execute(owner.clone(), async move {
        tokio::task::spawn_blocking(move || stage_selection(input))
            .await
            .map_err(|error| format!("Selected file worker failed: {error}"))?
    })
    .await?;
    Ok(match selection {
        Selection::Text(text) => Selection::Text(text),
        Selection::Files(files) => Selection::Files(
            files
                .into_iter()
                .map(|file| staged_file(owner.clone(), file))
                .collect(),
        ),
    })
}

fn stage_selection(input: IntakeInput) -> Result<Selection<Arc<FileSnapshot>>, String> {
    match select(input)? {
        Selection::Text(text) => Ok(Selection::Text(text)),
        Selection::Files(files) => files
            .into_iter()
            .map(SelectedFile::capture)
            .collect::<Result<Vec<_>, _>>()
            .map(Selection::Files),
    }
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
        let intake = UploadIntake::begin(scope, IntakeInput::Files { paths: files });
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

pub enum Selection<T> {
    Text(String),
    Files(Vec<T>),
}

enum SelectedFile {
    Path(String),
    Bytes(RichEditorFile),
    Snapshot(Arc<FileSnapshot>),
}

impl SelectedFile {
    fn name(&self) -> String {
        match self {
            Self::Path(path) => display_name(path),
            Self::Bytes(file) => clean_name(&file.name),
            Self::Snapshot(snapshot) => snapshot.metadata()["name"]
                .as_str()
                .map(clean_name)
                .expect("snapshot name"),
        }
    }

    /// Called only on an admitted blocking worker.
    fn capture(self) -> Result<Arc<FileSnapshot>, String> {
        match self {
            Self::Path(selected) => {
                let path = crate::attachment_paths::resolve(&[selected])?
                    .into_iter()
                    .next()
                    .expect("one selected path");
                read_selected(&path).map_err(|error| error.to_string())
            }
            Self::Bytes(file) => {
                let mut name = clean_name(&file.name);
                let bitmap = file.mime == "image/bmp";
                if bitmap {
                    let stem = name
                        .rsplit_once('.')
                        .map_or(name.as_str(), |(stem, _)| stem);
                    name = format!("{stem}.png");
                }
                let mut writer = FileSnapshotWriter::new(&name)
                    .map_err(|error| format!("Capture pasted file: {error}"))?;
                if bitmap {
                    image::load_from_memory_with_format(&file.data, ImageFormat::Bmp)
                        .map_err(|error| format!("Decode pasted bitmap: {error}"))?
                        .write_with_encoder(PngEncoder::new(&mut writer))
                        .map_err(|error| format!("Encode pasted bitmap: {error}"))?;
                } else {
                    writer
                        .write_all(&file.data)
                        .map_err(|error| format!("Capture pasted file: {error}"))?;
                }
                writer
                    .finish()
                    .map_err(|error| format!("Capture pasted file: {error}"))
            }
            Self::Snapshot(snapshot) => Ok(snapshot),
        }
    }
}

/// Interpret the source once, before either staging or uploading its files.
/// All path checks and system clipboard reads run on a blocking worker.
fn select(input: IntakeInput) -> Result<Selection<SelectedFile>, String> {
    let pasted_paths = |paths: Vec<String>| {
        if let Some(text) = crate::attachment_paths::pasted_directories(&paths)? {
            Ok(Selection::Text(text))
        } else {
            Ok(Selection::Files(
                paths.into_iter().map(SelectedFile::Path).collect(),
            ))
        }
    };
    match input {
        IntakeInput::Files { paths } => Ok(Selection::Files(
            paths.into_iter().map(SelectedFile::Path).collect(),
        )),
        IntakeInput::Paste { uris, files } => {
            if uris.is_empty() {
                Ok(Selection::Files(
                    files.into_iter().map(SelectedFile::Bytes).collect(),
                ))
            } else if files.is_empty() {
                pasted_paths(uris)
            } else if let Some(text) = crate::attachment_paths::pasted_directories(&uris)? {
                Ok(Selection::Text(text))
            } else {
                Ok(Selection::Files(
                    uris.into_iter()
                        .map(SelectedFile::Path)
                        .chain(files.into_iter().map(SelectedFile::Bytes))
                        .collect(),
                ))
            }
        }
        IntakeInput::Clipboard => match crate::clipboard::read()? {
            crate::clipboard::Selection::Files(paths) => pasted_paths(paths),
            crate::clipboard::Selection::Image(snapshot) => {
                Ok(Selection::Files(vec![SelectedFile::Snapshot(snapshot)]))
            }
            crate::clipboard::Selection::Text(text) => {
                if let Some(paths) = nsh_core::platform::clipboard::files_from_text(&text) {
                    pasted_paths(paths)
                } else {
                    Ok(Selection::Text(text))
                }
            }
            crate::clipboard::Selection::Empty => Ok(Selection::Files(vec![])),
        },
    }
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
    pub(super) fn begin(scope: Arc<Scope>, input: IntakeInput) -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let updates = Updates {
            sender,
            closed: closed.clone(),
        };
        let failed = updates.clone();
        let id = Uuid::new_v4();
        let is_clipboard = matches!(&input, IntakeInput::Clipboard);
        let name = match &input {
            IntakeInput::Files { paths } => paths.first().map(|path| display_name(path)),
            IntakeInput::Paste { uris, files } => uris
                .first()
                .map(|path| display_name(path))
                .or_else(|| files.first().map(|file| clean_name(&file.name))),
            IntakeInput::Clipboard => Some("Clipboard".into()),
        }
        .unwrap_or_else(|| "Selected file".into());
        let worker_name = name.clone();
        let owner = scope.owner.clone();
        let admitted = owner.spawn(async move {
            if let Err(error) = intake(scope, input, &updates).await {
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

async fn intake(scope: Arc<Scope>, input: IntakeInput, updates: &Updates) -> Result<(), String> {
    let client = scope.client.local(&scope.owner).await?;
    let selected = tokio::task::spawn_blocking(move || select(input))
        .await
        .map_err(|error| format!("Attachment input worker failed: {error}"))??;
    match selected {
        Selection::Text(text) => {
            updates.emit(serde_json::json!({"kind": "text", "text": text}));
        }
        Selection::Files(files) => upload_files(scope, client, files, updates).await,
    }
    Ok(())
}

async fn upload_files(
    scope: Arc<Scope>,
    client: Client,
    files: Vec<SelectedFile>,
    updates: &Updates,
) {
    for selected in files {
        let id = Uuid::new_v4();
        let name = selected.name();
        updates.emit(status(id, "reading", &name, None));
        let captured = tokio::task::spawn_blocking(move || selected.capture())
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
        let name = uri
            .path()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default();
        return clean_name(&percent_encoding::percent_decode_str(name).decode_utf8_lossy());
    }
    let bytes = path.as_bytes();
    if let Some(unc) = path.strip_prefix("\\\\") {
        let mut parts = unc
            .trim_end_matches(['/', '\\'])
            .split(['/', '\\'])
            .filter(|part| !part.is_empty());
        let _ = (parts.next(), parts.next());
        return clean_name(parts.next_back().unwrap_or_default());
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return clean_name(
            path[2..]
                .trim_end_matches(['/', '\\'])
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or_default(),
        );
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

#[cfg(test)]
mod tests {
    use super::{IntakeInput, Selection, display_name, stage_selection};
    use maka_capabilities::call::ReadResource;
    use nsh_base::rich_editor::view::RichEditorFile;

    #[test]
    fn staging_preserves_directory_text_and_pasted_file_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let paths = vec![directory.path().to_string_lossy().into_owned()];
        let Selection::Text(text) = stage_selection(IntakeInput::Paste {
            uris: paths.clone(),
            files: vec![],
        })
        .unwrap() else {
            panic!("a pasted directory must remain text");
        };
        assert_eq!(text, paths[0]);

        let bytes = b"\x89PNG\r\n\x1a\n\0\xff";
        let mut file = RichEditorFile::default();
        file.name = "截图.png".into();
        file.mime = "image/png".into();
        file.data = bytes.to_vec();
        let Selection::Files(files) = stage_selection(IntakeInput::Paste {
            uris: vec![],
            files: vec![file],
        })
        .unwrap() else {
            panic!("a pasted image must produce file snapshots");
        };
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].metadata()["name"], "截图.png");
        assert_eq!(files[0].contents(), bytes);

        let local = directory.path().join("note.txt");
        std::fs::write(&local, b"note").unwrap();
        let mut fallback = RichEditorFile::default();
        fallback.name = "image.png".into();
        fallback.mime = "image/png".into();
        fallback.data = bytes.to_vec();
        let Selection::Files(mixed) = stage_selection(IntakeInput::Paste {
            uris: vec![local.to_string_lossy().into_owned()],
            files: vec![fallback],
        })
        .unwrap() else {
            panic!("a mixed paste must preserve both file paths and inline images");
        };
        assert_eq!(mixed.len(), 2);
        assert_eq!(mixed[0].metadata()["name"], "note.txt");
        assert_eq!(mixed[1].metadata()["name"], "image.png");
    }

    #[test]
    fn pasted_windows_bitmap_stages_as_previewable_png() {
        // One red pixel, with the file header that Windows paste adds to CF_DIB.
        let bmp = [
            0x42, 0x4d, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, // BMP header
            40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0, // DIB header
            0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255,
            0, // BGR pixel and row padding
        ];
        let mut file = RichEditorFile::default();
        file.name = "image.bmp".into();
        file.mime = "image/bmp".into();
        file.data = bmp.to_vec();
        let Selection::Files(files) = stage_selection(IntakeInput::Paste {
            uris: vec![],
            files: vec![file],
        })
        .unwrap() else {
            panic!("a pasted bitmap must produce a file snapshot");
        };
        let [snapshot] = files.as_slice() else {
            panic!("expected one pasted image");
        };
        assert!(super::has_preview(snapshot));
        assert_eq!(snapshot.metadata()["name"], "image.png");
        let image =
            image::load_from_memory_with_format(snapshot.contents(), image::ImageFormat::Png)
                .unwrap()
                .into_rgb8();
        assert_eq!(image.dimensions(), (1, 1));
        assert_eq!(image.into_raw(), [255, 0, 0]);
    }

    #[test]
    fn display_name_ignores_trailing_directory_separators() {
        assert_eq!(
            display_name("file:///private/var/folders/tmp/%E6%9C%AA%E5%91%BD%E5%90%8D%202/"),
            "未命名 2"
        );
        assert_eq!(display_name(r"C:\Users\alice\folder\"), "folder");
        assert_eq!(display_name(r"\\server\share\folder\"), "folder");
        assert_eq!(display_name("file:///"), "Selected file");
        assert_eq!(display_name(r"C:\"), "Selected file");
        assert_eq!(display_name(r"\\server\share\"), "Selected file");
    }
}
