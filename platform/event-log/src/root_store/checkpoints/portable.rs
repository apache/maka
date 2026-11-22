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

//! Portable read-only local operator archives. Only immutable payloads leave the Root.
#[cfg(test)]
mod tests;

use super::workspace;
use crate::{
    StoreError,
    checkpoints::{
        Head, Manifest, ObjectRef, Revision, Scope, WorkspaceEntry, invalid, valid_digest,
    },
    root,
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use flate2::{Compression, bufread::GzDecoder, write::GzEncoder};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, Write},
    path::Path,
};
use tar::{Archive, Builder, Entries, Entry, Header};

const HEAD: &str = "maka-checkpoint-v1/head.json";
const MANIFEST: &str = "manifest.json";
const HISTORY: &str = "history.snapshot";
const INVENTORY: &str = "workspace.json";

pub struct Inspection {
    pub head: Head,
    pub manifest: Manifest,
    pub history: File,
    /// Output allowance remaining after the binary history and expanded Workspace.
    pub remaining_bytes: u64,
}

fn retained(
    db: &Connection,
    session: &str,
    revision: Revision,
) -> Result<(Head, Scope), StoreError> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT h.head_json,b.scope_json FROM history_checkpoint_heads h
         JOIN history_checkpoint_bindings b USING (session_id) WHERE h.session_id=?",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (head, scope) = row.ok_or_else(|| invalid("checkpoint revision unavailable"))?;
    let head: Head = serde_json::from_str(&head)?;
    if head.revision != revision {
        return Err(invalid("checkpoint revision unavailable"));
    }
    Ok((head, serde_json::from_str(&scope)?))
}

fn file_objects(entries: &[WorkspaceEntry]) -> Result<BTreeMap<&str, &ObjectRef>, StoreError> {
    let mut files = BTreeMap::new();
    for entry in entries {
        if let WorkspaceEntry::File { object, .. } = entry {
            if !valid_digest(&object.digest) {
                return Err(invalid("invalid workspace object digest"));
            }
            if let Some(prior) = files.insert(object.digest.as_str(), object)
                && prior != object
            {
                return Err(invalid("inconsistent workspace object length"));
            }
        }
    }
    Ok(files)
}

struct Hashed<R> {
    reader: R,
    hash: Sha256,
    bytes: u64,
}
impl<R: Read> Read for Hashed<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.reader.read(buf)?;
        self.hash.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}
fn verified<T>(
    reader: impl Read,
    expected: &ObjectRef,
    consume: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let mut source = Hashed {
        reader,
        hash: Sha256::new(),
        bytes: 0,
    };
    let result = consume(&mut source)?;
    if source.bytes != expected.bytes || hex::encode(source.hash.finalize()) != expected.digest {
        return Err(invalid("checkpoint object digest or length differs"));
    }
    Ok(result)
}
fn append<W: Write>(
    tar: &mut Builder<W>,
    name: &str,
    bytes: u64,
    source: impl Read,
) -> Result<(), StoreError> {
    let mut header = Header::new_ustar();
    header.set_size(bytes);
    header.set_mode(0o600);
    header.set_entry_type(tar::EntryType::Regular);
    tar.append_data(&mut header, name, source)?;
    Ok(())
}

/// Local operator with access to the Root files. Head reads are short SQLite
/// snapshots; do not hold a writer lease or pin the WAL during compression.
pub fn export(
    root_path: &Path,
    session: &str,
    revision: Revision,
    output: impl Write,
) -> Result<Head, StoreError> {
    let location = root::resolve(root_path)?;
    let base = location.canonical_path();
    let directory = Dir::open_ambient_dir(base, cap_std::ambient_authority())?;
    let objects = directory
        .open_dir_nofollow("history-checkpoints")?
        .open_dir_nofollow("objects")?;
    let db = Connection::open_with_flags(
        base.join(root::ROOT_DATABASE),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    let (head, scope) = retained(&db, session, revision)?;
    let open = |object: &ObjectRef| -> Result<File, StoreError> {
        if !valid_digest(&object.digest) {
            return Err(invalid("invalid checkpoint object digest"));
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = objects.open_with(&object.digest, &options)?.into_std();
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() != object.bytes {
            return Err(invalid(
                "checkpoint object is not the expected regular file",
            ));
        }
        Ok(file)
    };
    let manifest: Manifest = verified(open(&head.manifest)?, &head.manifest, |r| {
        Ok(serde_json::from_reader(BufReader::new(r))?)
    })?;
    if manifest.root_id != location.root_id()
        || manifest.scope != scope
        || manifest.session_id != session
    {
        return Err(invalid("checkpoint origin differs"));
    }
    let mut tar = Builder::new(GzEncoder::new(output, Compression::fast()));
    let h = serde_json::to_vec(&head)?;
    append(&mut tar, HEAD, h.len() as u64, &h[..])?;
    verified(open(&head.manifest)?, &head.manifest, |r| {
        append(&mut tar, MANIFEST, head.manifest.bytes, r)
    })?;
    let history = &manifest.history.object;
    verified(open(history)?, history, |r| {
        append(&mut tar, HISTORY, history.bytes, r)
    })?;
    if let Some(ws) = manifest.workspace {
        let inv = &ws.inventory;
        let entries = verified(open(inv)?, inv, |r| {
            workspace::read_inventory(BufReader::new(r))
        })?;
        // Re-read and verify the same object instead of retaining its encoded JSON.
        verified(open(inv)?, inv, |r| {
            append(&mut tar, INVENTORY, inv.bytes, r)
        })?;
        for (digest, object) in file_objects(&entries)? {
            verified(open(object)?, object, |r| {
                append(&mut tar, &format!("objects/{digest}"), object.bytes, r)
            })?;
        }
    }
    tar.into_inner()?.finish()?;
    if retained(&db, session, revision)? != (head.clone(), scope)
        || root::resolve(base)?.root_id() != location.root_id()
    {
        return Err(invalid("checkpoint source changed during export"));
    }
    Ok(head)
}
fn next<'a, R: Read>(entries: &mut Entries<'a, R>, name: &str) -> Result<Entry<'a, R>, StoreError> {
    let entry = entries
        .next()
        .transpose()?
        .ok_or_else(|| invalid("missing checkpoint archive member"))?;
    if entry.header().entry_type() != tar::EntryType::Regular
        || entry.path_bytes().as_ref() != name.as_bytes()
    {
        return Err(invalid(format!(
            "expected regular checkpoint archive member {name}"
        )));
    }
    Ok(entry)
}
fn consume<R: Read, T>(
    entries: &mut Entries<'_, R>,
    name: &str,
    object: &ObjectRef,
    f: impl FnOnce(&mut dyn Read) -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    let e = next(entries, name)?;
    if e.size() != object.bytes {
        return Err(invalid("checkpoint archive member length differs"));
    }
    verified(e, object, f)
}

