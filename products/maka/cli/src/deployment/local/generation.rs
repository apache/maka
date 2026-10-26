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

use super::HostError;
use sha2::{Digest, Sha256};
use std::{fs::File, io, io::Read, path::PathBuf};
use tokio_util::sync::CancellationToken;

pub(super) async fn hash(launcher: PathBuf) -> Result<String, HostError> {
    hash_with(move || {
        let file = File::open(launcher)?;
        if !file.metadata()?.is_file() {
            return Err("Host launcher must be a regular file".into());
        }
        Ok(file)
    })
    .await
}

async fn hash_with<R: Read>(
    open: impl FnOnce() -> Result<R, HostError> + Send + 'static,
) -> Result<String, HostError> {
    let cancelled = CancellationToken::new();
    let _cancel_on_drop = cancelled.clone().drop_guard();
    tokio::task::spawn_blocking(move || {
        check_cancelled(&cancelled)?;
        hash_reader(&mut open()?, &cancelled)
    })
    .await?
}

fn hash_reader(reader: &mut impl Read, cancelled: &CancellationToken) -> Result<String, HostError> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        // Cancellation cannot interrupt an active filesystem read. Check again
        // when it returns, including EOF, before publishing a generation.
        check_cancelled(cancelled)?;
        let length = reader.read(&mut buffer)?;
        check_cancelled(cancelled)?;
        if length == 0 {
            break;
        }
        digest.update(&buffer[..length]);
    }
    let generation = format!("cli-sha256:{}", hex::encode(digest.finalize()));
    check_cancelled(cancelled)?;
    Ok(generation)
}

fn check_cancelled(cancelled: &CancellationToken) -> io::Result<()> {
    if cancelled.is_cancelled() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "launcher generation hashing cancelled",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tokio::sync::{OnceCell, oneshot};

    struct GatedReader {
        entered: Option<oneshot::Sender<()>>,
        release: mpsc::Receiver<()>,
        finished: Option<oneshot::Sender<usize>>,
        reads: usize,
    }

    impl Read for GatedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            if let Some(entered) = self.entered.take() {
                entered
                    .send(())
                    .map_err(|_| io::Error::from(io::ErrorKind::Interrupted))?;
                self.release
                    .recv()
                    .map_err(|_| io::Error::from(io::ErrorKind::Interrupted))?;
            }
            if self.reads <= 2 {
                buffer.fill(42);
                Ok(buffer.len())
            } else {
                Ok(0)
            }
        }
    }

    impl Drop for GatedReader {
        fn drop(&mut self) {
            if let Some(finished) = self.finished.take() {
                let _ = finished.send(self.reads);
            }
        }
    }

    #[tokio::test]
    async fn dropped_initialization_stops_reading_and_remains_retryable() {
        let (entered, reading) = oneshot::channel();
        let (release, released) = mpsc::channel();
        let (finished, settled) = oneshot::channel();
        let reader = GatedReader {
            entered: Some(entered),
            release: released,
            finished: Some(finished),
            reads: 0,
        };
        let generation = OnceCell::new();
        let mut initializing =
            Box::pin(generation.get_or_try_init(|| hash_with(move || Ok(reader))));
        tokio::select! {
            result = &mut initializing => panic!("gated hash completed before release: {result:?}"),
            result = reading => result.unwrap(),
        }
        drop(initializing);
        release.send(()).unwrap();
        assert_eq!(settled.await.unwrap(), 1);
        assert!(generation.get().is_none());

        let complete = generation
            .get_or_try_init(|| hash_with(|| Ok(io::Cursor::new(b"abc"))))
            .await
            .unwrap();
        assert_eq!(
            complete,
            "cli-sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn cancellation_during_eof_never_returns_a_generation() {
        struct CancelAtEof(CancellationToken);
        impl Read for CancelAtEof {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                self.0.cancel();
                Ok(0)
            }
        }
        let cancelled = CancellationToken::new();
        let error = hash_reader(&mut CancelAtEof(cancelled.clone()), &cancelled).unwrap_err();
        assert_eq!(
            error.downcast_ref::<io::Error>().unwrap().kind(),
            io::ErrorKind::Interrupted
        );
    }

    #[tokio::test]
    async fn regular_launcher_hashes_every_chunk_and_caches_only_success() {
        let directory = tempfile::tempdir().unwrap();
        let launcher = directory.path().join("launcher");
        let bytes: Vec<u8> = (0..(64 * 1024 + 17)).map(|n| (n % 251) as u8).collect();
        std::fs::write(&launcher, &bytes).unwrap();
        let generation = OnceCell::new();
        assert!(
            generation
                .get_or_try_init(|| hash(directory.path().to_owned()))
                .await
                .is_err()
        );
        assert!(generation.get().is_none());
        let expected = format!("cli-sha256:{}", hex::encode(Sha256::digest(&bytes)));
        assert_eq!(
            generation
                .get_or_try_init(|| hash(launcher.clone()))
                .await
                .unwrap(),
            &expected
        );
        std::fs::remove_file(launcher).unwrap();
        assert_eq!(
            generation
                .get_or_try_init(|| hash(directory.path().to_owned()))
                .await
                .unwrap(),
            &expected
        );
    }
}
