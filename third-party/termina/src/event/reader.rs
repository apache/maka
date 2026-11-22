//! Thread-safe terminal event reader.
//!
//! This module provides an `Arc<Mutex<T>>` wrapper around the platform event source. That lets a
//! reader live on a terminal handle and also be shared with the optional async stream, rather than
//! being stored globally.
//!
//! # Implementation Notes
//!
//! This is adapted from [crossterm's event reader]. The shared reader is mostly an
//! `Arc<Mutex<T>>` wrapper around the same shape as crossterm's internal event reader. This lets
//! it live on a [`Terminal`] and on an `EventStream` instead of being stored globally. Termina uses
//! `Fn(&Event) -> bool` filters instead of a dedicated filter trait so callers can pass ordinary
//! closures.
//!
//! [crossterm's event reader]: https://docs.rs/crossterm/latest/crossterm/event/index.html
//! [`Terminal`]: crate::Terminal

use std::{collections::VecDeque, io, sync::Arc, time::Duration};

use parking_lot::Mutex;

use super::{
    source::{EventSource as _, PlatformEventSource, PlatformWaker, PollTimeout},
    Event,
};

/// A reader of events from the terminal's input handle.
///
/// Note that this type wraps an `Arc` and is cheap to clone. If the `event-stream` feature is
/// enabled then this value should be passed to `EventStream::new`.
///
/// [`Self::read`] and [`Self::poll`] both take filters. Events rejected by a filter remain buffered
/// so a caller can wait for a key press without discarding protocol responses, mouse events, or
/// other input that another part of the application may read later. Filtering preserves rejected
/// events for later reads, but callers should not rely on rejected events being re-buffered in exact
/// stream order across multiple filtered reads.
///
/// # Examples
///
/// Read every event and branch on the event kind:
///
/// ```no_run
/// use std::io;
///
/// use termina::{
///     event::{Event, KeyCode, KeyEventKind},
///     PlatformTerminal, Terminal,
/// };
///
/// fn main() -> io::Result<()> {
///     let reader = PlatformTerminal::new()?.event_reader();
///     loop {
///         let event = reader.read(|_| true)?;
///         match event {
///             Event::Key(key)
///                 if key.kind == KeyEventKind::Press && key.code == KeyCode::Char('q') =>
///             {
///                 break
///             }
///             Event::Mouse(mouse) => eprintln!("mouse at {},{}", mouse.column, mouse.row),
///             Event::Csi(csi) => eprintln!("CSI response: {csi:?}"),
///             _ => {}
///         }
///     }
///     Ok(())
/// }
/// ```
///
/// Use a filter when a call should wait for a specific class of event:
///
/// ```no_run
/// use std::io;
///
/// use termina::{
///     event::{Event, KeyEventKind},
///     PlatformTerminal, Terminal,
/// };
///
/// fn main() -> io::Result<()> {
///     let reader = PlatformTerminal::new()?.event_reader();
///     let event = reader.read(|event| {
///         matches!(event, Event::Key(key) if key.kind == KeyEventKind::Press)
///     })?;
///     println!("received {event:?}");
///     Ok(())
/// }
/// ```
#[derive(Debug, Clone)]
pub struct EventReader {
    shared: Arc<Mutex<Shared>>,
    waker: PlatformWaker,
}

impl EventReader {
    /// Limits bytes retained for one incomplete input sequence, including bracketed paste.
    ///
    /// The default is unlimited. A nonzero limit applies to the shared input source, not to
    /// the total bytes of completed events in one read. Exceeding it returns a sticky input
    /// error; stop the reader rather than replaying a rejected sequence's tail as key input.
    /// Parsing checks before appending each byte; the rejected byte and its tail are not retained.
    pub fn set_max_pending_bytes(&self, limit: usize) -> io::Result<()> {
        self.shared.lock().source.set_max_pending_bytes(limit)
    }

    pub(crate) fn new(source: PlatformEventSource) -> Self {
        let waker = source.waker();
        let shared = Shared {
            events: VecDeque::with_capacity(32),
            source,
            skipped_events: Vec::with_capacity(32),
        };
        Self {
            shared: Arc::new(Mutex::new(shared)),
            waker,
        }
    }

