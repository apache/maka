//! The VM sandbox: resource limits, per-call time budgets and language
//! hardening.
//!
//! Every surface runs its own QuickJS runtime, so the limits are per VM. The
//! heap's allocator ([`HeapAllocator`]) enforces its ceiling and records
//! reaching it; the stack's is a runtime setting. Time is budgeted per call
//! from Rust into JS (a bundle evaluation, an event, a timer, the microtask
//! drain, ...): QuickJS calls the interrupt handler periodically while it
//! interprets, and returning `true` unwinds the call with an exception no
//! `catch` can swallow. A long-lived app therefore never accumulates time
//! toward a limit; only a single call that does not return in time is cut
//! off.
//!
//! A bundle holds only the app's code (nsh's runtime is native), so
//! nothing in JS is trusted: limits and checks are enforced here, in Rust,
//! never in JS.

use std::{
    cell::Cell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use nsh_core::{js::Limits, time::Instant};
use rquickjs::{Ctx, allocator::Allocator};

/// The VM's allocator: enforces the heap limit itself and records a refused
/// allocation. QuickJS reports running out in several ways (an
/// `InternalError`, a `null` exception when even that cannot be allocated,
/// or an exception the app catches), so the record, not the error, tells
/// that the heap is full.
///
/// It allocates as QuickJS does without one (the system's `malloc`, sizes
/// from the allocator): no header per allocation, many of which are a few
/// dozen bytes. WebAssembly has no such `malloc`; it uses Rust's.
pub(crate) struct HeapAllocator {
    /// Bytes allocated, as `usable_size` counts them.
    used: usize,
    /// Most bytes allocated at once (0: no limit).
    limit: usize,
    exhausted: Arc<AtomicBool>,
    #[cfg(target_arch = "wasm32")]
    inner: rquickjs::allocator::RustAllocator,
}

impl HeapAllocator {
    /// An allocator of at most `limit` bytes (0: no limit) and the flag it
    /// sets when it refuses an allocation.
    pub(crate) fn new(limit: usize) -> (Self, Arc<AtomicBool>) {
        let exhausted = Arc::new(AtomicBool::new(false));
        let allocator = Self {
            used: 0,
            limit,
            exhausted: exhausted.clone(),
            #[cfg(target_arch = "wasm32")]
            inner: rquickjs::allocator::RustAllocator,
        };
        (allocator, exhausted)
    }

    /// Whether `size` more bytes fit; records a refusal.
    fn fits(&self, size: usize) -> bool {
        let fits = self.limit == 0 || self.used.saturating_add(size) <= self.limit;
        if !fits {
            self.exhausted.store(true, Ordering::Relaxed);
        }
        fits
    }

    /// Counts an allocation just made (null: none).
    fn counted(&mut self, ptr: *mut u8) -> *mut u8 {
        if !ptr.is_null() {
            // SAFETY: an allocation of this allocator.
            self.used += unsafe { <Self as Allocator>::usable_size(ptr) };
        }
        ptr
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod system {
    use std::ffi::c_void;

    pub(super) use libc::{calloc, free, malloc, realloc};

    /// The usable size of a live `malloc` allocation.
    pub(super) unsafe fn usable_size(ptr: *mut c_void) -> usize {
        // SAFETY: guaranteed by the caller.
        unsafe {
            #[cfg(target_vendor = "apple")]
            return libc::malloc_size(ptr);
            #[cfg(windows)]
            return _msize(ptr);
            #[cfg(not(any(target_vendor = "apple", windows)))]
            return libc::malloc_usable_size(ptr);
        }
    }

    #[cfg(windows)]
    unsafe extern "C" {
        fn _msize(ptr: *mut c_void) -> usize;
    }
}

// SAFETY: allocations come from the system's `malloc` (aligned for any
// type, `usable_size` from it) or from `RustAllocator`, which meets the
// trait's requirements; this only refuses some (returning null, as
// allowed) and counts what it hands out.
unsafe impl Allocator for HeapAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        if !self.fits(size) {
            return std::ptr::null_mut();
        }
        #[cfg(not(target_arch = "wasm32"))]
        // SAFETY: a plain allocation.
        let ptr = unsafe { system::malloc(size) }.cast();
        #[cfg(target_arch = "wasm32")]
        let ptr = self.inner.alloc(size);
        self.counted(ptr)
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        let Some(total) = count.checked_mul(size) else {
            return std::ptr::null_mut();
        };
        if !self.fits(total) {
            return std::ptr::null_mut();
        }
        #[cfg(not(target_arch = "wasm32"))]
        // SAFETY: a plain allocation.
        let ptr = unsafe { system::calloc(count, size) }.cast();
        #[cfg(target_arch = "wasm32")]
        let ptr = self.inner.calloc(count, size);
        self.counted(ptr)
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        // SAFETY: the caller hands back an allocation of this allocator.
        unsafe {
            self.used -= Self::usable_size(ptr);
            #[cfg(not(target_arch = "wasm32"))]
            system::free(ptr.cast());
            #[cfg(target_arch = "wasm32")]
            self.inner.dealloc(ptr);
        }
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        // SAFETY: the caller hands over an allocation of this allocator.
        let old = unsafe { Self::usable_size(ptr) };
        if new_size > old && !self.fits(new_size - old) {
            return std::ptr::null_mut();
        }
        // SAFETY: as above; on failure the old allocation stays.
        #[cfg(not(target_arch = "wasm32"))]
        let new: *mut u8 = unsafe { system::realloc(ptr.cast(), new_size) }.cast();
        // SAFETY: as above.
        #[cfg(target_arch = "wasm32")]
        let new = unsafe { self.inner.realloc(ptr, new_size) };
        if !new.is_null() {
            self.used -= old;
        }
        self.counted(new)
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize {
        // SAFETY: the caller hands over an allocation of this allocator.
        unsafe {
            #[cfg(not(target_arch = "wasm32"))]
            return system::usable_size(ptr.cast());
            #[cfg(target_arch = "wasm32")]
            return rquickjs::allocator::RustAllocator::usable_size(ptr);
        }
    }
}

/// The kind of call into JS, which decides its budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    /// Evaluating the bundle (or a development update).
    Load,
    /// Everything else.
    Call,
}

/// The clock of the call in progress, shared with the interrupt handler.
pub(crate) struct Budget {
    limits: Limits,
    /// Whether a call is running (nested calls share its budget).
    running: Cell<bool>,
    /// When the running call must have returned (`None`: no budget, as an
    /// app on its own has none).
    deadline: Rc<Cell<Option<Instant>>>,
    /// The call that overran, until its error is reported.
    tripped: Rc<Cell<Option<Phase>>>,
    /// The running call's kind.
    phase: Rc<Cell<Phase>>,
}

/// A call's clock ([`Budget::run`]), stopped when it drops.
pub(crate) struct Running<'a> {
    budget: &'a Budget,
    started: bool,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.budget.end(self.started);
    }
}

