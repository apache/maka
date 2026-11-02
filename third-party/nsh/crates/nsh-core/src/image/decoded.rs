//! Decoded images at display size (L4 of `docs/dev/image-loading-design.md`)
//! over the shared [`Loader`]: a backend gives [`Images`] its decoder (bytes
//! to its texture type at a size) and asks for images at the size a view
//! shows them.
//!
//! An image is decoded at the [`bucket`] covering what its view needs
//! ([`Want`]), never above its natural size (an SVG: within
//! [`crate::svg::MAX_SIDE`]), and kept by (source key, bucket, frames)
//! ([`Key`]): views of similar sizes share an entry, one that grows asks
//! for the next bucket. One decode per key runs at a time; the natural sizes
//! read from the bytes' headers are remembered, so a request for an image
//! decoded before is answered from memory without reading anything.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use super::{
    Budget, ImageData, Lease, MemoryCache,
    loader::{Context, Loader, Location, Priority, Progress, Ticket, loader},
    memory::{bucket, wanted},
};
use crate::{
    ResizeMode,
    geometry::{Points, Size, size},
};

/// The longest side an SVG is drawn at (`svg::MAX_SIDE`).
const VECTOR_SIDE: u32 = 8192;

/// An image's own size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Natural {
    /// A bitmap's pixels.
    Pixels(u32, u32),
    /// An SVG's intrinsic size in points.
    Vector(Size<Points>),
}

impl Natural {
    /// Its size in points: a bitmap's pixels over its file name's
    /// `density`.
    pub fn points(self, density: f32) -> Size<Points> {
        match self {
            Natural::Pixels(w, h) => size(Points(w as f32 / density), Points(h as f32 / density)),
            Natural::Vector(points) => points,
        }
    }

    /// The natural size of the encoded `bytes`, from their header (an SVG:
    /// parsed), when it can be read without decoding them.
    pub fn of(bytes: &[u8]) -> Option<Natural> {
        #[cfg(feature = "svg")]
        if crate::svg::sniff(bytes) {
            return crate::svg::size(bytes).ok().map(Natural::Vector);
        }
        let size = imagesize::blob_size(bytes).ok()?;
        let side = |n: usize| u32::try_from(n).ok().filter(|n| *n > 0);
        Some(Natural::Pixels(side(size.width)?, side(size.height)?))
    }
}

/// Which frames of an animated image a decode keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Frames {
    /// Every frame (an image view plays it).
    #[default]
    All,
    /// The first (a canvas draws a bitmap).
    First,
}

/// The size a view shows an image at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Want {
    /// The view's box; empty: the image's natural size.
    pub size: Size<Points>,
    /// Device pixels per point.
    pub scale: f32,
    /// How the box fits it.
    pub mode: ResizeMode,
}

impl Want {
    /// The natural size at `scale` device pixels per point.
    pub fn natural(scale: f32) -> Self {
        Want {
            size: Size::default(),
            scale,
            mode: ResizeMode::Center,
        }
    }

    /// The longest side, in pixels, to decode an image of `natural` size
    /// at (`declared`: the size its source gives, in points).
    pub fn longest(&self, natural: Natural, density: f32, declared: Option<Size<Points>>) -> u32 {
        let points = declared
            .filter(|s| s.width.0 > 0.0 && s.height.0 > 0.0)
            .unwrap_or_else(|| natural.points(density));
        let mut px = (wanted(points, self.size, self.mode) as f32 * self.scale).ceil() as u32;
        match natural {
            Natural::Pixels(w, h) => bucket(w.max(h), px),
            Natural::Vector(points) => {
                if px == 0 {
                    px = (points.width.0.max(points.height.0) * self.scale).ceil() as u32;
                }
                bucket(VECTOR_SIDE, px.max(1))
            }
        }
    }
}

/// What a decode makes: the image at a size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Target {
    /// The image's own size (`None`: its header did not say; decode it at
    /// its natural size).
    pub natural: Option<Natural>,
    /// The longest side to decode at, in pixels (at most the natural one).
    pub longest: u32,
    /// The frames to keep.
    pub frames: Frames,
}

/// A decoded image's entry key.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    /// The source key ([`Location::key`]).
    pub source: String,
    /// Its bucket ([`Target::longest`]; 0: natural, its size unknown).
    pub longest: u32,
    /// The frames kept.
    pub frames: Frames,
}

/// A decoded image.
#[derive(Clone)]
pub struct Decoded<V> {
    /// The backend's picture of it.
    pub value: V,
    /// Its own size, whatever size it was decoded at.
    pub natural: Natural,
}

