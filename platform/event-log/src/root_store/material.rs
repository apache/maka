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

//! Root-owned maintenance starts after recovery and rechecks all retired owners
//! after a committed ownership release. SQLite is the durable progress ledger:
//! shutdown stops new steps; reopening resumes partially collected material.

use super::EventLog;
use crate::sessions::MaterialCollection;
use std::sync::Arc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(super) async fn maintain(
    partitions: &[Arc<EventLog>],
    ready: oneshot::Receiver<()>,
    stop: CancellationToken,
) {
    tokio::select! {
        biased;
        () = stop.cancelled() => {},
        () = async {
            if ready.await.is_ok() {
                let collectors = partitions.iter().enumerate().map(|(index, log)| collect(index, log));
                futures_util::future::join_all(collectors).await;
            }
        } => {},
    }
    // Dropping a pending collector only cancels its observer. Already accepted
    // SQL jobs still drain on their original actors before Root releases authority.
}

async fn collect(partition: usize, log: &EventLog) {
    let mut releases = log.commits.subscribe_material_releases();
    loop {
        // Consume only hints preceding this pass. A release during the scan must
        // remain unread, so owners skipped as Retained get another pass.
        releases.borrow_and_update();
        let mut after = None;
        loop {
            match log.collect_session_material(after.as_deref()).await {
                Ok(MaterialCollection::Retained(session)) => after = Some(session),
                Ok(MaterialCollection::Collected) => {}
                Ok(MaterialCollection::Done) => break,
                Err(error) => {
                    // Never spin on an uncertain commit or claim collection is
                    // complete. A later release/reopen rereads canonical state.
                    eprintln!(
                        "Session material collection failed for partition {partition}: {error}"
                    );
                    break;
                }
            }
        }
        if releases.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests;
