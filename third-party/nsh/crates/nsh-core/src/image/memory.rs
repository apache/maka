//! Decoded images in memory (L4 of `docs/dev/image-loading-design.md`):
//! caches of decoded entries that share one [`Budget`] per process.
//!
//! An entry costs what it holds: its pixels, its GPU copies
//! ([`MemoryCache::add_cost`]) and, for a variant (a baked effect, a
//! smaller decode), an entry of its own. A view showing an entry holds a
//! [`Lease`] on it: leased entries are in use, counted and never evicted.
//! The others form one least-recently-used order across every cache of the
//! budget, and go oldest first whenever the budget's total is over its
//! limit, so the images that scrolled away go before anything on screen.
//! An entry larger than the whole budget is still shown while leased, and
//! goes the moment its last lease does.
//!
//! Entries are evicted on the thread that pushed the budget over its limit;
//! a cache that must release its values somewhere else (a GPU texture on
//! the render thread) does it from its `on_evict` hook.

use std::{
    collections::{BTreeMap, HashMap},
    hash::Hash,
    sync::{
        Arc, LazyLock, Mutex, Weak,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use crate::{
    ResizeMode,
    geometry::{Points, Size},
};

/// The byte budget the decoded images of a process share.
pub struct Budget {
    limit: AtomicUsize,
    used: AtomicUsize,
    /// Orders uses across the budget's caches.
    clock: AtomicU64,
    caches: Mutex<Vec<Weak<dyn Evict>>>,
    /// Bytes evicted since the allocator last gave memory back.
    evicted: AtomicUsize,
}

/// Evicted bytes after which the allocator gives freed memory back
/// ([`give_back`]).
const GIVE_BACK_AFTER: usize = 64 << 20;

/// Has the allocator return the memory freed to the system, where it keeps
/// it: glibc holds freed heap pages, so evicted pixels would stay in the
/// process's resident memory.
fn give_back() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: `malloc_trim` releases only memory that is free.
    unsafe {
        libc::malloc_trim(0);
    }
}

impl std::fmt::Debug for Budget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Budget")
            .field("limit", &self.limit())
            .field("used", &self.used())
            .finish()
    }
}

/// The process's budget, [`default_budget`] bytes.
pub fn budget() -> &'static Arc<Budget> {
    static BUDGET: LazyLock<Arc<Budget>> = LazyLock::new(|| Budget::new(default_budget()));
    &BUDGET
}

/// The budget of decoded images by default: on desktops a sixteenth of the
/// memory, at most 256 MiB; on phones an eighth, at most 128 MiB.
pub fn default_budget() -> usize {
    let (share, cap): (u64, u64) = if cfg!(any(target_os = "ios", target_os = "android")) {
        (8, 128 << 20)
    } else {
        (16, 256 << 20)
    };
    let memory = physical_memory().unwrap_or(cap * share);
    (memory / share).min(cap) as usize
}

/// The machine's memory in bytes, where it can be read.
fn physical_memory() -> Option<u64> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let info = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = info.lines().find(|l| l.starts_with("MemTotal:"))?;
        let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kib * 1024)
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let mut bytes: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: `hw.memsize` is a 64-bit integer, written into `bytes`.
        let ok = unsafe {
            libc::sysctlbyname(
                c"hw.memsize".as_ptr(),
                (&raw mut bytes).cast(),
                &raw mut len,
                std::ptr::null_mut(),
                0,
            )
        } == 0;
        ok.then_some(bytes)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: a zeroed MEMORYSTATUSEX is valid; `dwLength` says its size,
        // as the call requires.
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: `status` is a live MEMORYSTATUSEX of the size it says.
        let ok = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
        ok.then_some(status.ullTotalPhys)
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        windows
    )))]
    {
        None
    }
}

