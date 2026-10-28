//! Data a runtime keeps out of its binary and loads when something first
//! needs it. The web runtime leaves out the syntaxes that the highlighting
//! of `TextView`, the `Editor` and `DiffView` parses code with
//! (`nsh-syntaxes.bin`, 0.9 MB every page would download with `nsh.wasm`
//! otherwise): the page fetches the file on the first [`load`]. The native
//! runtimes keep such data in their binaries and set no loader, so a
//! [`load`] there answers `None` at once.
//!
//! One loader serves the whole runtime (on the web, one WebAssembly
//! instance): the data is the same for every engine, as the syntaxes
//! deserialized from it are.

use std::{
    future::Future,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    task::{Context, Poll, Waker},
};

/// The runtime's loader and what each name it was asked for became.
static REGISTRY: Mutex<Registry> = Mutex::new(Registry::new());

/// The data named `name`: the first call asks the platform's loader for
/// it, every later one shares what arrived. `None` when the runtime has no
/// loader, the platform has no such data or loading it failed.
pub fn load(name: &str) -> impl Future<Output = Option<Arc<[u8]>>> + Send + 'static {
    let name = name.to_owned();
    std::future::poll_fn(move |cx| {
        let loader = match registry().poll(&name, cx) {
            Polled::Ready(bytes) => return Poll::Ready(bytes),
            Polled::Pending => return Poll::Pending,
            Polled::Start(loader) => loader,
        };
        // Outside the lock: a loader may deliver before it returns.
        loader(&name);
        match registry().poll(&name, cx) {
            Polled::Ready(bytes) => Poll::Ready(bytes),
            Polled::Pending | Polled::Start(_) => Poll::Pending,
        }
    })
}

/// Sets how this runtime loads data: `loader` starts loading the name it
/// is given, and the platform hands what arrives to [`deliver`]. The web
/// runtime sets one as it starts.
pub fn set_loader(loader: fn(&str)) {
    registry().loader = Some(loader);
}

/// Hands over what loading `name` gave: its bytes, or `None` when there
/// are none or loading failed. Every [`load`] waiting for it wakes, and
/// later ones get the same answer at once.
pub fn deliver(name: &str, bytes: Option<Vec<u8>>) {
    let wakers = registry().deliver(name, bytes.map(Arc::from));
    for waker in wakers {
        waker.wake();
    }
}

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What one name's data is.
enum Entry {
    /// Asked for: the tasks to wake when it arrives.
    Loading(Vec<Waker>),
    /// Arrived (`None`: there is none).
    Done(Option<Arc<[u8]>>),
}

/// What [`Registry::poll`] found.
enum Polled {
    Ready(Option<Arc<[u8]>>),
    Pending,
    /// Nothing asked for the name before: the loader to start.
    Start(fn(&str)),
}

struct Registry {
    loader: Option<fn(&str)>,
    /// A few names at most: a list is enough.
    entries: Vec<(String, Entry)>,
}

impl Registry {
    const fn new() -> Self {
        Registry {
            loader: None,
            entries: Vec::new(),
        }
    }

    fn entry(&mut self, name: &str) -> Option<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|(n, _)| n == name)
            .map(|(_, entry)| entry)
    }

    fn poll(&mut self, name: &str, cx: &Context<'_>) -> Polled {
        match self.entry(name) {
            Some(Entry::Done(bytes)) => Polled::Ready(bytes.clone()),
            Some(Entry::Loading(wakers)) => {
                if !wakers.iter().any(|w| w.will_wake(cx.waker())) {
                    wakers.push(cx.waker().clone());
                }
                Polled::Pending
            }
            None => match self.loader {
                Some(loader) => {
                    self.entries
                        .push((name.to_owned(), Entry::Loading(vec![cx.waker().clone()])));
                    Polled::Start(loader)
                }
                None => Polled::Ready(None),
            },
        }
    }

    /// Records what arrived for `name`; the tasks to wake.
    fn deliver(&mut self, name: &str, bytes: Option<Arc<[u8]>>) -> Vec<Waker> {
        match self.entry(name) {
            Some(entry) => match std::mem::replace(entry, Entry::Done(bytes)) {
                Entry::Loading(wakers) => wakers,
                Entry::Done(_) => Vec::new(),
            },
            None => {
                self.entries.push((name.to_owned(), Entry::Done(bytes)));
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        task::{Context, Wake, Waker},
    };

    use super::{Polled, Registry};

    /// Counts its wakes.
    #[derive(Default)]
    struct Count(AtomicUsize);

    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn loader(_: &str) {}

    #[test]
    fn a_runtime_without_a_loader_has_no_data() {
        let mut registry = Registry::new();
        let cx = Context::from_waker(Waker::noop());
        assert!(matches!(
            registry.poll("syntaxes", &cx),
            Polled::Ready(None)
        ));
    }

    #[test]
    fn a_name_is_asked_for_once_and_its_data_shared() {
        let mut registry = Registry::new();
        registry.loader = Some(loader);
        let count = Arc::new(Count::default());
        let waker = Waker::from(count.clone());
        let cx = Context::from_waker(&waker);
        assert!(matches!(registry.poll("syntaxes", &cx), Polled::Start(_)));
        // Another task waits; the first one again is not added twice.
        let other = Arc::new(Count::default());
        let other_waker = Waker::from(other.clone());
        assert!(matches!(
            registry.poll("syntaxes", &Context::from_waker(&other_waker)),
            Polled::Pending
        ));
        assert!(matches!(registry.poll("syntaxes", &cx), Polled::Pending));
        let wakers = registry.deliver("syntaxes", Some(Arc::from(&b"data"[..])));
        assert_eq!(wakers.len(), 2);
        wakers.into_iter().for_each(Waker::wake);
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
        assert_eq!(other.0.load(Ordering::SeqCst), 1);
        match registry.poll("syntaxes", &cx) {
            Polled::Ready(Some(bytes)) => assert_eq!(&*bytes, b"data"),
            _ => panic!("the delivered data"),
        }
    }

    #[test]
    fn a_failed_load_answers_none_without_asking_again() {
        let mut registry = Registry::new();
        registry.loader = Some(loader);
        let cx = Context::from_waker(Waker::noop());
        assert!(matches!(registry.poll("syntaxes", &cx), Polled::Start(_)));
        assert!(registry.deliver("syntaxes", None).len() == 1);
        assert!(matches!(
            registry.poll("syntaxes", &cx),
            Polled::Ready(None)
        ));
    }

    #[test]
    fn data_delivered_unasked_is_kept() {
        let mut registry = Registry::new();
        assert!(
            registry
                .deliver("syntaxes", Some(Arc::from(&b"x"[..])))
                .is_empty()
        );
        let cx = Context::from_waker(Waker::noop());
        assert!(matches!(
            registry.poll("syntaxes", &cx),
            Polled::Ready(Some(_))
        ));
    }
}
