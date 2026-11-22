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

//! Failed exports still return the owner of any acquired native resources.
use super::*;
use futures_util::{FutureExt, future::Shared};
use maka_host_runtime::application::{NativeActivation, NativeOwner};

pub(crate) struct InitializationError {
    message: String,
    owner: Arc<dyn NativeOwner>,
}
impl std::fmt::Debug for InitializationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("InitializationError")
            .field(&self.message)
            .finish()
    }
}
impl From<String> for InitializationError {
    fn from(message: String) -> Self {
        Self {
            message,
            owner: Arc::new(()),
        }
    }
}
impl From<&str> for InitializationError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
struct StartupMaterial {
    configuration: Arc<ConfigurationStore>,
    mcp: Option<crate::mcp::CleanupMaterial>,
    _root: Arc<RootStore>,
}
struct FailedInitialization {
    _material: Arc<StartupMaterial>,
    closed: Shared<BoxFuture<'static, Result<(), String>>>,
}
impl NativeOwner for FailedInitialization {
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        self.closed.clone().boxed()
    }
}
impl InitializationError {
    pub(super) fn instance(message: String, owner: Arc<Owner>) -> Self {
        Self {
            message,
            owner: Arc::new(crate::service::Agent(owner)),
        }
    }
    pub(super) fn owned(
        message: String,
        configuration: Arc<ConfigurationStore>,
        mcp: Option<crate::mcp::CleanupMaterial>,
        root: Arc<RootStore>,
    ) -> Self {
        let material = Arc::new(StartupMaterial {
            configuration,
            mcp,
            _root: root,
        });
        let original = material.clone();
        let closed = async move {
            if let Some(mcp) = &original.mcp {
                mcp.closed().await?;
            }
            original
                .configuration
                .shutdown()
                .await
                .map_err(|error| error.to_string())
        }
        .boxed()
        .shared();
        Self {
            message,
            owner: Arc::new(FailedInitialization {
                _material: material,
                closed,
            }),
        }
    }
    pub(crate) fn activation(self) -> NativeActivation {
        NativeActivation {
            exports: Err(self.message),
            owner: self.owner,
        }
    }
}
