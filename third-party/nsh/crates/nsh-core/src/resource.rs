//! What a resource is and how its loads go (TS: `resource(source,
//! fetcher)`, Rust: [`crate::element::resource`]): a value loaded asynchronously
//! from a source, loaded again when the source changes or when asked.
//!
//! Both faces keep their value, error and state in signals of their own
//! graph and leave the bookkeeping to [`Runs`]: which load is the latest,
//! what a load that ends changes, and that a load superseded by another
//! (or ended with its owner) changes nothing. The semantics are Solid's
//! `createResource`, except that reading a failed resource gives its error
//! through `error()` instead of throwing, and that a load it no longer
//! waits for is cancelled.

/// Where a resource is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ResourceState {
    /// Nothing loaded and nothing loading (its source is not set).
    #[default]
    Unresolved,
    /// Loading, with no value yet.
    Pending,
    /// A value, and nothing loading.
    Ready,
    /// Loading again, with the last value kept.
    Refreshing,
    /// The last load failed.
    Errored,
}

impl ResourceState {
    /// Its name in TS (`"unresolved"`, `"pending"`, ...).
    pub fn name(self) -> &'static str {
        match self {
            ResourceState::Unresolved => "unresolved",
            ResourceState::Pending => "pending",
            ResourceState::Ready => "ready",
            ResourceState::Refreshing => "refreshing",
            ResourceState::Errored => "errored",
        }
    }

    /// Whether a load is running.
    pub fn loading(self) -> bool {
        matches!(self, ResourceState::Pending | ResourceState::Refreshing)
    }
}

/// A load of a resource ([`Runs::start`]): what its end is reported with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Run(u64);

impl Run {
    /// Its number, to carry through a JS callback.
    pub fn to_bits(self) -> u64 {
        self.0
    }

    /// The run numbered `bits` ([`Run::to_bits`]).
    pub fn from_bits(bits: u64) -> Self {
        Run(bits)
    }
}

/// The loads of a resource: the latest one, and whether a value was ever
/// loaded (or set).
#[derive(Debug, Default)]
pub struct Runs {
    current: u64,
    running: bool,
    has_value: bool,
    state: ResourceState,
}

impl Runs {
    /// The runs of a resource with a value already (`initialValue`): its
    /// first load is a refresh.
    pub fn with_value() -> Self {
        Runs {
            has_value: true,
            state: ResourceState::Ready,
            ..Runs::default()
        }
    }

    /// Its state now.
    pub fn state(&self) -> ResourceState {
        self.state
    }

    /// A new load, superseding any running one; its state is the
    /// resource's from now on.
    pub fn start(&mut self) -> (Run, ResourceState) {
        self.current += 1;
        self.running = true;
        self.state = if self.has_value {
            ResourceState::Refreshing
        } else {
            ResourceState::Pending
        };
        (Run(self.current), self.state)
    }

    /// The source is not set: no load, and any running one is superseded.
    pub fn skip(&mut self) -> ResourceState {
        self.cancel();
        self.state = if self.has_value {
            ResourceState::Ready
        } else {
            ResourceState::Unresolved
        };
        self.state
    }

    /// The running load no longer counts (its owner went away, or the
    /// resource is about to load again): its end changes nothing.
    pub fn cancel(&mut self) {
        self.current += 1;
        self.running = false;
    }

    /// `run` gave a value: the new state, or `None` when it no longer
    /// counts (the value is dropped).
    pub fn resolve(&mut self, run: Run) -> Option<ResourceState> {
        self.end(run)?;
        self.has_value = true;
        self.state = ResourceState::Ready;
        Some(self.state)
    }

    /// `run` failed: the new state (the value stays), or `None` when it no
    /// longer counts.
    pub fn reject(&mut self, run: Run) -> Option<ResourceState> {
        self.end(run)?;
        self.state = ResourceState::Errored;
        Some(self.state)
    }

    /// The value was set directly (`mutate`): a running load goes on and
    /// replaces it when it ends.
    pub fn mutate(&mut self) -> ResourceState {
        self.has_value = true;
        if !self.running {
            self.state = ResourceState::Ready;
        }
        self.state
    }

    fn end(&mut self, run: Run) -> Option<()> {
        if !self.running || run.0 != self.current {
            return None;
        }
        self.running = false;
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::{ResourceState::*, *};

    #[test]
    fn loads_go_from_pending_to_ready_and_refresh_with_the_value_kept() {
        let mut runs = Runs::default();
        assert_eq!(runs.state(), Unresolved);
        let (first, state) = runs.start();
        assert_eq!(state, Pending);
        assert!(state.loading());
        assert_eq!(runs.resolve(first), Some(Ready));
        let (second, state) = runs.start();
        assert_eq!(state, Refreshing);
        assert_eq!(runs.reject(second), Some(Errored));
        // A retry after a failure with a value is a refresh too.
        let (third, state) = runs.start();
        assert_eq!(state, Refreshing);
        assert_eq!(runs.resolve(third), Some(Ready));
    }

    #[test]
    fn only_the_latest_load_counts() {
        let mut runs = Runs::default();
        let (slow, _) = runs.start();
        let (fast, _) = runs.start();
        assert_eq!(runs.resolve(fast), Some(Ready));
        // The superseded load ends later: nothing changes.
        assert_eq!(runs.resolve(slow), None);
        assert_eq!(runs.reject(slow), None);
        // A load that already ended does not end twice.
        assert_eq!(runs.reject(fast), None);
        assert_eq!(runs.state(), Ready);
    }

    #[test]
    fn a_cancelled_or_skipped_load_changes_nothing() {
        let mut runs = Runs::default();
        let (run, _) = runs.start();
        runs.cancel();
        assert_eq!(runs.resolve(run), None);
        let (run, _) = runs.start();
        assert_eq!(runs.skip(), Unresolved);
        assert_eq!(runs.resolve(run), None);
        let mut ready = Runs::with_value();
        assert_eq!(ready.start().1, Refreshing);
        assert_eq!(ready.skip(), Ready);
    }

    #[test]
    fn a_value_set_directly_is_ready_unless_a_load_runs() {
        let mut runs = Runs::default();
        assert_eq!(runs.mutate(), Ready);
        let (run, _) = runs.start();
        assert_eq!(runs.mutate(), Refreshing);
        assert_eq!(runs.resolve(run), Some(Ready));
        assert_eq!(Run::from_bits(run.to_bits()), run);
        assert_eq!(Errored.name(), "errored");
    }
}