impl Budget {
    /// A budget of `limit` bytes.
    pub fn new(limit: usize) -> Arc<Self> {
        Arc::new(Budget {
            limit: AtomicUsize::new(limit),
            used: AtomicUsize::new(0),
            clock: AtomicU64::new(0),
            caches: Mutex::default(),
            evicted: AtomicUsize::new(0),
        })
    }

    /// Its limit in bytes.
    pub fn limit(&self) -> usize {
        self.limit.load(Ordering::Relaxed)
    }

    /// Sets its limit, evicting what no longer fits.
    pub fn set_limit(&self, limit: usize) {
        self.limit.store(limit, Ordering::Relaxed);
        self.enforce();
    }

    /// What its entries cost now, in bytes (leased ones included).
    pub fn used(&self) -> usize {
        self.used.load(Ordering::Relaxed)
    }

    /// Drops every entry not in use, in all its caches (memory pressure).
    pub fn clear(&self) {
        for cache in self.caches() {
            cache.clear();
        }
        self.evicted.store(0, Ordering::Relaxed);
        give_back();
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn caches(&self) -> Vec<Arc<dyn Evict>> {
        let mut caches = self.caches.lock().unwrap_or_else(|e| e.into_inner());
        caches.retain(|c| c.strong_count() > 0);
        caches.iter().filter_map(Weak::upgrade).collect()
    }

    /// Evicts the oldest entries not in use, across its caches, until its
    /// total is within the limit (or nothing is left to evict).
    fn enforce(&self) {
        if self.used() <= self.limit() {
            return;
        }
        let caches = self.caches();
        let before = self.used();
        while self.used() > self.limit() {
            let oldest = caches
                .iter()
                .filter_map(|c| c.oldest().map(|stamp| (stamp, c)))
                .min_by_key(|(stamp, _)| *stamp);
            let Some((_, cache)) = oldest else { break };
            if !cache.evict_oldest() {
                break;
            }
        }
        let evicted = before.saturating_sub(self.used());
        if self.evicted.fetch_add(evicted, Ordering::Relaxed) + evicted >= GIVE_BACK_AFTER {
            self.evicted.store(0, Ordering::Relaxed);
            give_back();
        }
    }
}

/// A cache, as its budget sees it.
trait Evict: Send + Sync {
    /// When its least recently used entry not in use was last used.
    fn oldest(&self) -> Option<u64>;
    /// Evicts that entry; `false` if there was none.
    fn evict_oldest(&self) -> bool;
    /// Evicts every entry not in use.
    fn clear(&self);
}

/// A cache of decoded entries by key, counted in a [`Budget`]. Cloning one
/// shares it.
pub struct MemoryCache<K, V> {
    inner: Arc<Inner<K, V>>,
}

impl<K, V> Clone for MemoryCache<K, V> {
    fn clone(&self) -> Self {
        MemoryCache {
            inner: self.inner.clone(),
        }
    }
}

/// Called with an entry the cache dropped.
type OnEvict<K, V> = Box<dyn Fn(&K, &V) + Send + Sync>;

struct Inner<K, V> {
    budget: Arc<Budget>,
    state: Mutex<State<K, V>>,
    on_evict: Option<OnEvict<K, V>>,
}

struct State<K, V> {
    entries: HashMap<K, Entry<V>>,
    /// The entries not in use, by when they were last used.
    unused: BTreeMap<u64, K>,
}

struct Entry<V> {
    value: V,
    cost: usize,
    leases: u32,
    /// When it was last used (its place in `unused` while not in use).
    stamp: u64,
}

impl<K, V> MemoryCache<K, V>
where
    K: Hash + Eq + Clone + Send + Sync + 'static,
    V: Clone + Send + 'static,
{
    /// A cache counted in `budget`.
    pub fn new(budget: &Arc<Budget>) -> Self {
        Self::make(budget, None)
    }

    /// A cache counted in `budget` that calls `on_evict` with each entry it
    /// drops (to release what the value stands for elsewhere: a GPU
    /// texture), on the thread that drops it.
    pub fn with_on_evict(
        budget: &Arc<Budget>,
        on_evict: impl Fn(&K, &V) + Send + Sync + 'static,
    ) -> Self {
        Self::make(budget, Some(Box::new(on_evict)))
    }

    fn make(budget: &Arc<Budget>, on_evict: Option<OnEvict<K, V>>) -> Self {
        let inner = Arc::new(Inner {
            budget: budget.clone(),
            state: Mutex::new(State {
                entries: HashMap::new(),
                unused: BTreeMap::new(),
            }),
            on_evict,
        });
        let weak = Arc::downgrade(&inner) as Weak<dyn Evict>;
        budget
            .caches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(weak);
        MemoryCache { inner }
    }

    /// The entry of `key`, leased for as long as the lease is kept.
    pub fn get(&self, key: &K) -> Option<(V, Lease)> {
        let mut state = self.inner.state();
        let entry = state.entries.get_mut(key)?;
        let value = entry.value.clone();
        let unused = entry.leases == 0;
        entry.leases += 1;
        let stamp = entry.stamp;
        if unused {
            state.unused.remove(&stamp);
        }
        drop(state);
        Some((value, self.lease(key.clone())))
    }

    /// Whether `key` has an entry (not counted as a use).
    pub fn contains(&self, key: &K) -> bool {
        self.inner.state().entries.contains_key(key)
    }

    /// Keeps `value` costing `cost` bytes as `key`'s entry, leased by the
    /// lease returned, and evicts what no longer fits in the budget. An
    /// entry already there is replaced, its leases carried over.
    pub fn insert(&self, key: K, value: V, cost: usize) -> Lease {
        let budget = &self.inner.budget;
        let stamp = budget.tick();
        let old = {
            let mut state = self.inner.state();
            let old = state.entries.remove(&key);
            let leases = match &old {
                Some(old) if old.leases == 0 => {
                    state.unused.remove(&old.stamp);
                    0
                }
                Some(old) => old.leases,
                None => 0,
            };
            state.entries.insert(
                key.clone(),
                Entry {
                    value,
                    cost,
                    leases: leases + 1,
                    stamp,
                },
            );
            old
        };
        budget.used.fetch_add(cost, Ordering::Relaxed);
        if let Some(old) = old {
            budget.used.fetch_sub(old.cost, Ordering::Relaxed);
            self.inner.evicted(&key, &old.value);
        }
        budget.enforce();
        self.lease(key)
    }

    /// Adds `delta` bytes to what `key`'s entry costs (a GPU copy made, or
    /// released), evicting what no longer fits.
    pub fn add_cost(&self, key: &K, delta: isize) {
        {
            let mut state = self.inner.state();
            let Some(entry) = state.entries.get_mut(key) else {
                return;
            };
            let cost = entry.cost.saturating_add_signed(delta);
            let budget = &self.inner.budget;
            budget.used.fetch_add(cost, Ordering::Relaxed);
            budget.used.fetch_sub(entry.cost, Ordering::Relaxed);
            entry.cost = cost;
        }
        self.inner.budget.enforce();
    }

    /// Drops `key`'s entry now, leased or not (its leases then release
    /// nothing).
    pub fn remove(&self, key: &K) {
        let entry = {
            let mut state = self.inner.state();
            let entry = state.entries.remove(key);
            if let Some(e) = entry.as_ref().filter(|e| e.leases == 0) {
                state.unused.remove(&e.stamp);
            }
            entry
        };
        if let Some(entry) = entry {
            self.inner
                .budget
                .used
                .fetch_sub(entry.cost, Ordering::Relaxed);
            self.inner.evicted(key, &entry.value);
        }
    }

    /// Drops every entry not in use.
    pub fn clear(&self) {
        Evict::clear(&*self.inner);
    }

    /// How many entries it has.
    pub fn len(&self) -> usize {
        self.inner.state().entries.len()
    }

    /// Whether it has no entry.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// What its entries cost, in bytes.
    pub fn cost(&self) -> usize {
        self.inner.state().entries.values().map(|e| e.cost).sum()
    }

    fn lease(&self, key: K) -> Lease {
        Lease(Some(Box::new(Held {
            inner: self.inner.clone(),
            key,
        })))
    }
}

impl<K, V> Inner<K, V> {
    fn state(&self) -> std::sync::MutexGuard<'_, State<K, V>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn evicted(&self, key: &K, value: &V) {
        if let Some(f) = &self.on_evict {
            f(key, value);
        }
    }
}

