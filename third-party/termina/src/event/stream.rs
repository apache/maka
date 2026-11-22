//! Futures [`Stream`] adapter for terminal events.
//!
//! This module is available with the `event-stream` feature. It adapts the blocking
//! [`EventReader`] API into a stream by parking a helper thread on the platform event source and
//! waking the async task when matching input arrives.
//!
//! # Implementation Notes
//!
//! This is intentionally close to [crossterm's event stream]. The Termina-specific part is the
//! shared [`EventReader`], which was added so the same reader model could support downstream
//! integration tests as well as normal terminal event streams.
//!
//! [crossterm's event stream]: https://docs.rs/crossterm/latest/crossterm/event/

use std::{
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
        Arc,
    },
    task::{Context, Poll},
    thread,
    time::Duration,
};

use futures_core::Stream;

use super::{reader::EventReader, source::PlatformWaker, Event};

/// A stream of [`Event`] values received from the terminal.
///
/// This type is only available if the `event-stream` feature is enabled.
///
/// Create an event stream for a terminal by passing the reader from
/// [`crate::Terminal::event_reader`] into [`EventStream::new`] with a filter.
///
/// # Examples
///
/// Requires the `event-stream` feature and an async runtime.
///
/// ```ignore
/// use futures_lite::StreamExt as _;
/// use termina::{Event, EventStream, PlatformTerminal, Terminal};
///
/// # async fn demo() -> std::io::Result<()> {
/// let reader = PlatformTerminal::new()?.event_reader();
/// let mut stream = EventStream::new(reader, |_| true);
/// while let Some(Ok(event)) = stream.next().await {
///     if matches!(event, Event::FocusOut) {
///         break;
///     }
/// }
/// # Ok(())
/// # }
/// ```
pub struct EventStream {
    waker: PlatformWaker,
    filter: Arc<dyn Fn(&Event) -> bool>,
    reader: EventReader,
    stream_wake_task_executed: Arc<AtomicBool>,
    stream_wake_task_should_shutdown: Arc<AtomicBool>,
    task_sender: SyncSender<Task>,
}

/// Internal task handed to the helper thread managing the blocking poll.
#[derive(Debug)]
struct Task {
    stream_waker: std::task::Waker,
    stream_wake_task_executed: Arc<AtomicBool>,
    stream_wake_task_should_shutdown: Arc<AtomicBool>,
}

impl EventStream {
    /// Creates a stream backed by `reader` that only yields events accepted by `filter`.
    pub fn new<F>(reader: EventReader, filter: F) -> Self
    where
        F: Fn(&Event) -> bool + Send + Sync + 'static,
    {
        let filter = Arc::new(filter);
        let waker = reader.waker();

        let (task_sender, receiver) = mpsc::sync_channel::<Task>(1);

        let task_reader = reader.clone();
        let task_filter = filter.clone();
        thread::spawn(move || {
            while let Ok(task) = receiver.recv() {
                loop {
                    if let Ok(true) = task_reader.poll(None, &*task_filter) {
                        break;
                    }
                    if task.stream_wake_task_should_shutdown.load(Ordering::SeqCst) {
                        break;
                    }
                }
                task.stream_wake_task_executed
                    .store(false, Ordering::SeqCst);
                task.stream_waker.wake();
            }
        });

        Self {
            waker,
            filter,
            reader,
            stream_wake_task_executed: Default::default(),
            stream_wake_task_should_shutdown: Default::default(),
            task_sender,
        }
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        self.stream_wake_task_should_shutdown
            .store(true, Ordering::SeqCst);
        let _ = self.waker.wake();
    }
}

impl Stream for EventStream {
    type Item = io::Result<Event>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self
            .reader
            .poll(Some(Duration::from_secs(0)), &*self.filter)
        {
            Ok(true) => match self.reader.read(&*self.filter) {
                Ok(event) => Poll::Ready(Some(Ok(event))),
                Err(err) => Poll::Ready(Some(Err(err))),
            },
            Ok(false) => {
                if !self
                    .stream_wake_task_executed
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .unwrap_or_else(|x| x)
                {
                    self.stream_wake_task_should_shutdown
                        .store(false, Ordering::SeqCst);
                    let _ = self.task_sender.send(Task {
                        stream_waker: cx.waker().clone(),
                        stream_wake_task_executed: self.stream_wake_task_executed.clone(),
                        stream_wake_task_should_shutdown: self
                            .stream_wake_task_should_shutdown
                            .clone(),
                    });
                }
                Poll::Pending
            }
            Err(err) => Poll::Ready(Some(Err(err))),
        }
    }
}
