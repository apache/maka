//! `ToastManager`: ordered toast storage and lifecycle, headless, as
//! `gpui-base`'s: a toast enters `Starting`, is `Present` once the motion's
//! duration elapsed, counts its timeout down while present and not paused,
//! and is unmounted `exit_duration` after it began `Ending`.

use std::{collections::VecDeque, time::Duration};

use nsh_core::{Points, time::Instant};

/// The lifecycle phase of a toast, which the app's presentation follows
/// (a [`super::Toast`]'s `transitionStatus`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, nsh_core::element::PropEnum)]
pub enum ToastTransitionStatus {
    /// Just added: it may run its enter transition.
    #[default]
    Starting,
    /// Fully present.
    Present,
    /// Closing: it stays mounted until its exit transition completes.
    Ending,
}

/// Motion tokens of an unstyled toast stack ([`super::ToastStack`]) and
/// its [`ToastManager`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToastMotion {
    /// The time scale of the stack's motion: the manager's deadline for a
    /// toast to be present, the stack's spring response for its reflow.
    pub duration: Duration,
    /// How long an ending toast stays mounted.
    pub exit_duration: Duration,
    /// The visible distance between collapsed layers.
    pub collapsed_peek: Points,
    /// The distance between expanded items.
    pub expanded_gap: Points,
    /// The fraction of the width each collapsed layer loses.
    pub collapsed_scale_step: f32,
    /// How many layers show while the stack is collapsed.
    pub collapsed_visible: usize,
}

impl ToastMotion {
    /// The motion of the shadcn / Sonner toaster.
    pub fn sonner() -> Self {
        Self {
            duration: Duration::from_millis(400),
            exit_duration: Duration::from_millis(200),
            collapsed_peek: Points(14.0),
            expanded_gap: Points(14.0),
            collapsed_scale_step: 0.05,
            collapsed_visible: 3,
        }
    }
}

impl Default for ToastMotion {
    fn default() -> Self {
        Self::sonner()
    }
}

/// Options of a toast entering a [`ToastManager`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[non_exhaustive]
pub struct ToastOptions {
    /// Present time before it is dismissed by itself; `None`: never.
    pub timeout: Option<Duration>,
}

impl ToastOptions {
    /// Options with `timeout`.
    pub fn timeout(timeout: Option<Duration>) -> Self {
        Self { timeout }
    }
}

#[derive(Debug, Clone)]
struct ManagedToast<I, T> {
    id: I,
    value: T,
    status: ToastTransitionStatus,
    timeout_remaining: Option<Duration>,
    transition_elapsed: Duration,
    last_advance: Instant,
}

/// What [`ToastManager::advance`] changed.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ToastAdvance<I, T> {
    /// A mounted toast changed phase or membership.
    pub changed: bool,
    /// The toasts whose enter transition completed.
    pub presented: Vec<I>,
    /// The toasts that began their exit transition (their timeout ran out).
    pub ending: Vec<I>,
    /// The toasts removed after their exit transition, with their values.
    pub removed: Vec<(I, T)>,
}

/// Ordered toast storage, lifecycle, auto-hide, limits and exit
/// coordination, oldest first (TS: the `ToastManager` class).
#[derive(Debug, Clone)]
pub struct ToastManager<I, T> {
    entries: VecDeque<ManagedToast<I, T>>,
    transition_duration: Duration,
    exit_duration: Duration,
}

impl<I, T> ToastManager<I, T> {
    /// A manager whose enter and exit take `motion`'s durations.
    pub fn new(motion: ToastMotion) -> Self {
        Self {
            entries: VecDeque::new(),
            transition_duration: motion.duration,
            exit_duration: motion.exit_duration,
        }
    }

    /// The number of mounted toasts, ending ones included.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// No toast is mounted.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The mounted toasts' ids, values and phases, oldest first.
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = (&I, &T, ToastTransitionStatus)> {
        self.entries.iter().map(|e| (&e.id, &e.value, e.status))
    }

    /// The newest `limit` toasts that are not ending, and the ending ones,
    /// oldest first.
    pub fn visible(&self, limit: usize) -> impl Iterator<Item = (&I, &T, ToastTransitionStatus)> {
        let first = self
            .entries
            .iter()
            .filter(|e| e.status != ToastTransitionStatus::Ending)
            .count()
            .saturating_sub(limit);
        let mut active = 0usize;
        self.entries.iter().filter_map(move |e| {
            let visible = if e.status == ToastTransitionStatus::Ending {
                true
            } else {
                let keep = active >= first;
                active += 1;
                keep
            };
            visible.then_some((&e.id, &e.value, e.status))
        })
    }

    /// A mounted toast's value.
    pub fn get(&self, id: &I) -> Option<&T>
    where
        I: Eq,
    {
        self.entries
            .iter()
            .find_map(|e| (&e.id == id).then_some(&e.value))
    }
}

impl<I: Clone + Eq, T> ToastManager<I, T> {
    /// Adds the newest toast, replacing one with the same id (whose value
    /// it returns).
    pub fn push(&mut self, id: I, value: T, options: ToastOptions, now: Instant) -> Option<T> {
        let replaced = self
            .entries
            .iter()
            .position(|e| e.id == id)
            .and_then(|i| self.entries.remove(i))
            .map(|e| e.value);
        self.entries.push_back(ManagedToast {
            id,
            value,
            status: ToastTransitionStatus::Starting,
            timeout_remaining: options.timeout,
            transition_elapsed: Duration::ZERO,
            last_advance: now,
        });
        replaced
    }

