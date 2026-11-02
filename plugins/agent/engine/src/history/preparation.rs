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

//! One source staging account promoted once to its complete logical request.
use maka_capabilities::model_preparation::{ActivePreparation, StagedPreparation};
use std::{
    io,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

enum Phase {
    Staged(StagedPreparation),
    Promoting,
    Active {
        preparation: Arc<ActivePreparation>,
        peak: usize,
    },
    Closed,
}
pub(crate) struct RequestPreparation {
    phase: Mutex<Phase>,
    promotion: tokio::sync::Mutex<()>,
}
impl RequestPreparation {
    pub fn new(staged: StagedPreparation) -> Arc<Self> {
        Arc::new(Self {
            phase: Mutex::new(Phase::Staged(staged)),
            promotion: tokio::sync::Mutex::new(()),
        })
    }
    pub fn metadata_bytes() -> usize {
        4 * std::mem::size_of::<usize>()
            + std::mem::size_of::<Self>()
            + std::mem::size_of::<ActivePreparation>()
    }
    pub fn directory(&self, bytes: usize) -> io::Result<maka_model::DirectoryLease> {
        let phase = self
            .phase
            .lock()
            .expect("request preparation lock poisoned");
        match &*phase {
            Phase::Staged(staged) => staged.directory(bytes),
            Phase::Active { preparation, .. } => preparation.directory(bytes),
            Phase::Promoting | Phase::Closed => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "request preparation cannot allocate in this phase",
            )),
        }
    }
    pub fn plan_directory(&self, bytes: usize) -> io::Result<maka_model::DirectoryLease> {
        let phase = self
            .phase
            .lock()
            .expect("request preparation lock poisoned");
        match &*phase {
            Phase::Staged(staged) => staged.plan_directory(bytes),
            Phase::Active { preparation, .. } => preparation.directory(bytes),
            Phase::Promoting | Phase::Closed => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "request planning is closed",
            )),
        }
    }

    pub fn active(&self) -> Option<Arc<ActivePreparation>> {
        let phase = self
            .phase
            .lock()
            .expect("request preparation lock poisoned");
        match &*phase {
            Phase::Active { preparation, .. } => Some(preparation.clone()),
            _ => None,
        }
    }
    pub async fn promote(&self, peak: usize, cancellation: &CancellationToken) -> io::Result<()> {
        let _promotion = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(cancelled()),
            guard = self.promotion.lock() => guard,
        };
        let staged = {
            let mut phase = self
                .phase
                .lock()
                .expect("request preparation lock poisoned");
            match std::mem::replace(&mut *phase, Phase::Promoting) {
                Phase::Staged(staged) => staged,
                Phase::Active {
                    preparation,
                    peak: admitted,
                } => {
                    *phase = Phase::Active {
                        preparation,
                        peak: admitted,
                    };
                    return if peak <= admitted {
                        Ok(())
                    } else {
                        Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "logical request exceeds its frozen active envelope",
                        ))
                    };
                }
                Phase::Promoting | Phase::Closed => {
                    *phase = Phase::Closed;
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "logical request preparation is closed",
                    ));
                }
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(cancelled()),
            active = staged.promote(peak) => active,
        };
        let mut phase = self
            .phase
            .lock()
            .expect("request preparation lock poisoned");
        match result {
            Ok(active) => {
                *phase = Phase::Active {
                    preparation: Arc::new(active),
                    peak,
                };
                Ok(())
            }
            Err(error) => {
                *phase = Phase::Closed;
                Err(error)
            }
        }
    }
}
fn cancelled() -> io::Error {
    crate::preparation_cancelled("request preparation cancelled")
}
