//! Bitmaps of decoration that is costly to draw (blurred shadows, conic
//! gradients), kept between frames by what they show.
//!
//! Keys are hashes of everything a bitmap depends on (sizes, radii, the
//! shadow, the scale), so views that look alike share one bitmap: the
//! cards of a list blur their shadow once. Bitmaps are device resources:
//! the cache empties when the device is replaced ([`crate::gfx::generation`]).
//! It holds at most [`MAX_BYTES`] of pixels, dropping the least recently
//! used bitmaps first.

use std::cell::RefCell;

use rustc_hash::FxHashMap;
use windows::Win32::Graphics::Direct2D::ID2D1Bitmap1;

/// A bitmap and where it goes, in the coordinates of the view it decorates.
#[derive(Clone)]
pub(crate) struct Baked {
    /// The pixels.
    pub(crate) bitmap: ID2D1Bitmap1,
    /// Left edge (points).
    pub(crate) x: f32,
    /// Top edge (points).
    pub(crate) y: f32,
    /// Width (points).
    pub(crate) width: f32,
    /// Height (points).
    pub(crate) height: f32,
}

struct Entry {
    baked: Baked,
    used: u64,
    bytes: usize,
}

struct Cache {
    generation: u64,
    clock: u64,
    bytes: usize,
    map: FxHashMap<u64, Entry>,
}

/// Most pixel bytes kept.
pub(crate) const MAX_BYTES: usize = 96 << 20;
/// What eviction brings the cache down to.
const LOW_BYTES: usize = 64 << 20;

thread_local! {
    static CACHE: RefCell<Cache> = RefCell::new(Cache {
        generation: 0,
        clock: 0,
        bytes: 0,
        map: FxHashMap::default(),
    });
}

pub(super) fn clear_thread_cache() {
    let _ = CACHE.try_with(|cell| {
        let mut c = cell.borrow_mut();
        c.map.clear();
        c.bytes = 0;
        c.generation = 0;
    });
}

/// The bitmap kept under `key`, or the one `make` draws (then kept).
/// `make` must not use the cache itself.
pub(crate) fn get_or_make(key: u64, make: impl FnOnce() -> Option<Baked>) -> Option<Baked> {
    let generation = crate::gfx::generation();
    let found = CACHE.with(|cell| {
        let mut c = cell.borrow_mut();
        if c.generation != generation {
            c.map.clear();
            c.bytes = 0;
            c.generation = generation;
        }
        c.clock += 1;
        let clock = c.clock;
        c.map.get_mut(&key).map(|e| {
            e.used = clock;
            e.baked.clone()
        })
    });
    if found.is_some() {
        return found;
    }
    let baked = make()?;
    // SAFETY: a COM call on a live bitmap.
    let size = unsafe { baked.bitmap.GetPixelSize() };
    let bytes = size.width as usize * size.height as usize * 4;
    CACHE.with(|cell| {
        let mut c = cell.borrow_mut();
        let used = c.clock;
        if let Some(old) = c.map.insert(
            key,
            Entry {
                baked: baked.clone(),
                used,
                bytes,
            },
        ) {
            c.bytes -= old.bytes;
        }
        c.bytes += bytes;
        if c.bytes > MAX_BYTES {
            evict(&mut c);
        }
    });
    Some(baked)
}

/// Drops the least recently used bitmaps until the cache is under
/// [`LOW_BYTES`].
fn evict(c: &mut Cache) {
    let mut ages: Vec<(u64, u64)> = c.map.iter().map(|(k, e)| (e.used, *k)).collect();
    ages.sort_unstable();
    for (_, key) in ages {
        if c.bytes <= LOW_BYTES {
            break;
        }
        if let Some(e) = c.map.remove(&key) {
            c.bytes -= e.bytes;
        }
    }
}
