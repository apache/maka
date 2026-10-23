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

//! Native selection owns paths and bytes; JavaScript observes only upload metadata.

use super::{EDITOR, Scope, ScopedHost, execute};
use maka_ui_runtime::{budget::Kind, file::read_selected};
use nsh_base::{Button, ButtonEvent, ButtonProps};
use nsh_core::{
    JsonValue,
    ui::{self, Arg, JsHost, JsIn, JsOwned, JsValue, PropError, Ret, TsTypes, prelude::*},
};
use std::{path::PathBuf, rc::Rc, sync::Arc};
use tokio::sync::{Mutex, mpsc, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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
            let operations = scope
                .owner
                .client
                .pending_uploads(&scope.session, EDITOR)
                .await?;
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
    pub selected_file_label: Prop<String>,
    #[prop(default)]
    pub visible: Prop<bool>,
    #[prop(default)]
    pub disabled: Prop<bool>,
}

#[derive(Clone, Debug, PartialEq, Event)]
pub(super) enum AttachmentPickerEvent {
    Status(JsonValue),
}

/// A native private-path input; only an actual press or Enter admits a file read.
/// Keep the component mounted per session; visible only controls its inner views.
#[component]
pub(super) fn AttachmentPicker(
    props: AttachmentPickerProps,
    cx: ui::Scope<AttachmentPickerEvent>,
) -> impl IntoElement {
    let path = signal(String::new());
    let busy = signal(false);
    let observer_owner = ui::Owner::current();
    let begin: Rc<dyn Fn()> = Rc::new(move || {
        if busy.get_untracked() || props.disabled.get_untracked() || !props.visible.get_untracked()
        {
            return;
        }
        let Some(client) = props.client.get_untracked() else {
            return;
        };
        let scope = client.0.with(|client| client.scope.clone());
        let selected = PathBuf::from(path.get_untracked());
        if selected.as_os_str().is_empty() {
            return;
        }
        let id = Uuid::new_v4();
        let name: String = selected
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .filter(|character| !character.is_control())
            .collect();
        let name = if name.is_empty() {
            props.selected_file_label.get_untracked()
        } else {
            name
        };
        busy.set(true);
        cx.emit(AttachmentPickerEvent::Status(status(
            id, "reading", &name, None,
        )));
        let (sender, mut receiver) = mpsc::channel(2);
        let owner = scope.owner.clone();
        let worker_name = name.clone();
        let admitted = owner.spawn(async move {
            let result = upload(scope, selected, id, &worker_name, &sender).await;
            let update = match result {
                Ok(()) => status(id, "complete", &worker_name, None),
                Err(error) => status(id, "failed", &worker_name, Some(&error)),
            };
            // Observation has no custody. A gone receiver never interrupts the upload.
            let _ = sender.try_send(update);
        });
        if let Err(error) = admitted {
            busy.set(false);
            cx.emit(AttachmentPickerEvent::Status(status(
                id,
                "failed",
                &name,
                Some(&error),
            )));
            return;
        }
        // Inner views may hide while IO continues. Observe under the component root.
        observer_owner.run(|| {
            ui::ambient::spawn(async move {
                while let Some(update) = receiver.recv().await {
                    if update["kind"] == "failed" || update["kind"] == "complete" {
                        busy.set(false);
                    }
                    cx.emit(AttachmentPickerEvent::Status(update));
                }
            });
        });
    });
    view().child(when(props.visible, move || {
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
                    .rounded_md(),
            )
            .child(
                Button::element(ButtonProps {
                    disabled: Prop::bind(move || {
                        busy.get() || props.disabled.get() || path.get().is_empty()
                    }),
                    accessibility_label: Prop::bind(move || Some(props.upload_label.get().into())),
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

async fn upload(
    scope: Arc<Scope>,
    path: PathBuf,
    id: Uuid,
    name: &str,
    sender: &mpsc::Sender<JsonValue>,
) -> Result<(), String> {
    let budget = scope.owner.budget.clone();
    let _job = budget
        .reserve(Kind::Job, 1)
        .map_err(|error| error.to_string())?;
    let snapshot = tokio::task::spawn_blocking(move || read_selected(&path, &budget))
        .await
        .map_err(|_| "Selected file worker failed")?
        .map_err(|error| error.to_string())?;
    let _ = sender.try_send(status(id, "uploading", name, None));
    let mutation = scope
        .owner
        .client
        .upload_attachment(id, &scope.session, EDITOR, snapshot)
        .await?;
    mutation.prepare().await?;
    mutation.confirm().await?;
    Ok(())
}
