//! Bitmaps of decoration that is costly to draw (blurred shadows, conic
//! gradients), kept between frames by what they show.
//!
//! Keys are hashes of everything a bitmap depends on (sizes, radii, the
//! shadow, the scale), so views that look alike share one bitmap: the
//! cards of a list blur their shadow once. Bitmaps are device resources:
//! the cache empties when the device is replaced ([`crate::gfx::generation`]).
//! It holds at most [`MAX_BYTES`] of pixels, dropping the least recently
//! used bitmaps first.

use std::cell::{Cell, RefCell};

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
    /// The last use, for the least-recently-used order.
    used: u64,
    /// The drawing pass that last used it: a pass does not evict what it
    /// drew with.
    seen: u64,
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
    /// The drawing pass whose bitmaps eviction leaves alone.
    static FRAME: Cell<u64> = const { Cell::new(0) };
    /// How many linked passes are open (nested offscreen drawing).
    static DEPTH: Cell<u32> = const { Cell::new(0) };
    /// [`MAX_BYTES`] and [`LOW_BYTES`] (tests use small ones).
    static LIMITS: Cell<(usize, usize)> = const { Cell::new((MAX_BYTES, LOW_BYTES)) };
}

/// Marks a drawing pass: bitmaps read or made until it ends are current,
/// and eviction drops other bitmaps first. Nested passes (offscreen
/// drawing inside a pass, a snapshot taken while drawing) stay in the
/// enclosing frame; a new pass gets a new id. `Drop` closes the pass on
/// normal and early returns alike.
pub(crate) struct FrameGuard(());

impl FrameGuard {
    /// Opens a pass.
    pub(crate) fn begin() -> FrameGuard {
        let outer = DEPTH.with(|depth| {
            let count = depth.get();
            depth.set(count + 1);
            count == 0
        });
        if outer {
            FRAME.with(|frame| frame.set(frame.get().wrapping_add(1)));
        }
        FrameGuard(())
    }
}

impl Drop for FrameGuard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// The pass being drawn, 0 outside one.
fn frame() -> u64 {
    FRAME.with(Cell::get)
}

fn limits() -> (usize, usize) {
    LIMITS.with(Cell::get)
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
    let current = frame();
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
            e.seen = current;
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
                seen: current,
                bytes,
            },
        ) {
            c.bytes -= old.bytes;
        }
        c.bytes += bytes;
        let (max, low) = limits();
        if c.bytes > max {
            evict(&mut c, current, low);
        }
    });
    Some(baked)
}

#[cfg(test)]
pub(crate) fn set_limits(max: usize, low: usize) {
    LIMITS.with(|limits| limits.set((max, low)));
}

#[cfg(test)]
pub(crate) fn reset_limits() {
    LIMITS.with(|limits| limits.set((MAX_BYTES, LOW_BYTES)));
}

#[cfg(test)]
pub(crate) fn clear() {
    CACHE.with(|cell| {
        *cell.borrow_mut() = Cache {
            generation: crate::gfx::generation(),
            clock: 0,
            bytes: 0,
            map: FxHashMap::default(),
        }
    });
}

#[cfg(test)]
pub(crate) fn stats() -> (usize, usize) {
    CACHE.with(|cell| {
        let cache = cell.borrow();
        (cache.bytes, cache.map.len())
    })
}

#[cfg(test)]
pub(crate) fn contains(key: u64) -> bool {
    CACHE.with(|cell| cell.borrow().map.contains_key(&key))
}

#[cfg(test)]
pub(crate) fn set_generation(generation: u64) {
    CACHE.with(|cell| cell.borrow_mut().generation = generation);
}

