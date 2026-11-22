//! Functions an app runs on the platform's main thread
//! ([`crate::element::run_on_main_thread`]): the engine hands each to its
//! surface's `MountSink` after the commit of the turn that asked for it,
//! and the platform runs it on its UI thread after that commit's batch.

use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};

/// A function to run once on the platform's main thread. The platform calls
/// [`MainThreadTask::run`] there.
pub struct MainThreadTask(Box<dyn FnOnce() + Send>);

impl MainThreadTask {
    /// `f`, to run on the main thread.
    pub(crate) fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self(Box::new(f))
    }

    /// Runs it, here. A panic in it is caught and logged: it never unwinds
    /// through the platform's run loop.
    pub fn run(self) {
        let task = self.0;
        if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(task)) {
            log::error!(
                "a function run on the main thread panicked: {}",
                crate::element::panic_message(payload)
            );
        }
    }
}

impl fmt::Debug for MainThreadTask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MainThreadTask")
    }
}

/// Why an [`OnMainThread`] has no value.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum MainThreadError {
    /// The function panicked, with this message.
    Panicked(String),
    /// The function never ran: its surface went away first.
    Dropped,
}

impl fmt::Display for MainThreadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Panicked(message) => write!(f, "the main thread's function panicked: {message}"),
            Self::Dropped => f.write_str("the main thread's function never ran"),
        }
    }
}

impl std::error::Error for MainThreadError {}

struct Shared<R> {
    value: Option<Result<R, MainThreadError>>,
    waker: Option<Waker>,
}

/// The result of a function run on the main thread
/// ([`crate::element::run_on_main_thread`]): await it on the engine thread.
/// Dropping it does not stop the function.
pub struct OnMainThread<R> {
    shared: Arc<Mutex<Shared<R>>>,
}

impl<R> fmt::Debug for OnMainThread<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OnMainThread")
    }
}

impl<R> Future for OnMainThread<R> {
    type Output = Result<R, MainThreadError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut shared = self.shared.lock().expect("main thread result lock");
        match shared.value.take() {
            Some(value) => Poll::Ready(value),
            None => {
                shared.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

/// Answers an [`OnMainThread`] once; dropped unanswered, it answers
/// [`MainThreadError::Dropped`].
struct Answer<R>(Option<Arc<Mutex<Shared<R>>>>);

impl<R> Answer<R> {
    fn send(&mut self, value: Result<R, MainThreadError>) {
        let Some(shared) = self.0.take() else { return };
        let waker = {
            let mut shared = shared.lock().expect("main thread result lock");
            shared.value = Some(value);
            shared.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl<R> Drop for Answer<R> {
    fn drop(&mut self) {
        self.send(Err(MainThreadError::Dropped));
    }
}

/// `f` as a task for the main thread, and the future of its result.
pub(crate) fn task<R: Send + 'static>(
    f: impl FnOnce() -> R + Send + 'static,
) -> (MainThreadTask, OnMainThread<R>) {
    let shared = Arc::new(Mutex::new(Shared {
        value: None,
        waker: None,
    }));
    let mut answer = Answer(Some(shared.clone()));
    let task = MainThreadTask::new(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
            .map_err(|payload| MainThreadError::Panicked(crate::element::panic_message(payload)));
        answer.send(result);
    });
    (task, OnMainThread { shared })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poll<R>(future: &mut OnMainThread<R>) -> Poll<Result<R, MainThreadError>> {
        Pin::new(future).poll(&mut Context::from_waker(Waker::noop()))
    }

    #[test]
    fn a_task_answers_its_value_its_panic_or_that_it_never_ran() {
        let (run, mut value) = task(|| 6 * 7);
        assert!(poll(&mut value).is_pending());
        std::thread::spawn(move || run.run()).join().unwrap();
        assert_eq!(poll(&mut value), Poll::Ready(Ok(42)));

        let (run, mut panicked) = task(|| -> u8 { panic!("boom") });
        run.run();
        assert_eq!(
            poll(&mut panicked),
            Poll::Ready(Err(MainThreadError::Panicked("boom".into())))
        );

        let (run, mut dropped) = task(|| ());
        drop(run);
        assert_eq!(
            poll(&mut dropped),
            Poll::Ready(Err(MainThreadError::Dropped))
        );
    }
}