impl<K: Hash + Eq + Clone + Send, V: Send> Inner<K, V> {
    /// A lease of `key`'s entry ended.
    fn release(&self, key: &K) {
        let dropped = {
            let mut state = self.state();
            let Some(entry) = state.entries.get_mut(key) else {
                return;
            };
            entry.leases -= 1;
            if entry.leases > 0 {
                return;
            }
            if entry.cost > self.budget.limit() {
                // Larger than the whole budget: it goes with its view.
                state.entries.remove(key)
            } else {
                entry.stamp = self.budget.tick();
                let stamp = entry.stamp;
                state.unused.insert(stamp, key.clone());
                None
            }
        };
        if let Some(entry) = dropped {
            self.budget.used.fetch_sub(entry.cost, Ordering::Relaxed);
            self.evicted(key, &entry.value);
        }
        self.budget.enforce();
    }
}

impl<K: Hash + Eq + Clone + Send, V: Send> Evict for Inner<K, V> {
    fn oldest(&self) -> Option<u64> {
        self.state().unused.keys().next().copied()
    }

    fn evict_oldest(&self) -> bool {
        let (key, entry) = {
            let mut state = self.state();
            let Some((_, key)) = state.unused.pop_first() else {
                return false;
            };
            let Some(entry) = state.entries.remove(&key) else {
                return true;
            };
            (key, entry)
        };
        self.budget.used.fetch_sub(entry.cost, Ordering::Relaxed);
        self.evicted(&key, &entry.value);
        true
    }