/// A request for an image.
#[derive(Clone)]
pub struct Request {
    /// Where its bytes are.
    pub location: Location,
    /// What the load goes through.
    pub context: Context,
    /// The size its source declares, in points (a bundled asset's).
    pub declared: Option<Size<Points>>,
    /// The size its view shows it at.
    pub want: Want,
    /// The frames its view needs.
    pub frames: Frames,
    /// Where it goes in the queues.
    pub priority: Priority,
    /// Hears the download's progress.
    pub progress: Option<Progress>,
}

/// Decodes `bytes` at `target` into a backend's picture, its natural size
/// and its cost in bytes (pixels, GPU copies).
pub type Decoder<V> =
    dyn Fn(&ImageData, &Target) -> Result<(V, Natural, usize), String> + Send + Sync;

/// Called with an image and the lease that keeps it, or why there is none.
pub type Done<V> = Box<dyn FnOnce(Result<(Decoded<V>, Lease), String>) + Send>;

/// A backend's decoded images: decodes by [`Key`], in one budget.
pub struct Images<V> {
    memory: MemoryCache<Key, Decoded<V>>,
    shared: Arc<Shared<V>>,
    loader: &'static Loader,
}

impl<V> Clone for Images<V> {
    fn clone(&self) -> Self {
        Images {
            memory: self.memory.clone(),
            shared: self.shared.clone(),
            loader: self.loader,
        }
    }
}

struct Shared<V> {
    decoder: Box<Decoder<V>>,
    /// Decodes running, by key: who waits for them.
    pending: Mutex<HashMap<Key, Pending<V>>>,
    /// Natural sizes read so far, by source key.
    naturals: Mutex<HashMap<String, Natural>>,
    waiters: AtomicU64,
}

struct Pending<V> {
    waiters: Vec<(u64, Done<V>)>,
    ticket: Option<Ticket>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A request's stages: the read, then its place among a decode's waiters.
#[derive(Default)]
struct Stage {
    cancelled: bool,
    read: Option<Ticket>,
    decode: Option<Key>,
}

impl<V: Clone + Send + Sync + 'static> Images<V> {
    /// Images decoded by `decoder`, kept in `budget`.
    pub fn new(
        budget: &Arc<Budget>,
        decoder: impl Fn(&ImageData, &Target) -> Result<(V, Natural, usize), String>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self::make(MemoryCache::new(budget), Box::new(decoder))
    }

    /// [`Images::new`], calling `on_evict` with each picture dropped (to
    /// release its GPU copy where it lives).
    pub fn with_on_evict(
        budget: &Arc<Budget>,
        decoder: impl Fn(&ImageData, &Target) -> Result<(V, Natural, usize), String>
        + Send
        + Sync
        + 'static,
        on_evict: impl Fn(&V) + Send + Sync + 'static,
    ) -> Self {
        let memory =
            MemoryCache::with_on_evict(budget, move |_, d: &Decoded<V>| on_evict(&d.value));
        Self::make(memory, Box::new(decoder))
    }

    fn make(memory: MemoryCache<Key, Decoded<V>>, decoder: Box<Decoder<V>>) -> Self {
        Images {
            loader: loader(),
            memory,
            shared: Arc::new(Shared {
                decoder,
                pending: Mutex::default(),
                naturals: Mutex::default(),
                waiters: AtomicU64::new(0),
            }),
        }
    }

    /// These images, loaded by `loader` (tests: a loader of their own).
    #[cfg(test)]
    pub(crate) fn on(mut self, loader: &'static Loader) -> Self {
        self.loader = loader;
        self
    }

    /// The decoded entries.
    pub fn memory(&self) -> &MemoryCache<Key, Decoded<V>> {
        &self.memory
    }

    /// The natural size of `source` (a source key), if it was read.
    pub fn natural(&self, source: &str) -> Option<Natural> {
        lock(&self.shared.naturals).get(source).copied()
    }

    /// The key `request` is decoded by, once its natural size is known.
    fn key(&self, request: &Request, source: &str, natural: Option<Natural>) -> (Key, Target) {
        let longest = natural.map_or(0, |n| {
            request
                .want
                .longest(n, request.location.density(), request.declared)
        });
        let target = Target {
            natural,
            longest,
            frames: request.frames,
        };
        let key = Key {
            source: source.to_owned(),
            longest,
            frames: request.frames,
        };
        (key, target)
    }

    /// The key `request`'s image, of natural size `natural`, is kept under
    /// (to count what it costs elsewhere: [`MemoryCache::add_cost`]).
    pub fn key_of(&self, request: &Request, natural: Natural) -> Key {
        self.key(request, &request.location.key(), Some(natural)).0
    }