impl Budget {
    pub(crate) fn new(limits: Limits) -> Self {
        Self {
            limits,
            running: Cell::new(false),
            deadline: Rc::default(),
            tripped: Rc::default(),
            phase: Rc::new(Cell::new(Phase::Call)),
        }
    }

    pub(crate) fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Starts the clock of a call, unless one is running (nested calls
    /// share the outermost call's budget), until the guard drops: an unwind
    /// out of the call stops it too.
    pub(crate) fn run(&self, phase: Phase) -> Running<'_> {
        Running {
            budget: self,
            started: self.begin(phase),
        }
    }

    fn begin(&self, phase: Phase) -> bool {
        if self.running.replace(true) {
            return false;
        }
        let budget = match phase {
            Phase::Load => self.limits.load_budget,
            Phase::Call => self.limits.call_budget,
        };
        self.phase.set(phase);
        self.tripped.set(None);
        // `Duration::MAX` (no limit) is past any instant: no deadline.
        self.deadline.set(Instant::now().checked_add(budget));
        true
    }

    fn end(&self, started: bool) {
        if started {
            self.running.set(false);
            self.deadline.set(None);
        }
    }

    /// Why the last call was cut off, if it overran its budget.
    pub(crate) fn take_trip(&self) -> Option<String> {
        self.tripped.take().map(|phase| {
            let (what, budget) = match phase {
                Phase::Load => ("loading the bundle", self.limits.load_budget),
                Phase::Call => ("a call into JS", self.limits.call_budget),
            };
            format!(
                "the script was interrupted: {what} exceeded its budget of {} ms",
                budget.as_millis()
            )
        })
    }