    fn clear(&self) {
        let dropped: Vec<(K, Entry<V>)> = {
            let mut state = self.state();
            let unused = std::mem::take(&mut state.unused);
            unused
                .into_values()
                .filter_map(|k| state.entries.remove(&k).map(|e| (k, e)))
                .collect()
        };
        for (key, entry) in dropped {
            self.budget.used.fetch_sub(entry.cost, Ordering::Relaxed);
            self.evicted(&key, &entry.value);
        }
    }
}

/// A view's hold on a cache entry ([`MemoryCache::get`],
/// [`MemoryCache::insert`]): while one is kept, the entry is in use and
/// never evicted. Cloning one leases the entry again.
#[derive(Default)]
pub struct Lease(Option<Box<dyn Release>>);

impl Lease {
    /// A lease of nothing (an image that is not cached).
    pub fn none() -> Self {
        Lease(None)
    }
}

impl Clone for Lease {
    fn clone(&self) -> Self {
        Lease(self.0.as_ref().map(|r| r.again()))
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(held) = self.0.take() {
            held.release();
        }
    }
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() {
            "Lease"
        } else {
            "Lease(none)"
        })
    }
}

trait Release: Send + Sync {
    fn release(self: Box<Self>);
    fn again(&self) -> Box<dyn Release>;
}

struct Held<K, V> {
    inner: Arc<Inner<K, V>>,
    key: K,
}

impl<K, V> Release for Held<K, V>
where
    K: Hash + Eq + Clone + Send + Sync + 'static,
    V: Send + 'static,
{
    fn release(self: Box<Self>) {
        self.inner.release(&self.key);
    }

    fn again(&self) -> Box<dyn Release> {
        let mut state = self.inner.state();
        if let Some(entry) = state.entries.get_mut(&self.key) {
            entry.leases += 1;
        }
        drop(state);
        Box::new(Held {
            inner: self.inner.clone(),
            key: self.key.clone(),
        })
    }
}

