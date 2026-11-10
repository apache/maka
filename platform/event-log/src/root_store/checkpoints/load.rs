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

//! Load receipts pin opaque immutable material; they never create a Session.
use super::*;
use crate::checkpoints::{LoadOperation, LoadRequest, LoadState, LoadedCheckpoint, load_key};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use uuid::Uuid;

impl HistoryCheckpoints {
    fn load_request(&self, load: LoadOperation) -> Result<LoadRequest, StoreError> {
        let request = LoadRequest {
            scope: self.scope.clone(),
            session_id: self.session.id().into(),
            load,
        };
        request.validate()?;
        Ok(request)
    }

    pub async fn load_exact(&self, load: LoadOperation) -> Result<LoadedCheckpoint, StoreError> {
        let request = self.load_request(load)?;
        let log = self.session.scoped().await?;
        let gates = self.session.gates.clone();
        read_worker(log, gates.clone(), move |log, objects| async move {
            let _pin = gates
                .write([gates::Key::CheckpointLoad(request.key()?)])
                .await?;
            if let Some((prior, loaded)) = read(&log, request.key()?).await? {
                if prior != request {
                    return Err(invalid("checkpoint load identity conflict"));
                }
                return Ok(loaded);
            }
            let (head, manifest) = selected_checkpoint(
                &log,
                &objects,
                &request.scope,
                &request.session_id,
                request.load.revision,
            )
            .await?;
            objects.read(&manifest.history.object)?;
            claim(&log, request, head, manifest).await
        })
        .await
    }

    pub async fn load_receipt(
        &self,
        load: LoadOperation,
    ) -> Result<Option<LoadedCheckpoint>, StoreError> {
        let request = self.load_request(load)?;
        read(&self.session.scoped().await?, request.key()?)
            .await?
            .map(|(prior, loaded)| {
                if prior != request {
                    return Err(invalid("checkpoint load identity conflict"));
                }
                Ok(loaded)
            })
            .transpose()
    }

    /// Read the original load receipt without reopening its immutable files.
    pub async fn loaded_checkpoint(&self, operation: Uuid) -> Result<LoadedCheckpoint, StoreError> {
        let key = load_key(&self.scope, self.session.id(), operation)?;
        let (request, loaded) = read(&self.session.scoped().await?, key.clone())
            .await?
            .ok_or_else(|| invalid("checkpoint load receipt missing"))?;
        request.validate()?;
        if request.scope != self.scope
            || request.session_id != self.session.id()
            || request.load.operation != operation
            || request.key()? != key
            || loaded.head.revision != request.load.revision
        {
            return Err(invalid("checkpoint load origin differs"));
        }
        Ok(loaded)
    }

    /// Read the original loaded bytes even after the live checkpoint Head moves.
    /// Only the canonical history owner may decode or statically import them.
    pub async fn loaded_snapshot(&self, operation: Uuid) -> Result<Checkout, StoreError> {
        let key = load_key(&self.scope, self.session.id(), operation)?;
        let scope = self.scope.clone();
        let session = self.session.id().to_owned();
        read_worker(
            self.session.scoped().await?,
            self.session.gates.clone(),
            move |log, objects| async move {
                let (request, loaded) = read(&log, key)
                    .await?
                    .ok_or_else(|| invalid("checkpoint load receipt missing"))?;
                if request.scope != scope || request.session_id != session {
                    return Err(invalid("checkpoint load origin differs"));
                }
                let LoadState::Ready { history, workspace } = &loaded.state else {
                    return Err(invalid("checkpoint is not ready"));
                };
                let manifest = objects.manifest(&loaded.head.manifest)?;
                if manifest.root_id != objects.root_id()
                    || manifest.scope != scope
                    || manifest.session_id != session
                    || &manifest.history != history
                    || &manifest.workspace != workspace
                {
                    return Err(invalid("checkpoint load manifest differs"));
                }
                if let Some(workspace) = manifest.workspace() {
                    workspace::verify(&objects, workspace)?;
                }
                let snapshot = objects.read(&manifest.history.object)?;
                Ok(Checkout {
                    head: loaded.head,
                    manifest,
                    snapshot,
                })
            },
        )
        .await
    }
}

async fn read(
    log: &EventLog,
    key: String,
) -> Result<Option<(LoadRequest, LoadedCheckpoint)>, StoreError> {
    log.connection
        .read(move |db| {
            let row: Option<(String, String)> = db.query_row(
            "SELECT request_json,result_json FROM history_checkpoint_loads WHERE load_key=?",
            rusqlite::params![key], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
            row.map(|(request, result)| {
                Ok((
                    serde_json::from_str(&request)?,
                    serde_json::from_str(&result)?,
                ))
            })
            .transpose()
        })
        .await
}

async fn claim(
    log: &EventLog,
    request: LoadRequest,
    head: Head,
    manifest: Manifest,
) -> Result<LoadedCheckpoint, StoreError> {
    log.connection
        .run(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let current: Option<String> = tx
                .query_row(
                    "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
                    rusqlite::params![&request.session_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current
                .as_deref()
                .map(serde_json::from_str::<Head>)
                .transpose()?
                .as_ref()
                != Some(&head)
            {
                return Err(invalid("history checkpoint revision unavailable"));
            }
            let value = LoadedCheckpoint {
                head,
                state: LoadState::Ready {
                    history: manifest.history,
                    workspace: manifest.workspace,
                },
            };
            tx.execute(
                "INSERT INTO history_checkpoint_loads VALUES(?,?,?)",
                rusqlite::params![
                    request.key()?,
                    serde_json::to_string(&request)?,
                    serde_json::to_string(&value)?,
                ],
            )?;
            tx.commit().map_err(StoreError::CommitUnknown)?;
            Ok(value)
        })
        .await
}