    /// Returns a platform-specific waker that can unblock [`poll`](Self::poll),
    /// [`read`](Self::read), and [`wait_ready`](Self::wait_ready) calls.
    ///
    /// The waker is cheap to clone and can be freely moved to another thread. Calling its
    /// `wake` method does not require the calling thread to hold the [`EventReader`]'s internal
    /// lock, so it can be called while a [`read`](Self::read) or [`poll`](Self::poll) call is
    /// blocked on another thread or clone of this reader. A woken [`read`](Self::read) call
    /// returns `Err` with [`io::ErrorKind::Interrupted`].
    pub fn waker(&self) -> PlatformWaker {
        self.waker.clone()
    }

    /// Waits for input readiness without reading, decoding, or removing input.
    ///
    /// Already buffered events return immediately. Otherwise this waits for the original input
    /// handle, a resize notification, a parser reply deadline, or [`Self::waker`]. Readiness is
    /// advisory: the next nonblocking [`Self::poll`] may find no complete event. Parser deadlines
    /// are checked by that later poll, rather than changing parser state while waiting here.
    /// A waker interrupts the wait with [`io::ErrorKind::Interrupted`].
    pub fn wait_ready(&self) -> io::Result<()> {
        let mut reader = self.shared.lock();
        if !reader.events.is_empty() || !reader.skipped_events.is_empty() {
            return Ok(());
        }
        reader.source.wait_ready()
    }

    /// Polls for availability of an event matching `filter`.
    ///
    /// When `timeout` is `None`, this call blocks indefinitely. Events rejected by `filter` are
    /// retained so a later call can still return them. Use the same filter with [`Self::read`] if
    /// the follow-up read should consume the event that made this method return `true`.
    pub fn poll<F>(&self, timeout: Option<Duration>, filter: F) -> io::Result<bool>
    where
        F: FnMut(&Event) -> bool,
    {
        let (mut reader, timeout) = if let Some(timeout) = timeout {
            let poll_timeout = PollTimeout::new(Some(timeout));
            if let Some(reader) = self.shared.try_lock_for(timeout) {
                (reader, poll_timeout.leftover())
            } else {
                return Ok(false);
            }
        } else {
            (self.shared.lock(), None)
        };
        reader.poll(timeout, filter)
    }

    /// Blocks until an event matching `filter` is available.
    ///
    /// Events rejected by `filter` are retained for later reads. For keyboard shortcuts, filter on
    /// `Event::Key(key) if key.kind == KeyEventKind::Press` unless the application intentionally
    /// handles release or repeat events.
    ///
    /// Returns `Err` with [`io::ErrorKind::Interrupted`] if [`Self::waker`]'s `wake` is called
    /// while this call is blocked.
    pub fn read<F>(&self, filter: F) -> io::Result<Event>
    where
        F: FnMut(&Event) -> bool,
    {
        let mut reader = self.shared.lock();
        reader.read(filter)
    }
}

#[derive(Debug)]
struct Shared {
    events: VecDeque<Event>,
    source: PlatformEventSource,
    skipped_events: Vec<Event>,
}

