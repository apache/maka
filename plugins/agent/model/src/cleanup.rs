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

use crate::ModelError;
use maka_agent_ports::model::RequestSource;
use std::{
    error::Error,
    fmt,
    sync::{Arc, Mutex},
};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamCleanupStage {
    Adapter,
    Source,
    Worker,
}

#[derive(Clone)]
pub enum StreamCleanupError {
    Pending {
        observer: ModelCleanupObserver,
        cause: Option<Arc<ModelError>>,
    },
    Unobservable {
        stage: StreamCleanupStage,
        cause: Arc<dyn Error + Send + Sync>,
        original: Option<Arc<ModelError>>,
        material: Option<RequestSource>,
    },
}
impl StreamCleanupError {
    pub fn observer(&self) -> Option<ModelCleanupObserver> {
        match self {
            Self::Pending { observer, .. } => Some(observer.clone()),
            Self::Unobservable { .. } => None,
        }
    }
}
impl fmt::Debug for StreamCleanupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending { cause, .. } => f
                .debug_struct("Pending")
                .field("cause", cause)
                .finish_non_exhaustive(),
            Self::Unobservable {
                stage,
                cause,
                original,
                ..
            } => f
                .debug_struct("Unobservable")
                .field("stage", stage)
                .field("cause", cause)
                .field("original", original)
                .finish_non_exhaustive(),
        }
    }
}
impl fmt::Display for StreamCleanupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pending { cause, .. } => {
                write!(f, "original model cleanup is still running")?;
                if let Some(cause) = cause {
                    write!(f, ": {cause}")?;
                }
                Ok(())
            }
            Self::Unobservable {
                stage,
                cause,
                original,
                ..
            } => {
                write!(
                    f,
                    "original model cleanup cannot be confirmed at {stage:?}: {cause}"
                )?;
                if let Some(original) = original {
                    write!(f, "; original model outcome: {original}")?;
                }
                Ok(())
            }
        }
    }
}
impl Error for StreamCleanupError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Pending { cause, .. } => cause
                .as_ref()
                .map(|cause| cause.as_ref() as &(dyn Error + 'static)),
            Self::Unobservable { cause, .. } => Some(cause.as_ref()),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum Observation {
    Running(Option<Arc<ModelError>>),
    Confirmed,
    Unobservable(StreamCleanupError),
}

/// Observes the original worker and source close, never journal or business completion.
#[derive(Clone)]
pub struct ModelCleanupObserver {
    state: watch::Receiver<Observation>,
    material: Arc<Mutex<Option<RequestSource>>>,
}
impl fmt::Debug for ModelCleanupObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModelCleanupObserver")
            .finish_non_exhaustive()
    }
}
impl ModelCleanupObserver {
    pub fn status(&self) -> Result<bool, StreamCleanupError> {
        let value = self.state.borrow().clone();
        match value {
            Observation::Confirmed => Ok(true),
            Observation::Unobservable(error) => Err(error),
            Observation::Running(original) => match self.state.has_changed() {
                Ok(_) => Ok(false),
                Err(error) => {
                    Err(self.unobservable(StreamCleanupStage::Worker, Arc::new(error), original))
                }
            },
        }
    }
    pub async fn wait(&self) -> Result<(), StreamCleanupError> {
        let mut state = self.state.clone();
        loop {
            match state.borrow_and_update().clone() {
                Observation::Confirmed => return Ok(()),
                Observation::Unobservable(error) => return Err(error),
                Observation::Running(_) => {}
            }
            if let Err(error) = state.changed().await {
                let value = state.borrow().clone();
                return match value {
                    Observation::Confirmed => Ok(()),
                    Observation::Unobservable(error) => Err(error),
                    Observation::Running(original) => Err(self.unobservable(
                        StreamCleanupStage::Worker,
                        Arc::new(error),
                        original,
                    )),
                };
            }
        }
    }
    pub(super) fn channel(source: Option<RequestSource>) -> (watch::Sender<Observation>, Self) {
        let (sender, state) = watch::channel(Observation::Running(None));
        (
            sender,
            Self {
                state,
                material: Arc::new(Mutex::new(source)),
            },
        )
    }
    pub(super) fn pending(&self) -> StreamCleanupError {
        let cause = match &*self.state.borrow() {
            Observation::Running(cause) => cause.clone(),
            _ => None,
        };
        StreamCleanupError::Pending {
            observer: self.clone(),
            cause,
        }
    }
    pub(super) fn unobservable(
        &self,
        stage: StreamCleanupStage,
        cause: Arc<dyn Error + Send + Sync>,
        original: Option<Arc<ModelError>>,
    ) -> StreamCleanupError {
        let original = original.or_else(|| match &*self.state.borrow() {
            Observation::Running(cause) => cause.clone(),
            Observation::Unobservable(StreamCleanupError::Unobservable { original, .. }) => {
                original.clone()
            }
            _ => None,
        });
        StreamCleanupError::Unobservable {
            stage,
            cause,
            original,
            material: self.material.lock().unwrap().clone(),
        }
    }
    pub(super) fn release_material(&self) {
        self.material.lock().unwrap().take();
    }
}