    /// The decoded image `request` asks for, when it is in memory.
    pub fn cached(&self, request: &Request) -> Option<(Decoded<V>, Lease)> {
        let source = request.location.key();
        let natural = self.natural(&source)?;
        self.memory
            .get(&self.key(request, &source, Some(natural)).0)
    }

    /// Loads `request`'s image and calls `done` with it: here and now when
    /// it is in memory, else on a loader thread. Dropping the ticket gives
    /// up waiting (and cancels the load when nobody else waits).
    pub fn load(&self, request: Request, done: Done<V>) -> Ticket {
        if let Some(hit) = self.cached(&request) {
            done(Ok(hit));
            return Ticket::done();
        }
        let id = self.shared.waiters.fetch_add(1, Ordering::Relaxed) + 1;
        let stage = Arc::new(Mutex::new(Stage::default()));
        let images = self.clone();
        let decode_stage = stage.clone();
        let source = request.location.key();
        let priority = request.priority;
        let read_request = request.clone();
        let read = self.loader.read(
            request.location,
            &request.context,
            priority,
            request.progress,
            Box::new(move |bytes| match bytes {
                Ok(bytes) => images.decode(&read_request, source, bytes, id, &decode_stage, done),
                Err(error) => done(Err(error)),
            }),
        );
        let reprioritize = read.reprioritize.clone();
        {
            let mut s = lock(&stage);
            if s.decode.is_none() {
                s.read = Some(read);
            }
        }
        let images = self.clone();
        Ticket::new(move || images.give_up(&stage, id), reprioritize)
    }

    /// The bytes of `request` arrived: decodes them, or waits for the decode
    /// of the same key running.
    fn decode(
        &self,
        request: &Request,
        source: String,
        bytes: ImageData,
        id: u64,
        stage: &Mutex<Stage>,
        done: Done<V>,
    ) {
        let natural = self.natural(&source).or_else(|| {
            let natural = Natural::of(&bytes)?;
            lock(&self.shared.naturals).insert(source.clone(), natural);
            Some(natural)
        });
        let (key, target) = self.key(request, &source, natural);
        {
            let mut s = lock(stage);
            if s.cancelled {
                return;
            }
            s.read = None;
            s.decode = Some(key.clone());
        }
        // Under the lock a decode ends with (after keeping its image): one
        // decode per key.
        let mut pending = lock(&self.shared.pending);
        if let Some(hit) = self.memory.get(&key) {
            drop(pending);
            done(Ok(hit));
            return;
        }
        if let Some(p) = pending.get_mut(&key) {
            p.waiters.push((id, done));
            return;
        }
        pending.insert(
            key.clone(),
            Pending {
                waiters: vec![(id, done)],
                ticket: None,
            },
        );
        drop(pending);
        let images = self.clone();
        let job_key = key.clone();
        let ticket = self.loader.decode(request.priority, move || {
            let result = (images.shared.decoder)(&bytes, &target);
            images.decoded(job_key, result);
        });
        if let Some(p) = lock(&self.shared.pending).get_mut(&key) {
            p.ticket = Some(ticket);
        } else {
            ticket.detach();
        }
    }

    /// A decode ended: keeps the image and hands it to who waits.
    fn decoded(&self, key: Key, result: Result<(V, Natural, usize), String>) {
        let take = |key: &Key| {
            lock(&self.shared.pending)
                .remove(key)
                .map(|p| p.waiters)
                .unwrap_or_default()
        };
        match result {
            Ok((value, natural, cost)) => {
                let decoded = Decoded { value, natural };
                let lease = self.memory.insert(key.clone(), decoded.clone(), cost);
                for (_, done) in take(&key) {
                    done(Ok((decoded.clone(), lease.clone())));
                }
            }
            Err(error) => {
                for (_, done) in take(&key) {
                    done(Err(error.clone()));
                }
            }
        }
    }

    /// Request `id` gave up: its read, or its place among a decode's
    /// waiters, goes (and the decode, when nobody else waits for it).
    fn give_up(&self, stage: &Mutex<Stage>, id: u64) {
        let (read, key) = {
            let mut s = lock(stage);
            s.cancelled = true;
            (s.read.take(), s.decode.take())
        };
        drop(read);
        let Some(key) = key else { return };
        let ticket = {
            let mut pending = lock(&self.shared.pending);
            let Some(p) = pending.get_mut(&key) else {
                return;
            };
            p.waiters.retain(|(w, _)| *w != id);
            if !p.waiters.is_empty() {
                return;
            }
            pending.remove(&key).and_then(|p| p.ticket)
        };
        drop(ticket);
    }
}
