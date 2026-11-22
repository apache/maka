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

#[cfg(target_os = "linux")]
use maka_sandbox::launch::MountLease;
use std::io;

/// Native wait is cancellation-safe: a dropped waiter cannot detach cleanup
/// from the next waiter or turn a failed cleanup into a successful exit fence.
pub(crate) enum Cleanup {
    Pending(Box<dyn FnOnce() -> io::Result<()> + Send + Sync>),
    Running(tokio::task::JoinHandle<io::Result<()>>),
    Complete,
    Failed(String),
}
#[cfg(target_os = "linux")]
impl From<Option<MountLease>> for Cleanup {
    fn from(lease: Option<MountLease>) -> Self {
        lease.map_or(Self::Complete, |lease| {
            Self::new(move || lease.finish().map_err(io::Error::other))
        })
    }
}
impl Cleanup {
    pub fn new(finish: impl FnOnce() -> io::Result<()> + Send + Sync + 'static) -> Self {
        Self::Pending(Box::new(finish))
    }

    pub async fn finish(&mut self) -> io::Result<()> {
        if matches!(self, Self::Pending(_)) {
            let Self::Pending(lease) = std::mem::replace(self, Self::Complete) else {
                unreachable!()
            };
            *self = Self::Running(tokio::task::spawn_blocking(lease));
        }
        if let Self::Running(worker) = self {
            let result = worker
                .await
                .map_err(io::Error::other)
                .and_then(|result| result.map_err(io::Error::other));
            *self = match result {
                Ok(()) => Self::Complete,
                Err(error) => Self::Failed(error.to_string()),
            };
        }
        match self {
            Self::Complete => Ok(()),
            Self::Failed(error) => Err(io::Error::other(error.clone())),
            _ => unreachable!("cleanup worker was awaited"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_waiter_cannot_hide_cleanup_failure_from_later_waiters() {
        let (finish, release) = tokio::sync::oneshot::channel();
        let mut cleanup = Cleanup::Running(tokio::spawn(async move {
            release.await.unwrap();
            Err(io::Error::other("mount cleanup incomplete"))
        }));
        {
            let wait = cleanup.finish();
            tokio::pin!(wait);
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(wait.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
        }
        finish.send(()).unwrap();
        for _ in 0..2 {
            assert!(
                cleanup
                    .finish()
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("mount cleanup incomplete")
            );
        }
    }
}
