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

use maka_sandbox::windows::{Account, Credential, Desktop, DesktopTransfer, Password};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    os::windows::io::BorrowedHandle,
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const DESKTOP_BOOTSTRAP: &str = "__maka-sandbox-desktop";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    account: String,
    owner: String,
    credential: Credential,
    participants: Vec<String>,
}

/// # Safety
/// Dispatch before creating threads: Desktop::create selects a process station.
pub unsafe fn serve_desktop() -> io::Result<()> {
    let mut header = [0; 4];
    io::stdin().read_exact(&mut header)?;
    let size = u32::from_le_bytes(header) as usize;
    let mut bytes = vec![0; size];
    io::stdin().read_exact(&mut bytes)?;
    let request: Request = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let desktop = request.credential.unprotect().and_then(|password| unsafe {
        Desktop::create(
            &request.account,
            &password,
            &request.owner,
            &request.participants,
        )
    });
    let reply = desktop
        .as_ref()
        .map(Desktop::transfer)
        .map_err(ToString::to_string);
    let bytes = serde_json::to_vec(&reply).map_err(io::Error::other)?;
    io::stdout().write_all(&(bytes.len() as u32).to_le_bytes())?;
    io::stdout().write_all(&bytes)?;
    io::stdout().flush()?;
    let desktop = desktop?;
    let mut ack = [0];
    io::stdin().read_exact(&mut ack)?;
    if ack != [1] {
        return Err(io::Error::other("desktop transfer not acknowledged"));
    }
    drop(desktop);
    Ok(())
}

/// A short-lived same-user helper, never elevated. Only native GUI object
/// preparation runs here; credentials are encrypted and travel on private pipes.
pub async fn desktop(
    executable: &Path,
    account: &Account,
    password: &Password,
    participants: &[String],
) -> io::Result<Desktop> {
    let request = Request {
        account: account.name(),
        owner: account.owner().into(),
        credential: password.protect()?,
        participants: participants.to_vec(),
    };
    let bytes = serde_json::to_vec(&request).map_err(io::Error::other)?;
    if u32::try_from(bytes.len()).is_err() {
        return Err(io::Error::other("desktop request exceeds limit"));
    }
    let mut child = tokio::process::Command::new(executable)
        .arg(DESKTOP_BOOTSTRAP)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("missing desktop stdin"))?;
        let mut output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing desktop stdout"))?;
        input.write_u32_le(bytes.len() as u32).await?;
        input.write_all(&bytes).await?;
        input.flush().await?;
        let size = output.read_u32_le().await? as usize;
        let mut bytes = vec![0; size];
        output.read_exact(&mut bytes).await?;
        let reply: Result<DesktopTransfer, String> =
            serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("desktop helper exited"))?;
        let desktop = unsafe {
            Desktop::receive(
                BorrowedHandle::borrow_raw(process),
                reply.map_err(io::Error::other)?,
            )?
        };
        input.write_all(&[1]).await?;
        drop(input);
        let status = child.wait().await?;
        if !status.success() {
            return Err(io::Error::other(format!("desktop helper exited: {status}")));
        }
        Ok(desktop)
    })
    .await
    .unwrap_or_else(|_| {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "desktop preparation timed out",
        ))
    });
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}
