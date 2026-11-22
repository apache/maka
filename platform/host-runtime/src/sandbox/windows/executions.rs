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

use super::store;
use maka_sandbox::windows::ensure_drained;
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    id: Uuid,
    account: String,
}

fn name(id: Uuid) -> String {
    format!("execution-{id}.json")
}

/// The installation's shared admission lease must cover publication through
/// native Job creation. Exclusive recovery cannot mistake an unstarted intent
/// for an abandoned execution while that lease is held.
pub(super) fn begin(root: &Path, account: &str) -> io::Result<Uuid> {
    let id = Uuid::new_v4();
    let intent = Intent {
        id,
        account: account.into(),
    };
    store::publish(root, &name(id), &intent)?;
    Ok(id)
}

pub(super) fn list(root: &Path) -> io::Result<Vec<Uuid>> {
    let mut ids = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let filename = entry.file_name();
        let Some(filename) = filename.to_str() else {
            continue;
        };
        let Some(id) = filename
            .strip_prefix("execution-")
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        let id: Uuid = id.parse().map_err(io::Error::other)?;
        if filename != name(id) {
            return Err(io::Error::other("noncanonical sandbox execution intent"));
        }
        let intent: Intent = store::required(&entry.path())?;
        if intent.id != id {
            return Err(io::Error::other("sandbox execution identity mismatch"));
        }
        ids.push(id);
    }
    ids.sort_unstable();
    Ok(ids)
}

pub(super) fn settle(root: &Path, id: Uuid) -> io::Result<()> {
    let path = root.join(name(id));
    if let Some(intent) = store::read::<Intent>(&path)? {
        if intent.id != id {
            return Err(io::Error::other("sandbox execution identity mismatch"));
        }
        ensure_drained(id)?;
        store::remove(&path)?;
    }
    Ok(())
}

/// Called only with exclusive installation admission. Live process trees keep
/// their intent and account-level network isolation until settlement is known.
pub(super) fn recover(root: &Path) -> io::Result<()> {
    for id in list(root)? {
        settle(root, id)?;
    }
    Ok(())
}

pub(super) fn settle_account(root: &Path, account: &str) -> io::Result<()> {
    for id in list(root)? {
        let intent: Intent = store::required(&root.join(name(id)))?;
        if intent.account == account {
            settle(root, id)?;
        }
    }
    Ok(())
}
