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
use crate::publication::{
    BUFFER_BYTES, Capture, PublicationConflict, PublicationContent, PublicationEntry,
    PublicationUnsupported, conflict, finish_digest, hash_reader, unsupported,
};
use maka_agent_facts::durable::ContentRef;
use std::io::{Read, Seek};

impl Target {
    pub(crate) fn capture_publication(
        authority: &Authority,
        path: &Path,
        expected: &PublicationEntry,
        mode_only: bool,
    ) -> Result<Capture, ToolError> {
        let Some(route) = authority.publication_route(path)? else {
            return Err(failed(
                "publication requires the captured selected workspace",
            ));
        };
        {
            let (root, managed) = route
                .root
                .authorize_write(&route.relative)
                .map_err(io_error)?;
            let parent = match open_parent(&root, route.relative.parent().unwrap_or(Path::new("")))
            {
                Ok(parent) => parent,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) =>
                {
                    return Ok(Capture::Refused(conflict(
                        PublicationConflict::EntryVisibility,
                    )));
                }
                Err(error) => return Err(io_error(error)),
            };
            let name = route
                .relative
                .file_name()
                .ok_or_else(|| failed("publication entry needs a basename"))?;
            match (expected, parent.symlink_metadata(name)) {
                (PublicationEntry::Missing, Err(error))
                    if error.kind() == io::ErrorKind::NotFound => {}
                (PublicationEntry::File { .. }, Ok(metadata)) if metadata.is_file() => {
                    if managed && metadata.nlink() != 1 {
                        return Ok(Capture::Refused(unsupported(
                            PublicationUnsupported::AliasedTarget,
                        )));
                    }
                }
                (_, Ok(_)) => {
                    return Ok(Capture::Refused(conflict(PublicationConflict::EntryType)));
                }
                (_, Err(error)) if error.kind() == io::ErrorKind::NotFound => {
                    return Ok(Capture::Refused(conflict(PublicationConflict::EntryType)));
                }
                (_, Err(error)) => return Err(io_error(error)),
            }
            let read = if mode_only {
                ReadMode::Permissions
            } else {
                ReadMode::Required
            };
            return match Self::capture_route(root, &route.relative, read, managed) {
                Ok(target) => Ok(Capture::Ready(target)),
                Err(ToolError::Failed(_)) => Ok(Capture::Refused(conflict(
                    PublicationConflict::EntryVisibility,
                ))),
                Err(ToolError::Io {
                    kind: io::ErrorKind::NotFound,
                    ..
                }) => Ok(Capture::Refused(conflict(
                    PublicationConflict::EntryVisibility,
                ))),
                Err(error) => Err(error),
            };
        }
    }

    pub(crate) fn publication_condition(
        &mut self,
        expected: &PublicationEntry,
        cancellation: &CancellationToken,
    ) -> Result<Option<PublicationConflict>, ToolError> {
        match self.validate() {
            Ok(()) => {}
            Err(ToolError::Failed(_)) => return Ok(Some(PublicationConflict::EntryVisibility)),
            Err(error) => return Err(error),
        }
        match (expected, self.existing.as_mut()) {
            (PublicationEntry::Missing, None) => {}
            (PublicationEntry::File { content, mode }, Some(file)) => {
                #[cfg(unix)]
                {
                    use cap_std::fs::PermissionsExt;
                    if file.metadata().map_err(io_error)?.permissions().mode() & 0o7777 != *mode {
                        return Ok(Some(PublicationConflict::Mode));
                    }
                }
                file.rewind().map_err(io_error)?;
                if hash_reader(file, cancellation)? != *content {
                    return Ok(Some(PublicationConflict::Content));
                }
                file.rewind().map_err(io_error)?;
            }
            _ => return Ok(Some(PublicationConflict::EntryType)),
        }
        match self.validate() {
            Ok(()) => Ok(None),
            Err(ToolError::Failed(_)) => Ok(Some(PublicationConflict::EntryVisibility)),
            Err(error) => Err(error),
        }
    }

    #[cfg(unix)]
    pub(crate) fn apply_publication_mode(
        self,
        mode: u32,
        cancellation: &CancellationToken,
        started: &AtomicBool,
    ) -> Result<(), ToolError> {
        self.validate()?;
        check_cancelled(cancellation)?;
        let file = self
            .existing
            .as_ref()
            .expect("mode-only publication captured an existing file");
        let metadata = file.metadata().map_err(io_error)?;
        let mode = permission_mode(mode)?;
        started.store(true, Ordering::SeqCst);
        rustix::fs::fchmod(file, mode).map_err(unknown)?;
        self.visible(Some(identity(&metadata))).map_err(unknown)?;
        Ok(())
    }

    #[cfg(unix)]
    pub(crate) fn apply_publication(
        mut self,
        reader: &mut dyn PublicationContent,
        expected: &ContentRef,
        mode: u32,
        cancellation: &CancellationToken,
        started: &AtomicBool,
    ) -> Result<(), ToolError> {
        self.validate()?;
        check_cancelled(cancellation)?;
        let mode = permission_mode(mode)?;
        let mut file = match self.existing.take() {
            Some(file) => file,
            None => {
                started.store(true, Ordering::SeqCst);
                match self.parent.open_with(&self.name, &file_options(true)) {
                    Ok(file) => file,
                    Err(error)
                        if matches!(
                            error.kind(),
                            io::ErrorKind::AlreadyExists
                                | io::ErrorKind::NotFound
                                | io::ErrorKind::NotADirectory
                                | io::ErrorKind::PermissionDenied
                        ) =>
                    {
                        started.store(false, Ordering::SeqCst);
                        return Err(io_error(error));
                    }
                    Err(error) => return Err(unknown(error)),
                }
            }
        };
        let metadata = file
            .metadata()
            .map_err(|error| mutation_io(started, error))?;
        if !metadata.is_file() || (self.managed && metadata.nlink() != 1) {
            return Err(mutation_failure(
                started,
                "publication target changed after admission",
            ));
        }
        file.rewind().map_err(|error| mutation_io(started, error))?;
        let mut bytes = 0u64;
        let mut digest = sha2::Sha256::new();
        use sha2::Digest;
        let mut buffer = [0; BUFFER_BYTES];
        loop {
            let n = match reader.read(&mut buffer) {
                Ok(n) => n,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(mutation_io(started, error)),
            };
            if n == 0 {
                break;
            }
            bytes = bytes
                .checked_add(n as u64)
                .ok_or_else(|| mutation_failure(started, "publication length overflow"))?;
            if bytes > expected.bytes {
                return Err(mutation_failure(
                    started,
                    "publication content resource grew after its preflight",
                ));
            }
            digest.update(&buffer[..n]);
            started.store(true, Ordering::SeqCst);
            file.write_all(&buffer[..n]).map_err(unknown)?;
        }
        let actual = ContentRef {
            digest: finish_digest(digest),
            bytes,
        };
        if actual != *expected {
            return Err(mutation_failure(
                started,
                "publication content resource changed after its preflight",
            ));
        }
        started.store(true, Ordering::SeqCst);
        file.set_len(bytes).map_err(unknown)?;
        rustix::fs::fchmod(&file, mode).map_err(unknown)?;
        self.visible(Some(identity(&metadata))).map_err(unknown)?;
        // After the first write, drain the original mutation despite cancellation.
        Ok(())
    }
}

fn mutation_io(started: &AtomicBool, error: io::Error) -> ToolError {
    if started.load(Ordering::SeqCst) {
        unknown(error)
    } else {
        io_error(error)
    }
}
fn mutation_failure(started: &AtomicBool, diagnostic: &str) -> ToolError {
    if started.load(Ordering::SeqCst) {
        unknown(diagnostic)
    } else {
        failed(diagnostic)
    }
}

#[cfg(unix)]
fn permission_mode(mode: u32) -> Result<rustix::fs::Mode, ToolError> {
    if mode & !0o777 != 0 {
        return Err(failed("publication mode exceeds captured permission bits"));
    }
    let mode = mode
        .try_into()
        .map_err(|_| failed("publication mode is not representable on this platform"))?;
    Ok(rustix::fs::Mode::from_raw_mode(mode))
}