impl Shared {
    fn poll<F>(&mut self, timeout: Option<Duration>, mut filter: F) -> io::Result<bool>
    where
        F: FnMut(&Event) -> bool,
    {
        if self.events.iter().any(&mut (filter)) {
            return Ok(true);
        }

        let timeout = PollTimeout::new(timeout);

        loop {
            let maybe_event = match self.source.try_read(timeout.leftover()) {
                Ok(None) => None,
                Ok(Some(event)) => {
                    if (filter)(&event) {
                        Some(event)
                    } else {
                        self.skipped_events.push(event);
                        None
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => return Ok(false),
                Err(err) => return Err(err),
            };

            if timeout.elapsed() || maybe_event.is_some() {
                self.events.extend(self.skipped_events.drain(..));

                if let Some(event) = maybe_event {
                    self.events.push_front(event);
                    return Ok(true);
                }

                return Ok(false);
            }
        }
    }

    fn read<F>(&mut self, mut filter: F) -> io::Result<Event>
    where
        F: FnMut(&Event) -> bool,
    {
        let mut skipped_events = VecDeque::new();

        loop {
            while let Some(event) = self.events.pop_front() {
                if (filter)(&event) {
                    self.events.extend(skipped_events.drain(..));
                    return Ok(event);
                } else {
                    skipped_events.push_back(event);
                }
            }
            // With `timeout: None`, `poll` only returns `Ok(false)` when a waker interrupted it
            // (its internal timeout can never elapse), so this unambiguously means "woken up."
            if !self.poll(None, &mut filter)? {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "read operation was woken up",
                ));
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{event::KeyCode, terminal::FileDescriptor};
    use std::{
        io::{Read, Write},
        os::unix::net::UnixStream,
        sync::mpsc,
        thread,
    };

    fn fixture() -> (EventReader, UnixStream, UnixStream) {
        let (input, peer) = UnixStream::pair().unwrap();
        let probe = input.try_clone().unwrap();
        let write = FileDescriptor::Owned(input.try_clone().unwrap().into());
        let read = FileDescriptor::Owned(input.into());
        let source = super::super::source::UnixEventSource::new(read, write).unwrap();
        (EventReader::new(source), peer, probe)
    }

    fn wait(reader: &EventReader) -> io::Result<()> {
        let waiting = reader.clone();
        let (finished, result) = mpsc::channel();
        let task = thread::spawn(move || {
            let _ = finished.send(waiting.wait_ready());
        });
        // A deadlock watchdog, not an input-latency expectation. Wake before unwinding on failure.
        let result = result
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| {
                let _ = reader.waker().wake();
                panic!("readiness wait did not finish: {error}");
            });
        task.join().unwrap();
        result
    }

    #[test]
    fn readiness_preserves_os_input_and_both_buffered_event_queues() {
        let (reader, mut peer, mut probe) = fixture();
        probe
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        peer.write_all("你好".as_bytes()).unwrap();
        wait(&reader).unwrap();
        let mut bytes = [0; 6];
        probe.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, "你好".as_bytes());

        peer.write_all(b"ab").unwrap();
        assert!(reader.poll(Some(Duration::ZERO), |_| true).unwrap());
        wait(&reader).unwrap();
        assert_eq!(
            reader.read(|_| true).unwrap(),
            Event::Key(KeyCode::Char('a').into())
        );
        // The OS bytes and reader queue are now empty, but the parser still owns 'b'.
        wait(&reader).unwrap();
        assert_eq!(
            reader.read(|_| true).unwrap(),
            Event::Key(KeyCode::Char('b').into())
        );
        assert!(!reader.poll(Some(Duration::ZERO), |_| true).unwrap());
    }

    #[test]
    fn readiness_accepts_prewake_and_concurrent_cancel_without_reader_lock() {
        let (reader, _peer, _probe) = fixture();
        reader.waker().wake().unwrap();
        assert_eq!(
            wait(&reader).unwrap_err().kind(),
            io::ErrorKind::Interrupted
        );

        let waiting = reader.clone();
        let (started, starting) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let task = thread::spawn(move || {
            started.send(()).unwrap();
            let _ = finished.send(waiting.wait_ready());
        });
        starting.recv().unwrap();
        // This also permits cancellation to win the check-to-wait race.
        reader.waker().wake().unwrap();
        let result = result
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_else(|error| {
                let _ = reader.waker().wake();
                panic!("cancel did not finish the readiness wait: {error}");
            });
        task.join().unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
    }

    #[test]
    fn readiness_preserves_filtered_events_after_poll_is_interrupted() {
        let (reader, mut peer, _probe) = fixture();
        peer.write_all(b"a").unwrap();
        reader.waker().wake().unwrap();
        // The input is parsed first, then the original waker interrupts the filtered poll.
        assert!(!reader.poll(None, |_| false).unwrap());
        wait(&reader).unwrap();
        reader.poll(Some(Duration::ZERO), |_| true).unwrap();
        assert_eq!(
            reader.read(|_| true).unwrap(),
            Event::Key(KeyCode::Char('a').into())
        );
    }

    #[test]
    fn readiness_keeps_reply_expiration_in_the_following_poll_and_reports_closed_input() {
        let (reader, mut peer, _probe) = fixture();
        peer.write_all(b"\x1b_Gi=31;").unwrap();
        assert!(!reader.poll(Some(Duration::ZERO), |_| true).unwrap());
        wait(&reader).unwrap();
        assert_eq!(
            reader
                .poll(Some(Duration::ZERO), |_| true)
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        // The sticky failure is also ready; waiting must not restart its original deadline.
        wait(&reader).unwrap();
        assert_eq!(
            reader
                .poll(Some(Duration::ZERO), |_| true)
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );

        let (closed, peer, _probe) = fixture();
        drop(peer);
        wait(&closed).unwrap();
        assert_eq!(
            closed
                .poll(Some(Duration::ZERO), |_| true)
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }
}
