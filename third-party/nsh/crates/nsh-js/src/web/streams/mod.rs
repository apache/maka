//! The Streams Standard: `ReadableStream` (default and byte streams, their
//! readers and controllers, `tee`, `pipeTo` / `pipeThrough`, `from`, async
//! iteration), `WritableStream`, `TransformStream`, the queuing strategies,
//! and `TextEncoderStream` / `TextDecoderStream`.
//!
//! The algorithms follow the standard's names and steps; an algorithm the
//! standard parameterizes (pull, write, ...) is an [`Algo`]: a method of the
//! underlying source / sink / transformer, or a native closure (the
//! streams `fetch` and `Blob.stream()` make).

pub(crate) mod readable;
mod text;
pub(crate) mod transform;
pub(crate) mod writable;

use std::collections::VecDeque;

use super::{
    Class, Object, Spec, data, instance,
    js::{self, Ctx, R, Raw, V, native, trace},
};

/// An algorithm of a stream: `f` called on `this` (`f` undefined: does
/// nothing, resolved).
#[derive(Default)]
pub(crate) struct Algo {
    f: V,
    this: V,
}

trace!(Algo { f, this });

impl Algo {
    /// A method of an underlying object (`f` undefined: none).
    pub(crate) fn method(f: V, this: &V) -> Algo {
        Algo {
            f,
            this: this.clone_ref(),
        }
    }

    /// A native closure.
    pub(crate) fn native(f: V) -> Algo {
        Algo {
            f,
            this: V::undefined(),
        }
    }

    pub(crate) fn clone_ref(&self) -> Algo {
        Algo {
            f: self.f.clone_ref(),
            this: self.this.clone_ref(),
        }
    }

    /// Calls it (exceptions propagate): undefined when there is none.
    pub(crate) fn call(&self, cx: Ctx, args: &[Raw]) -> R<V> {
        if self.f.is_undefined() {
            return Ok(V::undefined());
        }
        js::call(cx, self.f.raw(), self.this.raw(), args)
    }

    /// Calls it as a promise (exceptions reject it).
    pub(crate) fn promise(&self, cx: Ctx, args: &[Raw]) -> R<V> {
        js::promise_of(cx, || self.call(cx, args))
    }
}

/// The method `name` of underlying object `obj` (undefined or a function).
pub(crate) fn method(cx: Ctx, obj: Raw, name: &str) -> R<V> {
    if !js::is_object(obj) {
        return Ok(V::undefined());
    }
    Ok(js::get_method(cx, obj, name)?.unwrap_or_default())
}

/// A queue with sizes (`[[queue]]`, `[[queueTotalSize]]`).
#[derive(Default)]
pub(crate) struct SizedQueue {
    items: VecDeque<(V, f64)>,
    pub(crate) total: f64,
}

trace!(SizedQueue { items });

impl SizedQueue {
    /// EnqueueValueWithSize.
    pub(crate) fn enqueue(&mut self, cx: Ctx, value: V, size: f64) -> R<()> {
        if !size.is_finite() || size < 0.0 {
            return Err(js::range_error(
                cx,
                "the chunk size must be a finite, non-negative number",
            ));
        }
        self.items.push_back((value, size));
        self.total += size;
        Ok(())
    }

    /// DequeueValue.
    pub(crate) fn dequeue(&mut self) -> Option<V> {
        let (v, size) = self.items.pop_front()?;
        self.total = (self.total - size).max(0.0);
        Some(v)
    }

    pub(crate) fn peek(&self) -> Option<&V> {
        self.items.front().map(|(v, _)| v)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// ResetQueue (the values are freed after the caller's borrow ends).
    pub(crate) fn reset(&mut self) -> VecDeque<(V, f64)> {
        self.total = 0.0;
        std::mem::take(&mut self.items)
    }
}

/// A `QueuingStrategy` dictionary.
pub(crate) struct QueuingStrategy {
    hwm: Option<f64>,
    /// The size algorithm (undefined: every chunk is 1).
    pub(crate) size: V,
}

impl QueuingStrategy {
    /// Converts `strategy` (undefined: the defaults).
    pub(crate) fn read(cx: Ctx, strategy: Raw) -> R<QueuingStrategy> {
        if js::is_nullish(strategy) {
            return Ok(QueuingStrategy {
                hwm: None,
                size: V::undefined(),
            });
        }
        if !js::is_object(strategy) {
            return Err(js::type_error(cx, "the queuing strategy must be an object"));
        }
        let hwm = js::get(cx, strategy, "highWaterMark")?;
        let hwm = if hwm.is_undefined() {
            None
        } else {
            Some(js::to_number(cx, hwm.raw())?)
        };
        let size = js::get(cx, strategy, "size")?;
        if !size.is_undefined() && !js::is_function(cx, size.raw()) {
            return Err(js::type_error(cx, "size must be a function"));
        }
        Ok(QueuingStrategy { hwm, size })
    }

