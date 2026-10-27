//! Resources for Rust components (TS: `resource(source, fetcher)`): a value
//! loaded by an async task from a source, loaded again when the source
//! changes or on [`Resource::refetch`]. The bookkeeping is
//! [`crate::resource::Runs`], which the JS face shares.
//!
//! A load is a task of its own ([`super::spawn`]); a new load drops the
//! previous one's task, and so do the owner's disposal: dropping a future
//! cancels what it awaited (an HTTP request, a timer), so only the latest
//! load ever ends.

use std::{future::Future, rc::Rc};

use super::{
    ambient::{Spawned, spawn},
    reactive::{
        Signal, SignalEquals, Stored, batch, render_effect, signal, signal_with, stored, untracked,
    },
};
pub use crate::resource::ResourceState;
use crate::resource::Runs;

/// What a load is told besides the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceInfo {
    /// Started by [`Resource::refetch`] (the source did not change).
    pub refetching: bool,
}

/// A value loaded asynchronously ([`resource`]): read it, its error and its
/// state in bindings; a `Copy` handle, as signals are.
pub struct Resource<T: 'static, E: 'static> {
    value: Signal<Option<T>>,
    error: Signal<Option<E>>,
    state: Signal<ResourceState>,
    /// Written by [`Resource::refetch`], read by the load's effect.
    trigger: Signal<u64>,
    refetching: Stored<bool>,
    runs: Stored<Runs>,
}

impl<T, E> Clone for Resource<T, E> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T, E> Copy for Resource<T, E> {}

impl<T: 'static, E: 'static> Resource<T, E> {
    /// The latest value (a clone), kept while loading again and after a
    /// failure; `None` before the first; subscribing the running
    /// computation.
    pub fn get(&self) -> Option<T>
    where
        T: Clone,
    {
        self.value.get()
    }

    /// `f` of the latest value, subscribing the running computation.
    pub fn with<R>(&self, f: impl FnOnce(Option<&T>) -> R) -> R {
        self.value.with(|v| f(v.as_ref()))
    }

    /// The last load's error (a clone); `None` once a load gave a value.
    pub fn error(&self) -> Option<E>
    where
        E: Clone,
    {
        self.error.get()
    }

    /// `f` of the last load's error, subscribing the running computation.
    pub fn with_error<R>(&self, f: impl FnOnce(Option<&E>) -> R) -> R {
        self.error.with(|e| f(e.as_ref()))
    }

    /// Where it is (loading, ready, failed, ...).
    pub fn state(&self) -> ResourceState {
        self.state.get()
    }

    /// Whether a load runs.
    pub fn loading(&self) -> bool {
        self.state.get().loading()
    }

    /// Loads it again from the same source (a retry, a pull to refresh),
    /// keeping the value meanwhile.
    pub fn refetch(&self) {
        self.refetching.replace(true);
        self.trigger.update(|n| *n += 1);
    }

    /// Sets the value here, with no load (an optimistic update), clearing
    /// the last error: a load running still replaces it when it ends.
    pub fn mutate(&self, value: T) {
        let state = self.runs.with(Runs::mutate);
        batch(|| {
            self.value.set(Some(value));
            self.error.set(None);
            self.state.set(state);
        });
    }
}

/// A resource loading `fetcher(source)` whenever `source()` gives a new
/// `Some` (TS: `resource(source, fetcher)`), and when asked
/// ([`Resource::refetch`]). `source` is tracked; `None` loads nothing (a
/// user not signed in yet). Only the latest load counts: a new one drops
/// the previous one, and the owner's disposal drops the one running. For
/// a resource with no source, `|| Some(())`.
///
/// ```ignore
/// let user = resource(move || Some(id.get()), |id, _| async move { api::user(id).await });
/// text(move || match (user.get(), user.error()) {
///     (Some(user), _) => user.name,
///     (None, Some(e)) => format!("failed: {e}"),
///     _ => "loading".into(),
/// })
/// ```
pub fn resource<S, T, E, F, Fut>(
    source: impl Fn() -> Option<S> + 'static,
    fetcher: F,
) -> Resource<T, E>
where
    S: 'static,
    T: 'static,
    E: 'static,
    F: Fn(S, ResourceInfo) -> Fut + 'static,
    Fut: Future<Output = Result<T, E>> + 'static,
{
    make(None, source, fetcher)
}

/// [`resource`] holding `value` until its first load ends (TS's
/// `initialValue`): its first load is a refresh.
pub fn resource_with_value<S, T, E, F, Fut>(
    value: T,
    source: impl Fn() -> Option<S> + 'static,
    fetcher: F,
) -> Resource<T, E>
where
    S: 'static,
    T: 'static,
    E: 'static,
    F: Fn(S, ResourceInfo) -> Fut + 'static,
    Fut: Future<Output = Result<T, E>> + 'static,
{
    make(Some(value), source, fetcher)
}

fn make<S, T, E, F, Fut>(
    initial: Option<T>,
    source: impl Fn() -> Option<S> + 'static,
    fetcher: F,
) -> Resource<T, E>
where
    S: 'static,
    T: 'static,
    E: 'static,
    F: Fn(S, ResourceInfo) -> Fut + 'static,
    Fut: Future<Output = Result<T, E>> + 'static,
{
    let runs = stored(if initial.is_some() {
        Runs::with_value()
    } else {
        Runs::default()
    });
    let resource = Resource {
        value: signal_with(initial, SignalEquals::Never),
        error: signal_with(None, SignalEquals::Never),
        state: signal(runs.with(|r| r.state())),
        trigger: signal(0),
        refetching: stored(false),
        runs,
    };
    let task = stored(None::<Spawned<()>>);
    let fetcher = Rc::new(fetcher);
    // Before the bindings: what a load starts with is there when they run.
    render_effect(move || {
        resource.trigger.with(|_| ());
        let source = source();
        untracked(|| {
            let refetching = resource.refetching.replace(false);
            // The running load no longer counts: its task goes.
            drop(task.replace(None));
            let Some(source) = source else {
                resource.state.set(resource.runs.with(Runs::skip));
                return;
            };
            let (run, state) = resource.runs.with(Runs::start);
            resource.state.set(state);
            let load = fetcher(source, ResourceInfo { refetching });
            task.replace(Some(spawn(async move {
                let loaded = load.await;
                batch(|| match loaded {
                    Ok(value) => {
                        if let Some(state) = resource.runs.with(|r| r.resolve(run)) {
                            resource.value.set(Some(value));
                            resource.error.set(None);
                            resource.state.set(state);
                        }
                    }
                    Err(error) => {
                        if let Some(state) = resource.runs.with(|r| r.reject(run)) {
                            resource.error.set(Some(error));
                            resource.state.set(state);
                        }
                    }
                });
            })));
        });
    });
    resource
}