    /// The runtime's interrupt handler: true once the running call is past
    /// its deadline or the engine is stopping.
    pub(crate) fn interrupt_handler(
        &self,
        stop: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Box<dyn FnMut() -> bool> {
        let deadline = self.deadline.clone();
        let tripped = self.tripped.clone();
        let phase = self.phase.clone();
        Box::new(move || {
            if stop
                .as_ref()
                .is_some_and(|s| s.load(std::sync::atomic::Ordering::Relaxed))
            {
                return true;
            }
            match deadline.get() {
                Some(d) if Instant::now() > d => {
                    tripped.set(Some(phase.get()));
                    true
                }
                _ => false,
            }
        })
    }
}

/// Removes every way from a string to code (`eval`, the function
/// constructors) and freezes the prototypes all modules share, so one
/// module cannot change `Array.prototype` or `for…in` for the others.
/// Development bundles keep them (REPL-style debugging; hot updates are
/// evaluated from Rust and need neither).
const HARDEN: &str = r#"
(() => {
  const deny = (label) => function () {
    throw new TypeError(label + " is disabled: nsh runs no code from strings (development builds allow it)");
  };
  const replace = (fn, value) => {
    Object.defineProperty(Object.getPrototypeOf(fn), "constructor", {
      value, writable: false, enumerable: false, configurable: false,
    });
  };
  const blocked = deny("the Function constructor");
  blocked.prototype = Function.prototype;
  replace(function () {}, blocked);
  replace(async function () {}, deny("the AsyncFunction constructor"));
  replace(function* () {}, deny("the GeneratorFunction constructor"));
  replace(async function* () {}, deny("the AsyncGeneratorFunction constructor"));
  Object.defineProperty(globalThis, "Function", { value: blocked, writable: false, configurable: false });
  delete globalThis.eval;
  // Assigning a property an object inherits read-only fails (the
  // "override mistake"): `Sub.prototype.constructor = Sub` or
  // `obj.toString = …` would throw once these prototypes are frozen. Their
  // commonly overridden members become accessors whose setter defines the
  // property on the object assigned to, as on an unfrozen prototype (the
  // prototype itself still cannot change).
  const tamed = [
    "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf",
    "propertyIsEnumerable", "toJSON",
  ];
  const tame = (proto) => {
    for (const name of tamed) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !("value" in d) || !d.writable) continue;
      const value = d.value;
      Object.defineProperty(proto, name, {
        get() { return value; },
        set(v) {
          if (this === proto) throw new TypeError(`Cannot assign to read only property '${name}'`);
          Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
        },
        enumerable: d.enumerable,
        configurable: false,
      });
    }
  };
  // Not Error.prototype: `this.name = "MyError"` in a subclass constructor
  // assigns a property it has.
  for (const proto of [
    Object.prototype, Array.prototype, Function.prototype, String.prototype, Number.prototype,
    Boolean.prototype, Symbol.prototype, RegExp.prototype, Promise.prototype, Map.prototype,
    Set.prototype, WeakMap.prototype, WeakSet.prototype, Date.prototype,
    Object.getPrototypeOf(Uint8Array.prototype),
  ]) {
    tame(proto);
    Object.freeze(proto);
  }
})();
"#;

/// Installs the hardening. Runs after the host's own globals and before the
/// bundle.
pub(crate) fn harden(cx: &Ctx<'_>) -> rquickjs::Result<()> {
    cx.eval::<(), _>(HARDEN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unwind_out_of_a_call_stops_its_clock() {
        let budget = Budget::new(Limits::default());
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _running = budget.run(Phase::Call);
            panic!("out of the call");
        }));
        assert!(unwound.is_err());
        // No clock left running: the next call starts its own.
        assert!(budget.run(Phase::Call).started);
    }

    #[test]
    fn calls_without_a_budget_are_never_interrupted() {
        let budget = Budget::new(Limits::standalone());
        let mut interrupt = budget.interrupt_handler(None);
        let outer = budget.run(Phase::Load);
        assert!(outer.started);
        assert!(budget.deadline.get().is_none());
        // Nested calls still share the outer one's (absent) budget.
        assert!(!budget.run(Phase::Call).started);
        assert!(!interrupt());
        drop(outer);
        assert!(budget.run(Phase::Call).started);
        assert!(budget.take_trip().is_none());
    }
}