/// Drops bitmaps until the cache is under `low`: first those no read in
/// `current` used, least recently used first, so a pass keeps what it is
/// drawing with. When every cached bitmap is current, the bound still
/// wins and the oldest current ones go too; the bitmap just returned is
/// already cloned out.
fn evict(c: &mut Cache, current: u64, low: usize) {
    let mut ages: Vec<(bool, u64, u64)> = c
        .map
        .iter()
        .map(|(k, e)| (e.seen == current, e.used, *k))
        .collect();
    // Other passes' bitmaps (false) before this pass's, then by use.
    ages.sort_unstable();
    for (_, _, key) in ages {
        if c.bytes <= low {
            break;
        }
        if let Some(e) = c.map.remove(&key) {
            c.bytes -= e.bytes;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::mem::ManuallyDrop;

    use windows::Win32::Graphics::{
        Direct2D::{
            Common::{D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT},
            D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1,
        },
        Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
    };

    use super::*;

    /// A `side` × `side` bitmap filling `side * side * 4` cache bytes.
    fn baked(gfx: &crate::gfx::Gfx, side: u32) -> Baked {
        // SAFETY: a COM call on the live context.
        let bitmap = unsafe {
            gfx.dc.CreateBitmap(
                D2D_SIZE_U {
                    width: side,
                    height: side,
                },
                None,
                0,
                &D2D1_BITMAP_PROPERTIES1 {
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                    },
                    dpiX: 96.0,
                    dpiY: 96.0,
                    bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                    colorContext: ManuallyDrop::new(None),
                },
            )
        }
        .expect("a bitmap");
        Baked {
            bitmap,
            x: 0.0,
            y: 0.0,
            width: side as f32,
            height: side as f32,
        }
    }

    /// 64 bytes, 4 × 4.
    fn tiny(gfx: &crate::gfx::Gfx) -> impl FnOnce() -> Option<Baked> + '_ {
        move || Some(baked(gfx, 4))
    }

    /// Fails when the cache does not have the bitmap.
    fn hit() -> impl FnOnce() -> Option<Baked> {
        || panic!("the cache has the bitmap")
    }

    #[test]
    fn a_pass_keeps_the_bitmaps_it_used() {
        let Ok(gfx) = crate::gfx::get() else {
            // No Direct3D device, not even WARP.
            return;
        };
        clear();
        set_limits(300, 200);
        let first = FrameGuard::begin();
        for key in [1, 2, 3] {
            assert!(get_or_make(key, tiny(&gfx)).is_some());
        }
        drop(first);
        let second = FrameGuard::begin();
        assert!(get_or_make(1, hit()).is_some());
        assert!(get_or_make(4, tiny(&gfx)).is_some());
        assert!(get_or_make(5, tiny(&gfx)).is_some());
        let (bytes, entries) = stats();
        assert!(contains(1), "the pass's earlier bitmap stays");
        assert!(!contains(2) && !contains(3), "older passes' go first");
        assert!(contains(4) && contains(5));
        assert_eq!((bytes, entries), (192, 3));
        drop(second);
        reset_limits();
    }

    #[test]
    fn an_insertion_evicts_another_pass_before_the_current_one() {
        let Ok(gfx) = crate::gfx::get() else {
            // No Direct3D device, not even WARP.
            return;
        };
        clear();
        set_limits(128, 128);
        let first = FrameGuard::begin();
        assert!(get_or_make(1, tiny(&gfx)).is_some());
        assert!(get_or_make(2, tiny(&gfx)).is_some());
        drop(first);
        let second = FrameGuard::begin();
        assert!(get_or_make(1, hit()).is_some());
        assert!(get_or_make(3, tiny(&gfx)).is_some());
        assert!(contains(1) && contains(3), "this pass's bitmaps stay");
        assert!(!contains(2), "the other pass's goes");
        assert_eq!(stats().0, 128);
        drop(second);
        reset_limits();
    }

    #[test]
    fn an_emergency_eviction_still_bounds_the_cache() {
        let Ok(gfx) = crate::gfx::get() else {
            // No Direct3D device, not even WARP.
            return;
        };
        clear();
        set_limits(128, 64);
        let first = FrameGuard::begin();
        assert!(get_or_make(1, tiny(&gfx)).is_some());
        assert!(get_or_make(2, tiny(&gfx)).is_some());
        drop(first);
        let second = FrameGuard::begin();
        assert!(get_or_make(1, hit()).is_some());
        assert!(get_or_make(2, hit()).is_some());
        // Every cached byte is current: the bound still wins.
        assert!(get_or_make(3, tiny(&gfx)).is_some());
        let (bytes, _) = stats();
        assert!(bytes <= 64, "{bytes}");
        assert!(contains(3), "the newest current bitmap stays");
        drop(second);
        reset_limits();
    }

    #[test]
    fn the_next_pass_and_a_new_device_clear_as_they_did() {
        let Ok(gfx) = crate::gfx::get() else {
            // No Direct3D device, not even WARP.
            return;
        };
        clear();
        set_limits(192, 128);
        let first = FrameGuard::begin();
        assert!(get_or_make(1, tiny(&gfx)).is_some());
        drop(first);
        let second = FrameGuard::begin();
        assert!(get_or_make(2, tiny(&gfx)).is_some());
        assert!(get_or_make(3, tiny(&gfx)).is_some());
        assert!(get_or_make(4, tiny(&gfx)).is_some());
        assert!(!contains(1) && !contains(2), "the older ones go");
        assert!(contains(3) && contains(4));
        assert_eq!(stats().0, 128, "bounded after the next pass");
        drop(second);
        // A new device clears what the old one made.
        set_generation(crate::gfx::generation().wrapping_sub(1));
        assert!(get_or_make(5, tiny(&gfx)).is_some());
        assert_eq!(stats().1, 1);
        assert!(contains(5) && !contains(3) && !contains(4));
        reset_limits();
    }

    #[test]
    fn a_nested_pass_shares_the_frame() {
        clear();
        let outer = FrameGuard::begin();
        let id = frame();
        {
            let _inner = FrameGuard::begin();
            assert_eq!(frame(), id, "nested passes share the frame");
        }
        assert_eq!(frame(), id);
        drop(outer);
        let _next = FrameGuard::begin();
        assert_ne!(frame(), id, "the next pass is a new frame");
    }
}
