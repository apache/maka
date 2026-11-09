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

use crate::{
    PipeEvent, failed,
    output::{Captured, Outcome, Termination},
    tail,
};
use maka_agent_facts::tools::ToolError;
use maka_plugin_core::shell_run::PipeStream;
use std::{io, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) async fn run(
    plan: crate::Command,
    timeout_ms: Option<u64>,
    cancellation: CancellationToken,
    observer: Option<tokio::sync::mpsc::Sender<PipeEvent>>,
) -> Result<Captured, ToolError> {
    if cancellation.is_cancelled() {
        return Err(failed("Shell cancelled before spawn"));
    }
    #[cfg(windows)]
    let plan = plan.with_startup_cancellation(cancellation.clone());
    let plan = plan.prepare().await?;
    if cancellation.is_cancelled() {
        plan.abort().await?;
        return Err(failed("Shell cancelled before spawn"));
    }
    let crate::pipe::Spawned {
        mut child,
        stdin,
        stdout,
        stderr,
    } = crate::pipe::spawn_prepared(plan).await?;
    drop(stdin);
    if let Some(observer) = &observer {
        let _ = observer.try_send(PipeEvent::Started);
    }
    let exited = CancellationToken::new();
    let lifecycle = async {
        let outcome = settle(&mut child, timeout_ms, cancellation).await;
        exited.cancel();
        outcome
    };
    let (outcome, stdout, stderr) = tokio::join!(
        lifecycle,
        tail::capture(
            stdout,
            exited.clone(),
            observer.clone().map(|o| (o, PipeStream::Stdout))
        ),
        tail::capture(
            stderr,
            exited.clone(),
            observer.map(|o| (o, PipeStream::Stderr))
        ),
    );
    Ok(Captured::new(outcome?, stdout, stderr))
}

async fn settle(
    child: &mut crate::pipe::Child,
    timeout_ms: Option<u64>,
    cancellation: CancellationToken,
) -> Result<Outcome, ToolError> {
    #[cfg(windows)]
    let wait = child.wait_foreground();
    #[cfg(unix)]
    let wait = child.wait();
    let reason = tokio::select! {
        biased;
        result = wait => return result.map(Outcome::Exited).map_err(unknown),
        _ = cancellation.cancelled() => Termination::Cancelled,
        _ = crate::timeout(timeout_ms) => Termination::Timeout,
    };
    #[cfg(unix)]
    let signal_applied = {
        let applied = child.interrupt().await.map_err(unknown)?;
        // The original unreaped root pins its group until the final signal.
        tokio::time::sleep(Duration::from_secs(2)).await;
        applied
    };
    child.terminate().await.map_err(unknown)?;
    #[cfg(windows)]
    let signal_applied = true;
    tokio::time::timeout(Duration::from_secs(4), child.wait())
        .await
        .map_err(|_| {
            ToolError::CleanupUnconfirmed("Shell process group/tree exit not confirmed".into())
        })?
        .map_err(unknown)?;
    Ok(Outcome::Interrupted {
        reason,
        signal_applied,
    })
}
fn unknown(error: io::Error) -> ToolError {
    ToolError::CleanupUnconfirmed(format!(
        "Shell process group/tree cleanup not confirmed: {error}"
    ))
}
