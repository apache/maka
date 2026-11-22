//! Unhandled promise rejections, reported as browsers report them.
//!
//! QuickJS tells the host when a promise is rejected while it has no
//! handler (`is_handled` false) and when such a promise gets one later
//! (true). The first kind waits here until the host has drained the job
//! queue at the end of a turn ([`crate::Host::run_jobs`]); the promises
//! still unhandled then are reported (logged, target `js`). A handler
//! attached later in the same turn (`const p = f(); …; p.catch(…)`) thus
//! makes no report. One attached in a later turn comes after the report,
//! which stands: the promise left this set when it was reported.
//!
//! Each waiting promise is held (a counted reference, a GC root as any
//! value the host holds) until it is reported or handled: its address is
//! its identity meanwhile, and nothing outlives that. The host frees what
//! is left before the runtime.

use rquickjs::{Ctx, Persistent, Value, qjs};

/// A rejected promise without a handler, and what it was rejected with.
pub(crate) struct Rejection {
    /// The promise object's address (its identity while it is held).
    key: usize,
    _promise: Persistent<Value<'static>>,
    reason: Persistent<Value<'static>>,
}

impl Rejection {
    /// What the promise was rejected with.
    pub(crate) fn reason<'js>(self, cx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        self.reason.restore(cx)
    }
}

/// The rejections waiting for the end of the turn.
#[derive(Default)]
pub(crate) struct Rejections {
    pending: Vec<Rejection>,
}

impl Rejections {
    /// What QuickJS's tracker reports: `promise` was rejected with
    /// `reason` and has no handler (`handled` false), or has one now.
    pub(crate) fn track<'js>(
        &mut self,
        cx: &Ctx<'js>,
        promise: Value<'js>,
        reason: Value<'js>,
        handled: bool,
    ) {
        let key = key(&promise);
        if handled {
            if let Some(at) = self.pending.iter().position(|r| r.key == key) {
                self.pending.remove(at);
            }
            return;
        }
        // An interrupt (the CPU budget, the engine stopping) is the host's
        // doing, reported as such: QuickJS rejects nothing with it, and
        // this keeps it so.
        // SAFETY: an inline check of a live value.
        if unsafe { qjs::JS_IsUncatchableError(reason.as_raw()) } {
            return;
        }
        self.pending.push(Rejection {
            key,
            _promise: Persistent::save(cx, promise),
            reason: Persistent::save(cx, reason),
        });
    }

    /// The rejections still unhandled, in the order they happened; the set
    /// is empty after.
    pub(crate) fn take(&mut self) -> Vec<Rejection> {
        std::mem::take(&mut self.pending)
    }

    /// How many wait (tests).
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.pending.len()
    }

    /// Drops them all (the host does before the runtime goes).
    pub(crate) fn clear(&mut self) {
        self.pending.clear();
    }
}

fn key(promise: &Value<'_>) -> usize {
    // SAFETY: an inline read of the object pointer (the tracker only
    // reports promises, which are objects).
    unsafe { qjs::JS_VALUE_GET_PTR(promise.as_raw()) as usize }
}
