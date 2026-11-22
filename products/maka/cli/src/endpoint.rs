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
use maka_host_runtime::ipc::LocalListener;
use std::path::PathBuf;

pub(super) struct LocalEndpoint {
    pub listener: LocalListener,
    pub path: PathBuf,
    #[cfg(unix)]
    _directory: tempfile::TempDir,
}

impl LocalEndpoint {
    pub fn bind() -> Result<Self, HostError> {
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::PermissionsExt;
            tempfile::Builder::new()
                .prefix("maka-host-")
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir()?
        };
        #[cfg(unix)]
        let path = directory.path().join("h.sock");
        #[cfg(windows)]
        let path = PathBuf::from(format!(r"\\.\pipe\maka-host-{}", uuid::Uuid::new_v4()));
        Ok(Self {
            listener: LocalListener::bind(&path)?,
            path,
            #[cfg(unix)]
            _directory: directory,
        })
    }
}