    /// ExtractHighWaterMark.
    pub(crate) fn high_water_mark(&self, cx: Ctx, default: f64) -> R<f64> {
        match self.hwm {
            None => Ok(default),
            Some(n) if n.is_nan() || n < 0.0 => Err(js::range_error(
                cx,
                "highWaterMark must be a non-negative number",
            )),
            Some(n) => Ok(n),
        }
    }
}

/// Calls size algorithm `size` (undefined: 1) on `chunk`.
pub(crate) fn chunk_size(cx: Ctx, size: &V, chunk: Raw) -> R<f64> {
    if size.is_undefined() {
        return Ok(1.0);
    }
    let n = js::call(cx, size.raw(), js::UNDEFINED, &[chunk])?;
    js::to_number(cx, n.raw())
}

// --- Queuing strategies ---------------------------------------------------

struct Strategy {
    high_water_mark: f64,
}

trace!(Strategy {});

impl Object for Strategy {}

fn strategy_init(cx: Ctx, init: Raw) -> R<f64> {
    if !js::is_object(init) {
        return Err(js::type_error(cx, "the strategy needs { highWaterMark }"));
    }
    let hwm = js::get(cx, init, "highWaterMark")?;
    if hwm.is_undefined() {
        return Err(js::type_error(cx, "highWaterMark is required"));
    }
    js::to_number(cx, hwm.raw())
}

native!(
    fn byte_strategy_constructor(cx, this, args) {
        let high_water_mark = strategy_init(cx, args.get(0))?;
        instance(cx, this, Class::ByteLengthQueuingStrategy, Strategy { high_water_mark })
    }
);

native!(
    fn count_strategy_constructor(cx, this, args) {
        let high_water_mark = strategy_init(cx, args.get(0))?;
        instance(cx, this, Class::CountQueuingStrategy, Strategy { high_water_mark })
    }
);

native!(
    fn strategy_hwm(cx, this, args) {
        Ok(V::num(data::<Strategy>(cx, this, "queuing strategy")?.high_water_mark))
    }
);

native!(
    fn byte_size(cx, this, args) {
        js::get(cx, args.get(0), "byteLength")
    }
);

native!(
    fn count_size(cx, this, args) {
        Ok(V::num(1.0))
    }
);

native!(
    fn byte_strategy_size(cx, this, args) {
        data::<Strategy>(cx, this, "ByteLengthQueuingStrategy")?;
        super::cached_function(cx, 0, c"size", byte_size)
    }
);

native!(
    fn count_strategy_size(cx, this, args) {
        data::<Strategy>(cx, this, "CountQueuingStrategy")?;
        super::cached_function(cx, 1, c"size", count_size)
    }
);

// --- Native streams -------------------------------------------------------

/// A byte stream of `bytes` (`Blob.stream()`, bodies known up front).
pub(crate) fn bytes_stream(cx: Ctx, bytes: Vec<u8>) -> R<V> {
    let bytes = std::rc::Rc::new(std::cell::RefCell::new(Some(bytes)));
    let pull = js::closure(cx, Vec::new(), move |cx, _, args| {
        let controller = args.get(0);
        if let Some(b) = bytes.borrow_mut().take()
            && !b.is_empty()
        {
            readable::enqueue_bytes(cx, controller, &b)?;
        }
        readable::close_controller(cx, controller)?;
        Ok(V::undefined())
    })?;
    let (stream, _) = readable::new_byte_stream(cx, Algo::native(pull), Algo::default(), 0.0)?;
    Ok(stream)
}

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        class: Class::ByteLengthQueuingStrategy,
        name: c"ByteLengthQueuingStrategy",
        parent: None,
        constructor: Some((byte_strategy_constructor, 1)),
        methods: &[],
        accessors: &[
            (c"highWaterMark", strategy_hwm, None),
            (c"size", byte_strategy_size, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: " implements QueuingStrategy<ArrayBufferView>",
            members: r#"constructor(init: { highWaterMark: number });
readonly highWaterMark: number;
readonly size: (chunk: ArrayBufferView) => number;"#,
        }
        .declared(),
    },
    Spec {
        class: Class::CountQueuingStrategy,
        name: c"CountQueuingStrategy",
        parent: None,
        constructor: Some((count_strategy_constructor, 1)),
        methods: &[],
        accessors: &[
            (c"highWaterMark", strategy_hwm, None),
            (c"size", count_strategy_size, None),
        ],
        statics: &[],
        constants: &[],
        global: true,
        ts: crate::web::ClassTs {
            doc: "",
            head: " implements QueuingStrategy",
            members: r#"constructor(init: { highWaterMark: number });
readonly highWaterMark: number;
readonly size: (chunk: any) => 1;"#,
        }
        .declared(),
    },
];

/// All classes of the streams.
pub(crate) fn specs() -> impl Iterator<Item = &'static Spec> {
    [
        SPECS,
        readable::SPECS,
        writable::SPECS,
        transform::SPECS,
        text::SPECS,
    ]
    .into_iter()
    .flatten()
}

/// The TypeScript types of this file's classes (`globals.d.ts`).
pub(crate) const TYPES: &str = r#"interface QueuingStrategy<T = any> {
  highWaterMark?: number;
  size?: (chunk: T) => number;
}
"#;