/// The longest side, in pixels, an image is decoded at for a view that
/// needs `wanted` pixels: the smallest power of √2 (rounded) that covers
/// it, so views of similar sizes share a decode and one that grows asks for
/// the next bucket. Never more than `natural` (the image's own longest
/// side), which is the bucket of everything at least as large; `0` asks for
/// the natural size.
pub fn bucket(natural: u32, wanted: u32) -> u32 {
    if wanted == 0 || wanted >= natural {
        return natural;
    }
    let mut size = 1.0_f64;
    while (size.round() as u32) < wanted {
        size *= std::f64::consts::SQRT_2;
    }
    (size.round() as u32).min(natural)
}

/// The longest side of an image of `natural` size drawn in a box of `size`
/// by `mode` ([`ResizeMode::fit`]), in the box's units; `0` (its natural
/// size) when the box is empty. A box sized on one side only (the other
/// follows the image's aspect ratio once it is known) scales it by that
/// side.
pub fn wanted(natural: Size<Points>, size: Size<Points>, mode: ResizeMode) -> u32 {
    let (nw, nh) = (natural.width.0, natural.height.0);
    if nw <= 0.0 || nh <= 0.0 {
        return 0;
    }
    let (w, h) = (size.width.0, size.height.0);
    let scale = match (w > 0.0, h > 0.0) {
        (true, true) => {
            let shown = mode.fit(natural, size, Default::default()).size;
            (shown.width.0 / nw).max(shown.height.0 / nh)
        }
        (true, false) => w / nw,
        (false, true) => h / nh,
        (false, false) => return 0,
    };
    (nw.max(nh) * scale).ceil().max(1.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{Points, size};

    const MB: usize = 1 << 20;

    #[test]
    fn unused_entries_go_oldest_first() {
        let budget = Budget::new(3 * MB);
        let cache = MemoryCache::new(&budget);
        drop(cache.insert("a", 1, MB));
        drop(cache.insert("b", 2, MB));
        drop(cache.insert("c", 3, MB));
        // A use makes `a` the most recent.
        drop(cache.get(&"a"));
        drop(cache.insert("d", 4, MB));
        assert!(!cache.contains(&"b"), "b was the oldest");
        assert!(cache.contains(&"a") && cache.contains(&"c") && cache.contains(&"d"));
        assert_eq!(budget.used(), 3 * MB);
    }

    #[test]
    fn leased_entries_are_never_evicted() {
        let budget = Budget::new(2 * MB);
        let cache = MemoryCache::new(&budget);
        let a = cache.insert("a", 1, MB);
        let b = cache.insert("b", 2, MB);
        let c = cache.insert("c", 3, MB);
        // Over the budget, but everything is on screen.
        assert_eq!(cache.len(), 3);
        assert_eq!(budget.used(), 3 * MB);
        drop(b);
        // `b` scrolled away: it goes, the leased ones stay.
        assert!(!cache.contains(&"b"));
        assert_eq!(budget.used(), 2 * MB);
        // A clone is a lease of its own.
        let a2 = a.clone();
        drop(a);
        drop(cache.insert("d", 4, MB));
        assert!(cache.contains(&"a") && cache.contains(&"c"));
        assert!(!cache.contains(&"d"), "the only unleased entry went");
        drop((a2, c));
        assert_eq!(budget.used(), 2 * MB);
    }

    #[test]
    fn an_entry_larger_than_the_budget_goes_with_its_last_lease() {
        let budget = Budget::new(MB);
        let cache = MemoryCache::new(&budget);
        let lease = cache.insert("huge", 1, 4 * MB);
        assert!(cache.contains(&"huge"));
        let (_, again) = cache.get(&"huge").unwrap();
        drop(lease);
        assert!(cache.contains(&"huge"));
        drop(again);
        assert!(!cache.contains(&"huge"));
        assert_eq!(budget.used(), 0);
    }

    #[test]
    fn one_budget_counts_every_cache_and_cost() {
        let budget = Budget::new(10 * MB);
        let evicted = Arc::new(Mutex::new(Vec::new()));
        let log = evicted.clone();
        let images = MemoryCache::with_on_evict(&budget, move |k: &(&str, u32), _: &u8| {
            log.lock().unwrap().push(*k);
        });
        let drawings = MemoryCache::new(&budget);
        // An image, a smaller decode of it and a baked effect (variants)
        // are entries of their own, all in the one budget.
        drop(images.insert(("a", 4000), 0, 4 * MB));
        drop(images.insert(("a", 1024), 0, MB));
        drop(images.insert(("a-blur", 1024), 0, MB));
        drop(drawings.insert("icon", 0u8, MB));
        assert_eq!(budget.used(), 7 * MB);
        // A GPU copy counts too.
        images.add_cost(&("a", 1024), MB as isize);
        assert_eq!(images.cost(), 7 * MB);
        assert_eq!(budget.used(), 8 * MB);
        // Over the budget: the oldest unleased entry of any cache goes,
        // through the cache's hook.
        drop(drawings.insert("logo", 0u8, 3 * MB));
        assert_eq!(*evicted.lock().unwrap(), [("a", 4000)]);
        assert_eq!(budget.used(), 7 * MB);
        budget.set_limit(3 * MB);
        assert_eq!(budget.used(), 3 * MB);
        assert!(drawings.contains(&"logo"));
        budget.clear();
        assert_eq!(budget.used(), 0);
        assert!(images.is_empty() && drawings.is_empty());
    }

    #[test]
    fn replacing_an_entry_keeps_its_leases_and_count() {
        let budget = Budget::new(10 * MB);
        let cache = MemoryCache::new(&budget);
        let first = cache.insert("a", 1, MB);
        let second = cache.insert("a", 2, 2 * MB);
        assert_eq!(budget.used(), 2 * MB);
        drop(first);
        drop(second);
        assert_eq!(cache.get(&"a").map(|(v, _)| v), Some(2));
        cache.remove(&"a");
        assert_eq!(budget.used(), 0);
    }

    #[test]
    fn buckets_are_powers_of_root_two_up_to_the_natural_size() {
        assert_eq!(bucket(4000, 100), 128);
        assert_eq!(bucket(4000, 128), 128);
        assert_eq!(bucket(4000, 129), 181);
        assert_eq!(bucket(4000, 300), 362);
        assert_eq!(bucket(4000, 3000), 4000);
        // Never above the natural size; 0 asks for it.
        assert_eq!(bucket(4000, 6000), 4000);
        assert_eq!(bucket(4000, 0), 4000);
        assert_eq!(bucket(100, 99), 100);
        // Views of similar sizes share a bucket.
        let shared: Vec<u32> = (182..=362).map(|w| bucket(4000, w)).collect();
        assert!(shared.iter().all(|b| *b == 256 || *b == 362));
    }

    #[test]
    fn wanted_sizes_follow_the_resize_mode() {
        let photo = size(Points(4000.0), Points(3000.0));
        let thumb = size(Points(200.0), Points(200.0));
        // Covering a square shows the short side at 200 px.
        assert_eq!(wanted(photo, thumb, ResizeMode::Cover), 267);
        assert_eq!(wanted(photo, thumb, ResizeMode::Contain), 200);
        // Stretched, the image keeps its aspect ratio until it is drawn.
        assert_eq!(wanted(photo, thumb, ResizeMode::Stretch), 267);
        assert_eq!(wanted(photo, thumb, ResizeMode::Center), 4000);
        assert_eq!(
            wanted(photo, size(Points(0.0), Points(0.0)), ResizeMode::Cover),
            0
        );
        // A width alone (an auto height follows the image).
        assert_eq!(
            wanted(photo, size(Points(300.0), Points(0.0)), ResizeMode::Cover),
            300
        );
    }
}
