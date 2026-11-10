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

//! Blocking resource I/O retained by the original accepted work's read actor.
use super::{SessionStore, StoreError};

impl SessionStore {
    /// The read actor owns the original work pin through completion even if its
    /// observer disappears. Cleanup does not enter a new Root admission gate.
    pub async fn with_resource_io<T: Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.work_lifetime()?;
        self.scoped()
            .await?
            .connection
            .read(move |_| operation())
            .await
    }
}

/// Create only inside an accepted database operation.
pub fn create_request_file() -> std::io::Result<std::fs::File> {
    tempfile::tempfile()
}
/// Non-owning evidence from one failed close of an original request backing.
/// A descriptor/handle value is an observation, not ownership or permission to
/// retry close: the OS may already have released and reused that numeric value.
#[derive(Debug)]
pub struct RequestFileCloseFailure {
    #[cfg(unix)]
    descriptor: std::os::fd::RawFd,
    #[cfg(windows)]
    handle: usize,
    error: std::io::Error,
}
impl RequestFileCloseFailure {
    pub fn error(&self) -> &std::io::Error {
        &self.error
    }
    #[cfg(unix)]
    pub fn descriptor(&self) -> std::os::fd::RawFd {
        self.descriptor
    }
    #[cfg(windows)]
    pub fn handle(&self) -> usize {
        self.handle
    }
}
impl std::fmt::Display for RequestFileCloseFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        #[cfg(unix)]
        {
            write!(
                f,
                "close of original request backing descriptor {} failed: {}",
                self.descriptor, self.error
            )
        }
        #[cfg(windows)]
        {
            write!(
                f,
                "close of original request backing handle {} failed: {}",
                self.handle, self.error
            )
        }
    }
}
impl std::error::Error for RequestFileCloseFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.error)
    }
}

/// Consume the original descriptor exactly once; a failed close is not retried.
#[cfg(unix)]
pub fn close_request_file(file: std::fs::File) -> Result<(), RequestFileCloseFailure> {
    use std::os::fd::IntoRawFd;
    let descriptor = file.into_raw_fd();
    // SAFETY: into_raw_fd transfers the one owned descriptor. No File or
    // borrower retains it, and retrying close could affect a reused descriptor.
    let closed = unsafe { libc::close(descriptor) };
    if closed == 0 {
        Ok(())
    } else {
        Err(RequestFileCloseFailure {
            descriptor,
            error: std::io::Error::last_os_error(),
        })
    }
}
#[cfg(windows)]
pub fn close_request_file(file: std::fs::File) -> Result<(), RequestFileCloseFailure> {
    use std::os::windows::io::IntoRawHandle;
    let handle = file.into_raw_handle();
    // SAFETY: into_raw_handle transfers this unique owned File handle.
    let closed = unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    if closed != 0 {
        Ok(())
    } else {
        Err(RequestFileCloseFailure {
            handle: handle as usize,
            error: std::io::Error::last_os_error(),
        })
    }
}
