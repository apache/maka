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
use std::{fs::File, io::Read, process::Command as Native, time::Duration};
use tokio::io::AsyncWriteExt;

#[test]
fn private_files_are_anchored_and_publication_preserves_existing_evidence() -> io::Result<()> {
    use maka_event_log::root::windows::{open_nofollow, validate_protected_private};
    let temp = tempfile::tempdir()?;
    let resource = fs::create_resource(&temp.path().join("namespace"))?;
    let root = open_nofollow(&resource, false)?;
    let owner = fs::directory(&root, "owner".as_ref())?;
    validate_protected_private(&owner)?;
    fs::publish(&owner, "proof", b"original")?;
    let mut proof = evidence::open_regular(&owner, "proof")?;
    let id = fs::identity(&proof)?;
    assert_eq!(id, fs::identity(&evidence::open_regular(&owner, "proof")?)?);
    assert_eq!(
        fs::publish(&owner, "proof", b"replacement")
            .unwrap_err()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    let mut text = String::new();
    proof.read_to_string(&mut text)?;
    assert_eq!(text, "original");
    let link = resource.join("junction");
    let result = Native::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(temp.path())
        .output()?;
    assert!(result.status.success(), "{result:?}");
    assert!(fs::directory(&root, "junction".as_ref()).is_err());
    let inherited = File::create_new(resource.join("owner/inherited"))?;
    assert!(fs::private_file(&inherited).is_err());
    Ok(())
}

#[tokio::test]
async fn live_session_receipts_and_notification_refer_to_the_same_spool()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let owner = TaskOwner::prepare_live(
        temp.path(),
        temp.path(),
        &std::env::current_exe()?,
        CancellationToken::new(),
    )
    .await?;
    let path = owner.descriptor().resource_ref;
    let descriptor = owner.prepare_session(std::env::current_exe()?).await?;
    let mut watch = EvidenceWatch::open(&descriptor, EvidenceInterest::Cleanup).await?;
    let mut spool = SessionSpool::open(descriptor.clone()).await?;
    assert!(SessionSpool::open(descriptor.clone()).await.is_err());
    spool.output.write_all(b"final frame").await?;
    spool.seal().await?;
    tokio::time::timeout(Duration::from_secs(10), watch.wait()).await??;
    watch.close().await?;
    let mut evidence = closed_evidence(&descriptor)
        .await?
        .expect("closed original spool");
    let mut bytes = Vec::new();
    evidence.stdout.read_to_end(&mut bytes)?;
    assert_eq!(bytes, b"final frame");
    drop(evidence);
    drop(owner);
    std::fs::remove_dir_all(path)?;
    Ok(())
}

#[tokio::test]
async fn failed_detached_spawn_removes_only_its_original_material()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let helper = temp.path().join("missing-after-prepare.exe");
    std::fs::copy(std::env::current_exe()?, &helper)?;
    let source = temp.path().join("source");
    let state = temp.path().join("state");
    std::fs::create_dir(&source)?;
    std::fs::create_dir(&state)?;
    let owner = TaskOwner::prepare_live(&source, &state, &helper, CancellationToken::new()).await?;
    let descriptor = owner.descriptor();
    std::fs::remove_file(&helper)?;
    let command = crate::Command::new(std::env::current_exe()?, &source);
    assert!(matches!(
        owner.spawn_pipe(command).await,
        Err(SpawnError::Closed(_))
    ));
    assert!(descriptor.resource_ref.join("owner/task.json").is_file());
    assert!(
        !descriptor
            .resource_ref
            .join("launch/material.json")
            .try_exists()?
    );
    std::fs::remove_dir_all(descriptor.resource_ref)?;
    Ok(())
}

#[test]
fn capture_rejects_a_live_writer_and_baseline_pins_the_original_entry()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    std::fs::create_dir(&source)?;
    let resource = fs::create_resource(&temp.path().join("namespace"))?;
    let writer = File::create(source.join("file"))?;
    let input = maka_event_log::root::windows::open_nofollow(&source, false)?;
    let held = maka_event_log::root::windows::open_nofollow(&resource, false)?;
    let scratch = fs::mkdir(&held, "capture".as_ref())?;
    let error = fs::copy_tree(&input, &scratch, |_| true).unwrap_err();
    assert!(
        matches!(&error, Error::CaptureUnstable(path) if path == Path::new("file")),
        "{error:?}"
    );
    drop(writer);
    std::fs::write(source.join("file"), b"original")?;
    let proof = snapshot::capture(&source, &resource, &Policy::uniform(Access::Read))?;
    let reader = BaselineReader::from_resource(&held, proof)?;
    std::fs::rename(
        resource.join("baseline/file"),
        resource.join("baseline/retained"),
    )?;
    std::fs::write(resource.join("baseline/file"), b"replacement")?;
    assert!(reader.open_entry(Path::new("file")).is_err());

    let reparse_source = temp.path().join("reparse-source");
    std::fs::create_dir(&reparse_source)?;
    let junction = reparse_source.join("link");
    let mklink = Native::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&source)
        .output()?;
    assert!(mklink.status.success(), "{mklink:?}");
    let reparse_input = maka_event_log::root::windows::open_nofollow(&reparse_source, false)?;
    let scratch2 = fs::mkdir(&held, "capture-reparse".as_ref())?;
    let error = fs::copy_tree(&reparse_input, &scratch2, |_| true).unwrap_err();
    assert!(
        matches!(&error, Error::CaptureUnsupported(message) if message.contains("link")),
        "{error:?}"
    );
    Ok(())
}
