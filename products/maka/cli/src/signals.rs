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

use maka_host_runtime::HostError;
use tokio_util::sync::CancellationToken;

pub(super) struct Signals(tokio::task::JoinHandle<()>);

impl Drop for Signals {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) fn watch(cancel: CancellationToken) -> Result<Signals, HostError> {
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    Ok(Signals(tokio::spawn(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = async {
                #[cfg(unix)]
                { terminate.recv().await; }
                #[cfg(windows)]
                { std::future::pending::<()>().await; }
            } => {},
        }
        cancel.cancel();
    })))
}
