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

use super::{ApplicationClient, Owner, execute, uploads};
use maka_capabilities::call::ReadResource;
use maka_ui_support::file::{FileSnapshot, FileSnapshotWriter};
use nsh_core::element::{Arg, JsHost, JsIn, JsOwned, JsValue, PropError, Ret, TsTypes};
use nsh_core::{JsonValue, prelude::*};
use std::{cell::Cell, io::Write, sync::Arc};
use tokio::sync::oneshot;

pub struct StagedSelection(pub Instance<uploads::StagedFile>);
impl JsValue for StagedSelection {
    fn ts_type(types: &mut TsTypes) -> String {
        <Instance<uploads::StagedFile> as Arg>::ts_type(types)
    }
    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        <Instance<uploads::StagedFile> as Arg>::from_js(value).map(Self)
    }
    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        <Instance<uploads::StagedFile> as Ret>::into_js(self.0.clone(), host)
    }
}

#[class]
pub struct ComposerSnapshot {
    owner: Arc<Owner>,
    client: maka_app_client::Client,
    revision: u64,
    previous: Cell<Option<oneshot::Receiver<Result<u64, String>>>>,
    value: JsonValue,
    files: Vec<Arc<FileSnapshot>>,
}

#[class]
impl ComposerSnapshot {
    pub fn value(&self) -> JsonValue {
        self.value.clone()
    }
    pub fn files(&self) -> Vec<Instance<uploads::StagedFile>> {
        self.files
            .iter()
            .cloned()
            .map(|file| uploads::staged_file(self.owner.clone(), file))
            .collect()
    }
    pub async fn save(
        this: Instance<Self>,
        value: JsonValue,
        files: Option<Vec<StagedSelection>>,
    ) -> Result<(), String> {
        let files = files.map(|files| {
            files
                .into_iter()
                .map(|file| file.0.with(|file| file.snapshot.clone()))
                .collect()
        });
        let (reply, next) = oneshot::channel();
        let (owner, client, revision, previous) = this.with(|state| {
            (
                state.owner.clone(),
                state.client.clone(),
                state.revision,
                state.previous.replace(Some(next)),
            )
        });
        drop(this);
        // Only admitted writes are native tasks. Closing the bindings drains
        // them without waiting for the JS window to dispose this handle.
        execute(owner, async move {
            let result = async {
                let revision = match previous {
                    Some(previous) => previous
                        .await
                        .map_err(|_| "Composer storage stopped before saving")??,
                    None => revision,
                };
                save(&client, revision, value, files).await
            }
            .await;
            let _ = reply.send(result.clone());
            result.map(|_| ())
        })
        .await
    }
}

pub(super) async fn load(
    owner: Arc<Owner>,
    source: ApplicationClient,
) -> Result<Instance<ComposerSnapshot>, String> {
    let original = owner.clone();
    let (client, revision, value, files) = execute(owner.clone(), async move {
        let client = source.local(&original).await?;
        let state = client.load_composer().await?;
        tokio::task::spawn_blocking(move || {
            let files = state
                .files
                .into_iter()
                .map(|file| {
                    let mut writer =
                        FileSnapshotWriter::new(&file.name).map_err(|e| e.to_string())?;
                    writer
                        .write_all(&file.contents)
                        .map_err(|e| e.to_string())?;
                    writer.finish().map_err(|e| e.to_string())
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok((client, state.revision, state.value, files))
        })
        .await
        .map_err(|e| e.to_string())?
    })
    .await?;
    Ok(Instance::new(ComposerSnapshot {
        owner,
        client,
        revision,
        previous: Cell::new(None),
        value,
        files,
    }))
}

async fn save(
    client: &maka_app_client::Client,
    revision: u64,
    value: JsonValue,
    files: Option<Vec<Arc<FileSnapshot>>>,
) -> Result<u64, String> {
    let files = if let Some(files) = files {
        Some(
            tokio::task::spawn_blocking(move || {
                files
                    .into_iter()
                    .map(|file| maka_app_client::ComposerFile {
                        name: file.metadata()["name"]
                            .as_str()
                            .expect("snapshot name")
                            .to_owned(),
                        contents: file.contents().to_vec(),
                    })
                    .collect()
            })
            .await
            .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    client.save_composer(revision, value, files).await
}