    /// Begins a toast's exit transition; whether its state changed.
    pub fn dismiss(&mut self, id: &I, now: Instant) -> bool {
        let Some(e) = self.entries.iter_mut().find(|e| &e.id == id) else {
            return false;
        };
        if e.status == ToastTransitionStatus::Ending {
            return false;
        }
        e.status = ToastTransitionStatus::Ending;
        e.transition_elapsed = Duration::ZERO;
        e.last_advance = now;
        true
    }

    /// Begins the exit transition of every toast that is not ending; their
    /// ids.
    pub fn dismiss_all(&mut self, now: Instant) -> Vec<I> {
        let mut changed = Vec::new();
        for e in &mut self.entries {
            if e.status != ToastTransitionStatus::Ending {
                e.status = ToastTransitionStatus::Ending;
                e.transition_elapsed = Duration::ZERO;
                e.last_advance = now;
                changed.push(e.id.clone());
            }
        }
        changed
    }

    /// Advances the lifecycle to `now`; present toasts' timeouts stand
    /// still while `paused`.
    pub fn advance(&mut self, now: Instant, paused: bool) -> ToastAdvance<I, T> {
        let (mut ending, mut presented, mut changed) = (Vec::new(), Vec::new(), false);
        for e in &mut self.entries {
            let delta = now.saturating_duration_since(e.last_advance);
            e.last_advance = now;
            match e.status {
                ToastTransitionStatus::Starting => {
                    e.transition_elapsed += delta;
                    if e.transition_elapsed >= self.transition_duration {
                        e.status = ToastTransitionStatus::Present;
                        e.transition_elapsed = Duration::ZERO;
                        presented.push(e.id.clone());
                        changed = true;
                    }
                }
                ToastTransitionStatus::Present if !paused => {
                    if let Some(remaining) = &mut e.timeout_remaining {
                        *remaining = remaining.saturating_sub(delta);
                        if remaining.is_zero() {
                            e.status = ToastTransitionStatus::Ending;
                            e.transition_elapsed = Duration::ZERO;
                            ending.push(e.id.clone());
                            changed = true;
                        }
                    }
                }
                ToastTransitionStatus::Ending => e.transition_elapsed += delta,
                ToastTransitionStatus::Present => {}
            }
        }
        let mut removed = Vec::new();
        let mut i = 0;
        while i < self.entries.len() {
            let e = &self.entries[i];
            if e.status == ToastTransitionStatus::Ending
                && e.transition_elapsed >= self.exit_duration
            {
                let e = self.entries.remove(i).expect("the index is in range");
                removed.push((e.id, e.value));
                changed = true;
            } else {
                i += 1;
            }
        }
        ToastAdvance {
            changed,
            presented,
            ending,
            removed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_timeout_pauses_and_removal_waits_for_the_exit() {
        let motion = ToastMotion::sonner();
        let start = Instant::now();
        let mut manager = ToastManager::new(motion);
        manager.push(
            "a",
            1,
            ToastOptions::timeout(Some(Duration::from_secs(5))),
            start,
        );
        manager.advance(start + motion.duration, false);
        manager.advance(start + motion.duration + Duration::from_secs(4), true);
        assert_eq!(
            manager.iter().next().unwrap().2,
            ToastTransitionStatus::Present
        );
        let ending = manager.advance(start + motion.duration + Duration::from_secs(9), false);
        assert_eq!(ending.ending, vec!["a"]);
        assert!(ending.removed.is_empty());
        let removed = manager.advance(
            start + motion.duration + motion.exit_duration + Duration::from_secs(9),
            false,
        );
        assert_eq!(removed.removed, vec![("a", 1)]);
    }

    #[test]
    fn the_limit_keeps_ending_toasts_mounted() {
        let now = Instant::now();
        let mut manager = ToastManager::new(ToastMotion::sonner());
        for id in ["a", "b", "c"] {
            manager.push(id, id, ToastOptions::default(), now);
        }
        manager.dismiss(&"a", now);
        assert_eq!(
            manager.visible(1).map(|(id, ..)| *id).collect::<Vec<_>>(),
            vec!["a", "c"]
        );
    }

    #[test]
    fn a_duplicate_id_replaces_and_becomes_the_newest() {
        let now = Instant::now();
        let mut manager = ToastManager::new(ToastMotion::sonner());
        manager.push("a", 1, ToastOptions::default(), now);
        manager.push("b", 2, ToastOptions::default(), now);
        assert_eq!(manager.push("a", 3, ToastOptions::default(), now), Some(1));
        assert_eq!(
            manager
                .iter()
                .map(|(id, v, _)| (*id, *v))
                .collect::<Vec<_>>(),
            vec![("b", 2), ("a", 3)]
        );
        assert_eq!(manager.get(&"a"), Some(&3));
        assert_eq!(manager.len(), 2);
    }

    #[test]
    fn a_new_toast_has_its_own_clock() {
        let motion = ToastMotion::sonner();
        let start = Instant::now();
        let mut manager = ToastManager::new(motion);
        manager.push("old", 1, ToastOptions::default(), start);
        let later = start + Duration::from_secs(60);
        manager.push("new", 2, ToastOptions::default(), later);
        manager.advance(later + Duration::from_millis(50), false);
        assert_eq!(
            manager
                .iter()
                .find(|(id, ..)| **id == "new")
                .map(|(.., s)| s),
            Some(ToastTransitionStatus::Starting)
        );
        assert_eq!(manager.dismiss_all(later), vec!["old", "new"]);
        assert!(!manager.dismiss(&"old", later));
    }
}