/// The caller owns both private, empty directories. An archive member's path
/// is never passed to the filesystem. Only validated inventory entries use names.
pub fn open(
    input: File,
    staging: &Path,
    scratch: &Path,
    max_bytes: u64,
) -> Result<Inspection, StoreError> {
    let gzip = GzDecoder::new(BufReader::new(input));
    let mut tar = Archive::new(gzip);
    let mut entries = tar.entries()?.raw(true);
    let head: Head = serde_json::from_reader(BufReader::new(next(&mut entries, HEAD)?))?;
    if head.revision.0.is_nil() {
        return Err(invalid("nil checkpoint revision"));
    }
    let manifest: Manifest = consume(&mut entries, MANIFEST, &head.manifest, |r| {
        Ok(serde_json::from_reader(BufReader::new(r))?)
    })?;
    crate::sessions::validate_id(&manifest.session_id)?;
    if !valid_digest(&manifest.root_id)
        || !valid_digest(&manifest.scope.state_domain)
        || manifest.scope.deployment.is_nil()
    {
        return Err(invalid("invalid checkpoint source identity"));
    }
    manifest
        .scope
        .namespace
        .validate()
        .map_err(|e| invalid(e.to_string()))?;
    let mut remaining = max_bytes;
    let mut charge = |n: u64| -> Result<(), StoreError> {
        remaining = remaining
            .checked_sub(n)
            .ok_or_else(|| invalid("checkpoint exceeds inspection byte budget"))?;
        Ok(())
    };
    charge(manifest.history.object.bytes)?;
    let mut history = File::create_new(staging.join(HISTORY))?;
    consume(&mut entries, HISTORY, &manifest.history.object, |r| {
        io::copy(r, &mut history)?;
        Ok(())
    })?;
    history.sync_all()?;
    history.rewind()?;
    let workspace = if let Some(ws) = &manifest.workspace {
        let inv = &ws.inventory;
        let paths = consume(&mut entries, INVENTORY, inv, |r| {
            workspace::read_inventory(BufReader::new(r))
        })?;
        for entry in &paths {
            if let WorkspaceEntry::File { object, .. } = entry {
                charge(object.bytes)?;
            }
        }
        for (digest, object) in file_objects(&paths)? {
            let mut sink = File::create_new(scratch.join(digest))?;
            consume(&mut entries, &format!("objects/{digest}"), object, |r| {
                io::copy(r, &mut sink)?;
                Ok(())
            })?;
        }
        Some(paths)
    } else {
        None
    };
    if entries.next().transpose()?.is_some() {
        return Err(invalid("unexpected trailing checkpoint archive member"));
    }
    let mut gzip = tar.into_inner();
    let mut end = [0u8; 512];
    gzip.read_exact(&mut end)?;
    if end != [0; 512] || gzip.read(&mut end)? != 0 || !gzip.into_inner().fill_buf()?.is_empty() {
        return Err(invalid("invalid checkpoint archive terminator"));
    }
    // Expand repeated references only after checking the complete transport,
    // including its gzip trailer. Until then scratch holds one copy per digest.
    if let Some(paths) = workspace {
        let staging = Dir::open_ambient_dir(staging, cap_std::ambient_authority())?;
        staging.create_dir("workspace")?;
        workspace::materialize_entries(paths, &staging.open_dir_nofollow("workspace")?, |o| {
            Ok(File::open(scratch.join(&o.digest))?)
        })?;
    }
    Ok(Inspection {
        head,
        manifest,
        history,
        remaining_bytes: remaining,
    })
}
