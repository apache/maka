//! The virtualized, recycling list: `<List>` (the `list` of `nsh:rt`) and
//! the rows of Rust components that lay out the app's items (`ListView`).
//!
//! Only rows near the viewport exist: the core decides which and asks for
//! cells (`Host::bind_list`, answered here without JS), and reuses them: a
//! recycled cell gets a new index, its item accessor follows. Positions,
//! columns, sticky headers and viewability are native.

use std::{
    cell::RefCell,
    ffi::{CStr, CString, c_int},
    ptr,
};

use nsh_core::{
    Command, EventKind, NodeId, Op, Tag,
    geometry::{Percentage, Points},
};
use rquickjs::qjs;
use rustc_hash::FxHashMap;

use crate::{
    dom,
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The host props a list forwards as they are (`viewport` first: the
/// mode decides how the core takes the others).
const FORWARDED: &[&str] = &[
    "viewport",
    "style",
    "testID",
    "horizontal",
    "scrollbar",
    "refreshing",
    "onRefresh",
    "pullValue",
    "refreshIndicator",
    "onLoadMore",
    "onLoadMoreAtStart",
    "onScrollEnd",
    "scrollValue",
    "keyboardDismissMode",
    "numColumns",
    "inverted",
    "alignment",
    "maintainVisibleContentPosition",
    "stickyHeaderIndices",
    "stickyHeaderOffset",
    "contentStyle",
    "contentClass",
    "viewabilityConfig",
    "pagingEnabled",
    "snapToInterval",
    "snapToOffsets",
    "snapToAlignment",
    "decelerationRate",
    "scrollable",
    "bounces",
    "contentInset",
    "contentOffset",
    "keyboardShouldPersistTaps",
    "scrollEventThrottle",
    "disableIntervalMomentum",
    "onScroll",
    "onScrollIntent",
    "onScrollDragStart",
    "onScrollDragEnd",
    "onMomentumStart",
    "onMomentumEnd",
];

/// The props the list itself uses: every other prop the app passes (the
/// test id, accessibility, classes, touch and layout events, ...) goes to
/// the scroll view as it would on a `<Scroll>`, as React Native's
/// `FlatList` passes the rest to its `ScrollView`.
const OWN: &[&str] = &[
    "each",
    "children",
    "ref",
    "keyExtractor",
    "estimatedItemSize",
    "loadMoreThreshold",
    "loadMoreAtStartThreshold",
    "initialScrollIndex",
    "initialScrollAtEnd",
    "onViewableItemsChange",
    "header",
    "footer",
    "empty",
    "separator",
];

/// What the app passes a Rust component's rows (`listItemsProps` of the
/// JS glue): the data and the rows; the component lays them out.
pub(crate) const ITEMS_PROPS: &[&str] = &[
    "each",
    "children",
    "keyExtractor",
    "stickyHeaderIndices",
    "initialScrollIndex",
    "initialScrollAtEnd",
    "onViewableItemsChange",
    "viewabilityConfig",
    "refreshing",
    "onRefresh",
    "onLoadMore",
    "loadMoreThreshold",
    "header",
    "footer",
    "empty",
];

struct Cell {
    node: JsValue,
    /// The index signal.
    index: JsValue,
    owner: u32,
}

struct ListData {
    props: JsValue,
    node: JsValue,
    /// The items memo (`props.each`), which the cells' items read.
    items: JsValue,
    /// How the items changed (`[at, removed, inserted]`), for the core.
    splices: Vec<[u32; 3]>,
    /// The owner the list was made under: cells are made as its roots.
    owner: u32,
    /// Cells by slot.
    cells: Vec<Option<Cell>>,
    /// Owners of the header, footer and empty cells.
    extras: Vec<u32>,
    /// The viewable range reported last, and the latest.
    reported: (i64, i64),
    latest: (i64, i64),
    /// A pending `minimumViewTime` timer's id.
    timer: Option<f64>,
}

/// The lists' part of a context's state: each list by its node id.
#[derive(Default)]
pub(crate) struct Lists {
    map: RefCell<FxHashMap<NodeId, Box<ListData>>>,
}

impl Lists {
    /// Frees the values the lists hold (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        for (_, data) in self.map.borrow_mut().drain() {
            free_data(raw, *data);
        }
    }
}

fn free_data(cx: *mut JsContext, data: ListData) {
    // SAFETY: values the list owned.
    unsafe {
        qjs::JS_FreeValue(cx, data.props);
        qjs::JS_FreeValue(cx, data.node);
        qjs::JS_FreeValue(cx, data.items);
        for cell in data.cells.into_iter().flatten() {
            qjs::JS_FreeValue(cx, cell.node);
            qjs::JS_FreeValue(cx, cell.index);
        }
    }
}

fn lists<'a>(cx: *mut JsContext) -> &'a Lists {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).lists }
}

fn get(cx: *mut JsContext, obj: JsValue, key: &str) -> JsValue {
    let k = CString::new(key).unwrap_or_default();
    // SAFETY: a property read of a live value.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return UNDEFINED;
        }
        qjs::JS_GetPropertyStr(cx, obj, k.as_ptr())
    }
}

fn has(cx: *mut JsContext, obj: JsValue, key: &str) -> bool {
    // SAFETY: as `get`.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return false;
        }
        let k = CString::new(key).unwrap_or_default();
        let atom = qjs::JS_NewAtom(cx, k.as_ptr());
        let r = qjs::JS_HasProperty(cx, obj, atom);
        qjs::JS_FreeAtom(cx, atom);
        r == 1
    }
}

fn length(cx: *mut JsContext, array: JsValue) -> i64 {
    let mut len: i64 = 0;
    // SAFETY: reads a live value's length (0 for non-arrays).
    unsafe {
        if !qjs::JS_IsArray(array) || qjs::JS_GetLength(cx, array, &mut len) != 0 {
            return 0;
        }
    }
    len
}

/// Immutable indexed sources expose their length without reading any rows.
fn source_length(cx: *mut JsContext, source: JsValue) -> Result<i64, JsValue> {
    // SAFETY: reads and conversions of values owned by the caller or guards.
    unsafe {
        if qjs::JS_IsException(source) {
            return Err(source);
        }
        if qjs::JS_IsArray(source) || !qjs::JS_IsObject(source) {
            return Ok(length(cx, source));
        }
        let at = Guard(cx, get(cx, source, "at"));
        if qjs::JS_IsException(at.1) {
            return Err(at.1);
        }
        if !qjs::JS_IsFunction(cx, at.1) {
            return Err(qjs::JS_ThrowTypeError(
                cx,
                c"List source requires an at(index) method".as_ptr(),
            ));
        }
        let value = Guard(cx, get(cx, source, "length"));
        if qjs::JS_IsException(value.1) {
            return Err(value.1);
        }
        let mut count = 0.0;
        if !qjs::JS_IsNumber(value.1)
            || qjs::JS_ToFloat64(cx, &mut count, value.1) != 0
            || !count.is_finite()
            || count < 0.0
            || count > u32::MAX as f64
            || count.fract() != 0.0
        {
            return Err(qjs::JS_ThrowRangeError(
                cx,
                c"List source length must be an unsigned 32-bit integer".as_ptr(),
            ));
        }
        Ok(count as i64)
    }
}

/// Reads only the row requested by a cell or a viewability report.
fn source_item(cx: *mut JsContext, source: JsValue, index: i64) -> JsValue {
    // SAFETY: reads one row, calling the snapshot method with its own receiver.
    unsafe {
        if qjs::JS_IsArray(source) {
            return qjs::JS_GetPropertyInt64(cx, source, index);
        }
        let at = Guard(cx, get(cx, source, "at"));
        if qjs::JS_IsException(at.1) {
            return at.1;
        }
        let mut args = [qjs::JS_NewFloat64(index as f64)];
        qjs::JS_Call(cx, at.1, source, 1, args.as_mut_ptr())
    }
}

fn native(
    cx: *mut JsContext,
    f: unsafe extern "C" fn(
        *mut JsContext,
        JsValue,
        c_int,
        *mut JsValue,
        c_int,
        *mut JsValue,
    ) -> JsValue,
    length: c_int,
    data: &mut [JsValue],
) -> JsValue {
    // SAFETY: the function keeps dups of `data`.
    unsafe {
        qjs::JS_NewCFunctionData(
            cx,
            Some(f),
            length,
            0,
            data.len() as c_int,
            data.as_mut_ptr(),
        )
    }
}

/// `list(props)`: a virtualized list of `props.each`, rendering a row with
/// `props.children(item, index)` per cell.
pub(crate) unsafe extern "C" fn list(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    match render(cx, arg(argc, argv, 0)) {
        Ok(node) => reactive::finish_value(cx, node),
        Err(e) => e,
    }
}

/// Renders a list for `props` (borrowed); the list's node (owned).
pub(crate) fn render(cx: *mut JsContext, props: JsValue) -> Result<JsValue, JsValue> {
    let node = dom::create_element(cx, Tag::List)?;
    let id = dom::node_id(cx, node).expect("a node");
    // SAFETY: dups the list owns.
    let data = Box::new(ListData {
        props: unsafe { qjs::JS_DupValue(cx, props) },
        node: unsafe { qjs::JS_DupValue(cx, node) },
        items: UNDEFINED,
        splices: Vec::new(),
        owner: reactive::current_owner(cx),
        cells: Vec::new(),
        extras: Vec::new(),
        reported: (-1, -1),
        latest: (-1, -1),
        timer: None,
    });
    lists(cx).map.borrow_mut().insert(id, data);
    let fail = |e: JsValue| {
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, node) };
        e
    };
    // The items: cells move with theirs, and the core learns how they
    // changed (by identity: the common start and end stay), so
    // measurements follow their items.
    let list_id = qjs::JS_NewFloat64(id as f64);
    let func = native(cx, items_run, 1, &mut [list_id, props]);
    let items = reactive::memo(cx, func, false);
    let func = native(cx, splice_run, 0, &mut [node, items, list_id]);
    match lists(cx).map.borrow_mut().get_mut(&id) {
        Some(d) => d.items = items,
        // SAFETY: ours (the list went meanwhile).
        None => unsafe { qjs::JS_FreeValue(cx, items) },
    }
    let r = reactive::render_effect(cx, func);
    // SAFETY: the effect keeps its own value.
    unsafe { qjs::JS_FreeValue(cx, r) };
    // The forwarded props, the estimated size, the end threshold and the
    // host props passed on.
    let rest = rest_names(cx, props).map_err(fail)?;
    // SAFETY: a new array of the previous values.
    let prev = unsafe { qjs::JS_NewArray(cx) };
    let func = native(cx, forward_run, 0, &mut [node, props, prev, rest]);
    // SAFETY: the function keeps dups.
    unsafe {
        qjs::JS_FreeValue(cx, prev);
        qjs::JS_FreeValue(cx, rest);
    }
    let r = reactive::render_effect(cx, func);
    unsafe { qjs::JS_FreeValue(cx, r) };
    // Header and footer cells (always rendered), and the empty one.
    for (role, key) in [("header", "header"), ("footer", "footer")] {
        if has(cx, props, key) {
            let owner = extra_cell(cx, id, role, key).map_err(fail)?;
            if let Some(d) = lists(cx).map.borrow_mut().get_mut(&id) {
                d.extras.push(owner);
            }
        }
    }
    if has(cx, props, "empty") {
        // SAFETY: a placeholder for the empty cell's state (owner, node).
        let state = unsafe { qjs::JS_NewArray(cx) };
        let func = native(cx, empty_run, 0, &mut [node, props, state]);
        unsafe { qjs::JS_FreeValue(cx, state) };
        let r = reactive::render_effect(cx, func);
        unsafe { qjs::JS_FreeValue(cx, r) };
    }
    if has(cx, props, "onViewableItemsChange") {
        let mut data = [qjs::JS_NewFloat64(id as f64)];
        let on = native(cx, on_viewable, 1, &mut data);
        let r = dom::set_handler(cx, id, EventKind::ViewableItemsChange, on);
        unsafe { qjs::JS_FreeValue(cx, on) };
        r.map_err(fail)?;
    }
    let initial = get(cx, props, "initialScrollIndex");
    let at_end = get(cx, props, "initialScrollAtEnd");
    // SAFETY: these live values are read and released before queuing the op.
    let initial_command = unsafe {
        let command = if qjs::JS_ToBool(cx, at_end) > 0 {
            Some(Command::ScrollToEnd { animated: false })
        } else if qjs::JS_IsNumber(initial) {
            let mut index = 0f64;
            qjs::JS_ToFloat64(cx, &mut index, initial);
            Some(Command::ScrollToIndex {
                index: index.max(0.0) as u32,
                animated: false,
                automatic: false,
                view_position: Percentage(0.0),
                view_offset: Points::ZERO,
            })
        } else {
            None
        };
        qjs::JS_FreeValue(cx, initial);
        qjs::JS_FreeValue(cx, at_end);
        command
    };
    if let Some(command) = initial_command {
        dom::push_op(cx, Op::Command { id, command }).map_err(fail)?;
    }
    let ref_ = get(cx, props, "ref");
    // SAFETY: a live value, called untracked with the node.
    unsafe {
        if qjs::JS_IsFunction(cx, ref_) {
            let mut args = [node];
            let r = reactive::untracked_with(cx, || {
                qjs::JS_Call(cx, ref_, UNDEFINED, 1, args.as_mut_ptr())
            });
            qjs::JS_FreeValue(cx, ref_);
            if qjs::JS_IsException(r) {
                return Err(fail(r));
            }
            qjs::JS_FreeValue(cx, r);
        } else {
            qjs::JS_FreeValue(cx, ref_);
        }
    }
    // Gone with its owner: the cells and the binding.
    let cleanup = native(cx, dispose, 0, &mut [qjs::JS_NewFloat64(id as f64)]);
    let mut args = [cleanup];
    // SAFETY: registers the cleanup on the current owner.
    unsafe {
        let r = reactive::on_cleanup(cx, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, r);
        qjs::JS_FreeValue(cx, cleanup);
    }
    Ok(node)
}

unsafe extern "C" fn dispose(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let mut id = 0f64;
    // SAFETY: one data value, the list's id.
    unsafe { qjs::JS_ToFloat64(cx, &mut id, *data) };
    let Some(data) = lists(cx).map.borrow_mut().remove(&(id as NodeId)) else {
        return UNDEFINED;
    };
    for cell in data.cells.iter().flatten() {
        reactive::dispose_owner(cx, cell.owner);
    }
    for &owner in &data.extras {
        reactive::dispose_owner(cx, owner);
    }
    free_data(cx, *data);
    UNDEFINED
}

fn set(cx: *mut JsContext, node: JsValue, name: &str, value: JsValue) -> Result<(), JsValue> {
    let r = dom::set_prop_value(cx, node, name, value);
    // SAFETY: ours.
    unsafe { qjs::JS_FreeValue(cx, value) };
    r
}

/// An indexed source can name the changed span relative to the previous source.
fn indexed_splice(
    cx: *mut JsContext,
    old: JsValue,
    next: JsValue,
    old_len: i64,
    next_len: i64,
) -> Result<(i64, i64, i64), JsValue> {
    // SAFETY: inputs are borrowed from the items memo; owned results have guards.
    unsafe {
        let diff = Guard(cx, get(cx, next, "spliceFrom"));
        if qjs::JS_IsException(diff.1) {
            return Err(diff.1);
        }
        if qjs::JS_IsFunction(cx, diff.1) {
            let mut args = [old];
            let result = Guard(cx, qjs::JS_Call(cx, diff.1, next, 1, args.as_mut_ptr()));
            if qjs::JS_IsException(result.1) {
                return Err(result.1);
            }
            if !qjs::JS_IsUndefined(result.1) {
                let number = |index| {
                    let value = Guard(cx, qjs::JS_GetPropertyUint32(cx, result.1, index));
                    if qjs::JS_IsException(value.1) {
                        return Err(value.1);
                    }
                    let mut raw = 0.0;
                    let valid = qjs::JS_IsNumber(value.1)
                        && qjs::JS_ToFloat64(cx, &mut raw, value.1) == 0
                        && (0.0..=f64::from(u32::MAX)).contains(&raw)
                        && raw.fract() == 0.0;
                    Ok(valid.then_some(raw as i64))
                };
                if qjs::JS_IsArray(result.1)
                    && length(cx, result.1) == 3
                    && let (Some(at), Some(removed), Some(inserted)) =
                        (number(0)?, number(1)?, number(2)?)
                    && at + removed <= old_len
                    && old_len - removed + inserted == next_len
                {
                    return Ok((at, removed, inserted));
                }
                return Err(qjs::JS_ThrowRangeError(
                    cx,
                    c"Invalid indexed list splice".as_ptr(),
                ));
            }
        }
        Ok((0, old_len, next_len))
    }
}

/// A run of the items memo: the items, once the cells moved with theirs
/// (as the core moves them, and Rust lists' `move_rows`): otherwise each
/// shows the item now at its old index until it is bound again.
unsafe extern "C" fn items_run(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values; values got are freed or returned.
    unsafe {
        let (list, props) = (*data, *data.add(1));
        let old = arg(argc, argv, 0);
        let next = get(cx, props, "each");
        if qjs::JS_IsException(next) {
            return next;
        }
        let (old_len, next_len) = match source_length(cx, old)
            .and_then(|old_len| source_length(cx, next).map(|next_len| (old_len, next_len)))
        {
            Ok(lengths) => lengths,
            Err(error) => {
                qjs::JS_FreeValue(cx, next);
                return error;
            }
        };
        if old_len > 0 && !qjs::JS_IsStrictEqual(cx, old, next) {
            let (start, removed, inserted) = if qjs::JS_IsArray(old) && qjs::JS_IsArray(next) {
                let max = old_len.min(next_len);
                // With a `keyExtractor`, rows are the same when their keys
                // are: apps that rebuild their rows (new objects, same keys)
                // keep the rows' measurements and the reader's place.
                let key_of = get(cx, props, "keyExtractor");
                let keyed = qjs::JS_IsFunction(cx, key_of);
                let key = |item: JsValue, i: i64| {
                    let mut args = [qjs::JS_DupValue(cx, item), qjs::JS_NewFloat64(i as f64)];
                    let k = qjs::JS_Call(cx, key_of, UNDEFINED, 2, args.as_mut_ptr());
                    qjs::JS_FreeValue(cx, args[0]);
                    k
                };
                let same = |i: i64, j: i64| {
                    let a = qjs::JS_GetPropertyInt64(cx, old, i);
                    let b = qjs::JS_GetPropertyInt64(cx, next, j);
                    let mut s = qjs::JS_IsStrictEqual(cx, a, b);
                    if !s && keyed {
                        let (ka, kb) = (key(a, i), key(b, j));
                        s = !qjs::JS_IsException(ka)
                            && !qjs::JS_IsException(kb)
                            && qjs::JS_IsStrictEqual(cx, ka, kb);
                        for k in [ka, kb] {
                            if qjs::JS_IsException(k) {
                                qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
                            } else {
                                qjs::JS_FreeValue(cx, k);
                            }
                        }
                    }
                    qjs::JS_FreeValue(cx, a);
                    qjs::JS_FreeValue(cx, b);
                    s
                };
                let mut start = 0;
                while start < max && same(start, start) {
                    start += 1;
                }
                let mut end = 0;
                while end < max - start && same(old_len - 1 - end, next_len - 1 - end) {
                    end += 1;
                }
                qjs::JS_FreeValue(cx, key_of);
                (start, old_len - start - end, next_len - start - end)
            } else {
                match indexed_splice(cx, old, next, old_len, next_len) {
                    Ok(span) => span,
                    Err(error) => {
                        qjs::JS_FreeValue(cx, next);
                        return error;
                    }
                }
            };
            if removed > 0 || inserted > 0 {
                let mut id = 0f64;
                qjs::JS_ToFloat64(cx, &mut id, list);
                let indices: Vec<JsValue> =
                    match lists(cx).map.borrow_mut().get_mut(&(id as NodeId)) {
                        Some(d) => {
                            d.splices
                                .push([start as u32, removed as u32, inserted as u32]);
                            d.cells
                                .iter()
                                .flatten()
                                .map(|c| qjs::JS_DupValue(cx, c.index))
                                .collect()
                        }
                        None => Vec::new(),
                    };
                for index in indices {
                    if let Some(i) = reactive::peek_number(cx, index)
                        && i as i64 >= start + removed
                    {
                        let moved = i + (inserted - removed) as f64;
                        reactive::set_signal(cx, index, qjs::JS_NewFloat64(moved));
                    }
                    qjs::JS_FreeValue(cx, index);
                }
            }
        }
        next
    }
}

/// A run of the items effect: tells the core how the items changed and
/// their count.
unsafe extern "C" fn splice_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values; values got are freed.
    unsafe {
        let (node, items, list) = (*data, *data.add(1), *data.add(2));
        let next = qjs::JS_Call(cx, items, UNDEFINED, 0, ptr::null_mut());
        if qjs::JS_IsException(next) {
            return next;
        }
        let len = match source_length(cx, next) {
            Ok(len) => len,
            Err(error) => {
                qjs::JS_FreeValue(cx, next);
                return error;
            }
        };
        qjs::JS_FreeValue(cx, next);
        let mut id = 0f64;
        qjs::JS_ToFloat64(cx, &mut id, list);
        let splices = lists(cx)
            .map
            .borrow_mut()
            .get_mut(&(id as NodeId))
            .map(|d| std::mem::take(&mut d.splices))
            .unwrap_or_default();
        for [at, removed, inserted] in splices {
            let mut values = [
                qjs::JS_NewFloat64(at as f64),
                qjs::JS_NewFloat64(removed as f64),
                qjs::JS_NewFloat64(inserted as f64),
            ];
            let splice = qjs::JS_NewArrayFrom(cx, 3, values.as_mut_ptr());
            if let Err(e) = set(cx, node, "splice", splice) {
                return e;
            }
        }
        if let Err(e) = set(cx, node, "count", qjs::JS_NewFloat64(len as f64)) {
            return e;
        }
        UNDEFINED
    }
}

/// A run of the forwarding effect: sends the props that changed.
unsafe extern "C" fn forward_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: four data values; the array keeps dups of the values.
    unsafe {
        let (node, props, prev, rest) = (*data, *data.add(1), *data.add(2), *data.add(3));
        let names = FORWARDED.iter().map(|&n| (n, n)).chain([
            ("estimatedItemSize", "estimatedItemSize"),
            ("loadMoreThreshold", "loadMoreThreshold"),
            ("loadMoreAtStartThreshold", "loadMoreAtStartThreshold"),
        ]);
        let mut at = 0;
        for (wire, key) in names {
            if let Err(e) = forward(cx, node, props, prev, at, wire, key) {
                return e;
            }
            at += 1;
        }
        for i in 0..length(cx, rest) {
            let name = qjs::JS_GetPropertyInt64(cx, rest, i);
            let s = qjs::JS_ToCString(cx, name);
            qjs::JS_FreeValue(cx, name);
            if s.is_null() {
                return qjs::JS_EXCEPTION;
            }
            let result = match CStr::from_ptr(s).to_str() {
                Ok(key) => forward(cx, node, props, prev, at, key, key),
                Err(_) => Ok(()),
            };
            qjs::JS_FreeCString(cx, s);
            if let Err(e) = result {
                return e;
            }
            at += 1;
        }
        UNDEFINED
    }
}

/// Sends prop `wire` of the list (`props[key]`) when it changed from the
/// value kept at `prev[at]`.
fn forward(
    cx: *mut JsContext,
    node: JsValue,
    props: JsValue,
    prev: JsValue,
    at: u32,
    wire: &str,
    key: &str,
) -> Result<(), JsValue> {
    let mut value = get(cx, props, key);
    // SAFETY: inline checks and reads of live values; `prev` keeps the
    // value, the old one is freed.
    unsafe {
        if qjs::JS_IsException(value) {
            return Err(value);
        }
        if qjs::JS_IsUndefined(value) || qjs::JS_IsNull(value) {
            value = match wire {
                "estimatedItemSize" => qjs::JS_NewFloat64(50.0),
                "loadMoreThreshold" | "loadMoreAtStartThreshold" => qjs::JS_NewFloat64(1.0),
                _ => value,
            };
        }
        let old = qjs::JS_GetPropertyUint32(cx, prev, at);
        let first = qjs::JS_IsUndefined(old)
            && !matches!(
                wire,
                "estimatedItemSize" | "loadMoreThreshold" | "loadMoreAtStartThreshold"
            );
        let result = if qjs::JS_IsStrictEqual(cx, old, value) || first && qjs::JS_IsUndefined(value)
        {
            Ok(())
        } else {
            dom::set_prop_with_prev(cx, node, wire, value, old)
        };
        qjs::JS_FreeValue(cx, old);
        qjs::JS_SetPropertyUint32(cx, prev, at, value);
        result
    }
}

/// The names of the props in `props` (borrowed) the list passes on to its
/// scroll view (all but its own and the ones it forwards by name), as an
/// array (owned). Read once: compiled JSX gives a list the same props for
/// its whole life, their values change behind getters.
fn rest_names(cx: *mut JsContext, props: JsValue) -> Result<JsValue, JsValue> {
    // SAFETY: a new array; an enumeration of a live object's own names,
    // freed after use.
    unsafe {
        let out = qjs::JS_NewArray(cx);
        if !qjs::JS_IsObject(props) {
            return Ok(out);
        }
        let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
        let mut len: u32 = 0;
        if qjs::JS_GetOwnPropertyNames(
            cx,
            &mut tab,
            &mut len,
            props,
            (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_ENUM_ONLY) as c_int,
        ) != 0
        {
            qjs::JS_FreeValue(cx, out);
            return Err(qjs::JS_EXCEPTION);
        }
        let mut n = 0;
        for j in 0..len as usize {
            let name = qjs::JS_AtomToString(cx, (*tab.add(j)).atom);
            let s = qjs::JS_ToCString(cx, name);
            let pass = !s.is_null()
                && CStr::from_ptr(s)
                    .to_str()
                    .is_ok_and(|name| !OWN.contains(&name) && !FORWARDED.contains(&name));
            if !s.is_null() {
                qjs::JS_FreeCString(cx, s);
            }
            if pass {
                qjs::JS_SetPropertyUint32(cx, out, n, name);
                n += 1;
            } else {
                qjs::JS_FreeValue(cx, name);
            }
        }
        qjs::JS_FreePropertyEnum(cx, tab, len);
        Ok(out)
    }
}

/// A list slot's value: a component is called, an element used as is.
unsafe extern "C" fn slot_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (props, key); values got are freed.
    unsafe {
        let (props, key) = (*data, *data.add(1));
        let Some(key) = dom::string_arg(cx, key) else {
            return qjs::JS_EXCEPTION;
        };
        let value = get(cx, props, &key);
        slot(cx, value)
    }
}

/// `value` (owned) as a list slot renders it.
fn slot(cx: *mut JsContext, value: JsValue) -> JsValue {
    // `<If>` and `<Each>` are memos: called here, untracked, the slot would
    // keep their first value; the insert tracks them.
    let (signal, memo) = reactive::signal_kind(cx, value);
    // SAFETY: an inline check; a component is called untracked.
    unsafe {
        if qjs::JS_IsFunction(cx, value) && dom::node_id(cx, value).is_none() && !signal && !memo {
            let mut args = [qjs::JS_NewObject(cx)];
            let r = reactive::untracked_with(cx, || {
                qjs::JS_Call(cx, value, UNDEFINED, 1, args.as_mut_ptr())
            });
            qjs::JS_FreeValue(cx, args[0]);
            qjs::JS_FreeValue(cx, value);
            return r;
        }
    }
    value
}

/// A cell of role `role` (`header`, `footer`) showing `props[key]`, made as
/// a root under the list's owner; returns the root.
fn extra_cell(cx: *mut JsContext, id: NodeId, role: &str, key: &str) -> Result<u32, JsValue> {
    let (props, list, owner) = {
        let map = lists(cx).map.borrow();
        let d = &map[&id];
        (d.props, d.node, d.owner)
    };
    let (root, r) = reactive::with_root_under(cx, owner, || -> Result<(), JsValue> {
        let cell = dom::create_element(cx, Tag::Cell)?;
        let guard = Guard(cx, cell);
        set(cx, cell, "slot", new_string(cx, role))?;
        dom::insert_node(cx, list, cell, None)?;
        let key = new_string(cx, key);
        let reader = native(cx, slot_run, 0, &mut [props, key]);
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(cx, key) };
        let r = dom::insert_value_at(cx, cell, reader, None);
        unsafe { qjs::JS_FreeValue(cx, reader) };
        drop(guard);
        r
    });
    r.map(|()| root)
}

/// A JS value freed when dropped.
struct Guard(*mut JsContext, JsValue);

impl Drop for Guard {
    fn drop(&mut self) {
        // SAFETY: ours.
        unsafe { qjs::JS_FreeValue(self.0, self.1) };
    }
}

fn new_string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

/// The empty cell's effect: shown while there are no items. Its state is
/// an array: [owner, cell node].
unsafe extern "C" fn empty_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values; values got are freed.
    unsafe {
        let (list, props, state) = (*data, *data.add(1), *data.add(2));
        let each = get(cx, props, "each");
        let empty = match source_length(cx, each) {
            Ok(len) => len == 0,
            Err(error) => {
                qjs::JS_FreeValue(cx, each);
                return error;
            }
        };
        qjs::JS_FreeValue(cx, each);
        let shown = length(cx, state) > 0;
        if empty && !shown {
            let Some(id) = dom::node_id(cx, list) else {
                return UNDEFINED;
            };
            let owner = lists(cx).map.borrow().get(&id).map(|d| d.owner);
            let Some(owner) = owner else {
                return UNDEFINED;
            };
            let mut cell_node = UNDEFINED;
            let (root, r) = reactive::untracked_with(cx, || {
                reactive::with_root_under(cx, owner, || -> Result<(), JsValue> {
                    let cell = dom::create_element(cx, Tag::Cell)?;
                    cell_node = cell;
                    set(cx, cell, "slot", new_string(cx, "empty"))?;
                    dom::insert_node(cx, list, cell, None)?;
                    let key = new_string(cx, "empty");
                    let reader = native(cx, slot_run, 0, &mut [props, key]);
                    qjs::JS_FreeValue(cx, key);
                    let r = dom::insert_value_at(cx, cell, reader, None);
                    qjs::JS_FreeValue(cx, reader);
                    r
                })
            });
            qjs::JS_SetPropertyUint32(cx, state, 0, qjs::JS_NewFloat64(root as f64));
            qjs::JS_SetPropertyUint32(cx, state, 1, cell_node);
            if let Err(e) = r {
                return e;
            }
        } else if !empty && shown {
            let owner = qjs::JS_GetPropertyUint32(cx, state, 0);
            let cell = qjs::JS_GetPropertyUint32(cx, state, 1);
            let mut root = 0f64;
            qjs::JS_ToFloat64(cx, &mut root, owner);
            reactive::dispose_owner(cx, root as u32);
            let r = dom::remove_node(cx, list, cell);
            qjs::JS_FreeValue(cx, cell);
            qjs::JS_FreeValue(cx, owner);
            qjs::JS_SetPropertyStr(cx, state, c"length".as_ptr(), qjs::JS_NewFloat64(0.0));
            if let Err(e) = r {
                return e;
            }
        }
        UNDEFINED
    }
}

/// Answers the core's request for rows: `(slot, item index)` pairs. `None`
/// when `list` is not one of these lists.
pub(crate) fn bind(
    cx: *mut JsContext,
    list: NodeId,
    binds: &[(u32, u32)],
) -> Option<Result<(), ()>> {
    if !lists(cx).map.borrow().contains_key(&list) {
        return None;
    }
    let mut failed = false;
    reactive::batch_with(cx, || {
        for &(slot, index) in binds {
            let existing = lists(cx)
                .map
                .borrow()
                .get(&list)
                .and_then(|d| d.cells.get(slot as usize))
                .and_then(|c| c.as_ref().map(|c| c.index));
            match existing {
                Some(signal) => {
                    if reactive::peek_number(cx, signal) != Some(index as f64) {
                        reactive::set_signal(cx, signal, qjs::JS_NewFloat64(index as f64));
                    }
                }
                None => {
                    if let Err(e) = make_cell(cx, list, slot, index) {
                        // SAFETY: the pending exception is reported below.
                        let _ = e;
                        failed = true;
                    }
                }
            }
        }
    });
    let r = reactive::finish_value(cx, UNDEFINED);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(r) } {
        failed = true;
    }
    // After the batch: the cells' new content is in the queue already.
    for &(slot, index) in binds {
        let node = lists(cx)
            .map
            .borrow()
            .get(&list)
            .and_then(|d| d.cells.get(slot as usize))
            .and_then(|c| c.as_ref().map(|c| c.node));
        if let Some(node) = node
            && set(cx, node, "cellIndex", qjs::JS_NewFloat64(index as f64)).is_err()
        {
            failed = true;
        }
    }
    Some(if failed { Err(()) } else { Ok(()) })
}

/// A new cell for `slot`, showing item `first`.
fn make_cell(cx: *mut JsContext, list: NodeId, slot: u32, first: u32) -> Result<(), JsValue> {
    let (props, items, list_node, owner) = {
        let map = lists(cx).map.borrow();
        let d = &map[&list];
        (d.props, d.items, d.node, d.owner)
    };
    let mut made = None;
    let (root, r) = reactive::with_root_under(cx, owner, || -> Result<(), JsValue> {
        let index = reactive::new_signal(cx, qjs::JS_NewFloat64(first as f64));
        let item_fn = native(cx, item_run, 0, &mut [items, index]);
        let item = reactive::memo(cx, item_fn, false);
        let cell = dom::create_element(cx, Tag::Cell)?;
        made = Some((cell, index));
        set(cx, cell, "slot", qjs::JS_NewFloat64(slot as f64))?;
        dom::insert_node(cx, list_node, cell, None)?;
        let children = get(cx, props, "children");
        let mut args = [item, index];
        // SAFETY: the row function, called untracked; values are freed.
        let content = reactive::untracked_with(cx, || unsafe {
            qjs::JS_Call(cx, children, UNDEFINED, 2, args.as_mut_ptr())
        });
        unsafe {
            qjs::JS_FreeValue(cx, children);
            qjs::JS_FreeValue(cx, item);
            if qjs::JS_IsException(content) {
                return Err(content);
            }
        }
        let r = if has(cx, props, "separator") {
            // SAFETY: a placeholder for the separator once made.
            let holder = unsafe { qjs::JS_NewArray(cx) };
            let owner = qjs::JS_NewFloat64(reactive::current_owner(cx) as f64);
            let between = native(
                cx,
                separated_run,
                0,
                &mut [content, props, index, holder, owner],
            );
            unsafe { qjs::JS_FreeValue(cx, holder) };
            let r = dom::insert_value_at(cx, cell, between, None);
            unsafe { qjs::JS_FreeValue(cx, between) };
            r
        } else {
            dom::insert_value_at(cx, cell, content, None)
        };
        unsafe { qjs::JS_FreeValue(cx, content) };
        r
    });
    if let Some((node, index)) = made {
        let mut map = lists(cx).map.borrow_mut();
        match map.get_mut(&list) {
            Some(d) => {
                let slot = slot as usize;
                if d.cells.len() <= slot {
                    d.cells.resize_with(slot + 1, || None);
                }
                d.cells[slot] = Some(Cell {
                    node,
                    index,
                    owner: root,
                });
            }
            None => {
                drop(map);
                // SAFETY: ours (the list went meanwhile).
                unsafe {
                    qjs::JS_FreeValue(cx, node);
                    qjs::JS_FreeValue(cx, index);
                }
            }
        }
    }
    r
}

/// A cell's item: `items()[index()]`, or the last one past the end (the
/// data shrank before the core unbound the cell).
unsafe extern "C" fn item_run(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values; values got are freed or returned.
    unsafe {
        let (items, index) = (*data, *data.add(1));
        let i = qjs::JS_Call(cx, index, UNDEFINED, 0, ptr::null_mut());
        let mut n = 0f64;
        qjs::JS_ToFloat64(cx, &mut n, i);
        qjs::JS_FreeValue(cx, i);
        let each = qjs::JS_Call(cx, items, UNDEFINED, 0, ptr::null_mut());
        let len = match source_length(cx, each) {
            Ok(len) => len,
            Err(error) => {
                qjs::JS_FreeValue(cx, each);
                return error;
            }
        };
        let r = if n >= 0.0 && (n as i64) < len {
            source_item(cx, each, n as i64)
        } else {
            qjs::JS_DupValue(cx, arg(argc, argv, 0))
        };
        qjs::JS_FreeValue(cx, each);
        r
    }
}

/// A row with a separator after it (before it in an inverted list), but
/// the last one.
unsafe extern "C" fn separated_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: five data values; values got are freed or returned.
    unsafe {
        let (content, props, index, holder) = (*data, *data.add(1), *data.add(2), *data.add(3));
        let i = qjs::JS_Call(cx, index, UNDEFINED, 0, ptr::null_mut());
        let mut n = 0f64;
        qjs::JS_ToFloat64(cx, &mut n, i);
        qjs::JS_FreeValue(cx, i);
        let each = get(cx, props, "each");
        let len = match source_length(cx, each) {
            Ok(len) => len,
            Err(error) => {
                qjs::JS_FreeValue(cx, each);
                return error;
            }
        };
        qjs::JS_FreeValue(cx, each);
        let component = get(cx, props, "separator");
        let shown =
            (n as i64) < len - 1 && !qjs::JS_IsNull(component) && !qjs::JS_IsUndefined(component);
        if !shown {
            qjs::JS_FreeValue(cx, component);
            return qjs::JS_DupValue(cx, content);
        }
        let mut separator = qjs::JS_GetPropertyUint32(cx, holder, 0);
        if qjs::JS_IsUndefined(separator) {
            let mut owner = 0f64;
            qjs::JS_ToFloat64(cx, &mut owner, *data.add(4));
            qjs::JS_FreeValue(cx, component);
            // The cached separator lives with the cell, not this rerunning
            // computation: so does what its getter makes (an `<If>`'s memo).
            separator = nsh_core::reactive::with_owner(reactive::Js(cx), owner as u32, || {
                slot(cx, get(cx, props, "separator"))
            });
            if qjs::JS_IsException(separator) {
                return separator;
            }
            qjs::JS_SetPropertyUint32(cx, holder, 0, qjs::JS_DupValue(cx, separator));
        } else {
            qjs::JS_FreeValue(cx, component);
        }
        let inverted = get(cx, props, "inverted");
        let inverted_now = reactive::untracked_with(cx, || qjs::JS_ToBool(cx, inverted) == 1);
        qjs::JS_FreeValue(cx, inverted);
        let mut pair = if inverted_now {
            [separator, qjs::JS_DupValue(cx, content)]
        } else {
            [qjs::JS_DupValue(cx, content), separator]
        };
        qjs::JS_NewArrayFrom(cx, 2, pair.as_mut_ptr())
    }
}

// --- Viewability ------------------------------------------------------------------

unsafe extern "C" fn on_viewable(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let mut id = 0f64;
    // SAFETY: one data value (the list id); the event's fields are read.
    unsafe { qjs::JS_ToFloat64(cx, &mut id, *data) };
    let id = id as NodeId;
    let event = arg(argc, argv, 0);
    let read = |key: &str| {
        let v = get(cx, event, key);
        let mut n = -1f64;
        // SAFETY: converting a live value; freed after.
        unsafe {
            qjs::JS_ToFloat64(cx, &mut n, v);
            qjs::JS_FreeValue(cx, v);
        }
        n as i64
    };
    let latest = (read("first"), read("last"));
    let props = {
        let mut map = lists(cx).map.borrow_mut();
        let Some(d) = map.get_mut(&id) else {
            return UNDEFINED;
        };
        d.latest = latest;
        // SAFETY: a dup for the reads below.
        unsafe { qjs::JS_DupValue(cx, d.props) }
    };
    let config = get(cx, props, "viewabilityConfig");
    let wait = get(cx, config, "minimumViewTime");
    let mut ms = 0f64;
    // SAFETY: values got are freed.
    unsafe {
        qjs::JS_ToFloat64(cx, &mut ms, wait);
        qjs::JS_FreeValue(cx, wait);
        qjs::JS_FreeValue(cx, config);
        qjs::JS_FreeValue(cx, props);
    }
    if ms.is_nan() || ms <= 0.0 {
        return report(cx, id);
    }
    // Reported once the range stayed `minimumViewTime`.
    let previous = lists(cx)
        .map
        .borrow_mut()
        .get_mut(&id)
        .and_then(|d| d.timer.take());
    let timers = |name: &CStr, args: &mut [JsValue]| -> JsValue {
        // SAFETY: calls a global timer function; values are freed.
        unsafe {
            let global = qjs::JS_GetGlobalObject(cx);
            let f = qjs::JS_GetPropertyStr(cx, global, name.as_ptr());
            let r = qjs::JS_Call(cx, f, UNDEFINED, args.len() as c_int, args.as_mut_ptr());
            qjs::JS_FreeValue(cx, f);
            qjs::JS_FreeValue(cx, global);
            r
        }
    };
    if let Some(timer) = previous {
        let r = timers(c"clearTimeout", &mut [qjs::JS_NewFloat64(timer)]);
        unsafe { qjs::JS_FreeValue(cx, r) };
    }
    let fire = native(cx, report_later, 0, &mut [qjs::JS_NewFloat64(id as f64)]);
    let timer = timers(c"setTimeout", &mut [fire, qjs::JS_NewFloat64(ms)]);
    let mut t = 0f64;
    // SAFETY: values made here are freed.
    unsafe {
        qjs::JS_FreeValue(cx, fire);
        qjs::JS_ToFloat64(cx, &mut t, timer);
        qjs::JS_FreeValue(cx, timer);
    }
    if let Some(d) = lists(cx).map.borrow_mut().get_mut(&id) {
        d.timer = Some(t);
    }
    UNDEFINED
}

unsafe extern "C" fn report_later(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    let mut id = 0f64;
    // SAFETY: one data value (the list id).
    unsafe { qjs::JS_ToFloat64(cx, &mut id, *data) };
    if let Some(d) = lists(cx).map.borrow_mut().get_mut(&(id as NodeId)) {
        d.timer = None;
    }
    report(cx, id as NodeId)
}

/// Calls `onViewableItemsChange` with the items now viewable and those
/// that changed, unless the range is the one reported last.
fn report(cx: *mut JsContext, id: NodeId) -> JsValue {
    let (props, (first, last), (prev_first, prev_last)) = {
        let mut map = lists(cx).map.borrow_mut();
        let Some(d) = map.get_mut(&id) else {
            return UNDEFINED;
        };
        if d.latest == d.reported {
            return UNDEFINED;
        }
        let r = (
            // SAFETY: a dup for the reads below.
            unsafe { qjs::JS_DupValue(cx, d.props) },
            d.latest,
            d.reported,
        );
        d.reported = d.latest;
        r
    };
    let each = get(cx, props, "each");
    let key_of = get(cx, props, "keyExtractor");
    let len = match source_length(cx, each) {
        Ok(len) => len,
        Err(error) => {
            // SAFETY: these values were read or duplicated above.
            unsafe {
                for value in [each, key_of, props] {
                    qjs::JS_FreeValue(cx, value);
                }
            }
            return error;
        }
    };
    // SAFETY: tokens are new objects; values got are freed or moved.
    let token = |index: i64, viewable: bool| -> Result<JsValue, JsValue> {
        unsafe {
            let item = source_item(cx, each, index);
            if qjs::JS_IsException(item) {
                return Err(item);
            }
            let key = if qjs::JS_IsFunction(cx, key_of) {
                let mut args = [item, qjs::JS_NewFloat64(index as f64)];
                qjs::JS_Call(cx, key_of, UNDEFINED, 2, args.as_mut_ptr())
            } else {
                let mut k = get(cx, item, "key");
                if qjs::JS_IsUndefined(k) || qjs::JS_IsNull(k) {
                    qjs::JS_FreeValue(cx, k);
                    k = get(cx, item, "id");
                }
                if qjs::JS_IsUndefined(k) || qjs::JS_IsNull(k) {
                    qjs::JS_FreeValue(cx, k);
                    k = qjs::JS_NewFloat64(index as f64);
                }
                let s = qjs::JS_ToString(cx, k);
                qjs::JS_FreeValue(cx, k);
                s
            };
            if qjs::JS_IsException(key) {
                qjs::JS_FreeValue(cx, item);
                return Err(key);
            }
            let o = qjs::JS_NewObject(cx);
            qjs::JS_SetPropertyStr(cx, o, c"item".as_ptr(), item);
            qjs::JS_SetPropertyStr(cx, o, c"key".as_ptr(), key);
            qjs::JS_SetPropertyStr(cx, o, c"index".as_ptr(), qjs::JS_NewFloat64(index as f64));
            qjs::JS_SetPropertyStr(
                cx,
                o,
                c"isViewable".as_ptr(),
                if viewable {
                    qjs::JS_TRUE
                } else {
                    qjs::JS_FALSE
                },
            );
            Ok(o)
        }
    };
    let mut viewable = Vec::new();
    let mut changed = Vec::new();
    let collected = (|| -> Result<(), JsValue> {
        if first >= 0 {
            for i in first..=last.min(len - 1) {
                viewable.push(token(i, true)?);
                if i < prev_first || i > prev_last {
                    changed.push(token(i, true)?);
                }
            }
        }
        if prev_first >= 0 {
            for i in prev_first..=prev_last.min(len - 1) {
                if i < first || i > last {
                    changed.push(token(i, false)?);
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = collected {
        // SAFETY: these token objects and retained source references are ours.
        unsafe {
            for value in viewable
                .into_iter()
                .chain(changed)
                .chain([each, key_of, props])
            {
                qjs::JS_FreeValue(cx, value);
            }
        }
        return error;
    }
    // SAFETY: the info object takes the arrays; the handler is called and
    // values are freed.
    unsafe {
        let info = qjs::JS_NewObject(cx);
        let mut v = viewable;
        let mut c = changed;
        qjs::JS_SetPropertyStr(
            cx,
            info,
            c"viewableItems".as_ptr(),
            qjs::JS_NewArrayFrom(cx, v.len() as c_int, v.as_mut_ptr()),
        );
        qjs::JS_SetPropertyStr(
            cx,
            info,
            c"changed".as_ptr(),
            qjs::JS_NewArrayFrom(cx, c.len() as c_int, c.as_mut_ptr()),
        );
        let handler = get(cx, props, "onViewableItemsChange");
        let mut args = [info];
        let r = if qjs::JS_IsFunction(cx, handler) {
            qjs::JS_Call(cx, handler, UNDEFINED, 1, args.as_mut_ptr())
        } else {
            UNDEFINED
        };
        for v in [handler, info, each, key_of, props] {
            qjs::JS_FreeValue(cx, v);
        }
        r
    }
}

/// `nsh`'s `List` (its tags compile to `nsh:rt`'s `list`, the same
/// function).
pub(crate) const EXPORTS: &[crate::modules::Item] = &[(
    "List",
    crate::modules::Export::Function(list, 1),
    crate::modules::Ts::function(
        "A virtualized, recycling list on a native scroll view (or, with\n\
         `viewport=\"parent\"`, in the scroll view around it). Only rows near the\n\
         viewport exist; the native side decides which, and cells are reused.\n\
         Positions, columns, sticky headers and viewability are computed natively.\n\n\
         Rows are recycled: keep per-item state in your data (keyed by id), not in\n\
         signals created inside the row.",
        &[
            "<T>(props: Omit<ListProps<T>, \"each\"> & { each: readonly T[] }): JSX.Element",
            "<T>(props: Omit<ListProps<T>, \"each\"> & { each: ReadonlyListSource<T> }): JSX.Element",
            "<T>(props: ListProps<T>): JSX.Element",
        ],
    ),
)];

/// `List`'s types.
pub(crate) const TYPES: &str = r#"/** A component (`Header`) or an element (`<Header />`). */
export type ListSlot = (() => JSX.Element) | JSX.Element;

/** An immutable indexed snapshot. Replace its identity to change its rows or
 * length. Only rendered or viewable rows are read; snapshots are never scanned
 * to compare keys. at(index) is called only for indices inside [0, length). */
export interface ReadonlyListSource<T> {
  readonly length: number;
  at(index: number): T;
  /** The changed span in a prior snapshot, or undefined to replace that snapshot. */
  spliceFrom?(previous: readonly T[] | ReadonlyListSource<T>): readonly [at: number, removed: number, inserted: number] | undefined;
}

/** An item that became viewable or stopped being viewable. */
export interface ViewToken<T> {
  item: T;
  key: string;
  index: number;
  isViewable: boolean;
}

export interface ViewabilityConfig {
  /** How much of the viewport an item must cover to count as viewable, from 0 to 1. */
  viewAreaCoverageThreshold?: number;
  /** How much of an item must be visible, from 0 to 1. Without either threshold, any visible pixel counts. */
  itemVisibleThreshold?: number;
  /** Milliseconds items must stay viewable before they are reported. */
  minimumViewTime?: number;
}

/** A list's props: its own, and those of the scroll view it is (the test
 * id, accessibility, classes, touch and layout events, ...), which it
 * passes on as they are. */
export interface ListProps<T> extends Omit<ViewProps, "children" | "ref">, ScrollingHostProps, ListHostProps {
  each: readonly T[] | ReadonlyListSource<T>;
  /** Above the items, scrolling with them. */
  header?: ListSlot;
  /** Below the items, scrolling with them. */
  footer?: ListSlot;
  /** Shown instead of the items while `each` is empty. */
  empty?: ListSlot;
  /** Rendered between items (one column). */
  separator?: ListSlot;
  /** Scrolls to this item before the first frame. */
  initialScrollIndex?: number;
  /** Opens at the end before the first frame, following it while rows measure.
   * Short content stays at the top. Takes precedence over initialScrollIndex. */
  initialScrollAtEnd?: boolean;
  /** Key of an item in `onViewableItemsChange` tokens (default: `item.key`, `item.id`, or the index). */
  keyExtractor?: (item: T, index: number) => string;
  onViewableItemsChange?: (info: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] }) => void;
  style?: StyleProp<ViewStyle>;
  /** Padding and gaps of the content as classes (`p-*`, `gap-*`);
   * `contentStyle` wins over them. */
  contentClass?: string;
  /** The id UI tests find the list's scroll view by (`nsh test`'s `id:`, XCUITest, UI Automator). */
  testID?: string;
  /** How close to the end (in viewports) `onLoadMore` fires; default 1. */
  loadMoreThreshold?: number;
  /** The start came within `loadMoreAtStartThreshold` viewports, after the
   * user or a scroll command moved the list: load what comes before the
   * first item (a chat's newer messages). Once per approach. */
  onLoadMoreAtStart?: () => void;
  /** How close to the start (in viewports) `onLoadMoreAtStart` fires; default 1. */
  loadMoreAtStartThreshold?: number;
  ref?: ListRef | ((node: ListRef) => void);
  /** Renders one row. Called once per recycled cell; `item` and `index`
   * change when the cell is reused for another item. */
  children: (item: () => T, index: () => number) => JSX.Element;
}

/** What an app passes to a Rust component that lays out a list of rows
 * (an `Items` prop): the data and the rows; the component decides the
 * layout. */
export type ListItemsProps<T> = Pick<ListProps<T>, "each" | "children" | "keyExtractor" | "stickyHeaderIndices" | "initialScrollIndex" | "initialScrollAtEnd" | "onViewableItemsChange" | "viewabilityConfig" | "refreshing" | "onRefresh" | "onLoadMore" | "loadMoreThreshold" | "header" | "footer" | "empty">;
"#;

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use nsh_core::element::{Instance, JsObject, Registry, class};

    use crate::{Host, HostOptions};

    #[derive(Clone, JsObject)]
    pub(crate) struct CapturedLine {
        offset: usize,
        text: String,
    }

    #[class(interface)]
    struct CapturedRows {
        reads: Arc<AtomicUsize>,
        revision: &'static str,
    }

    #[class]
    impl CapturedRows {
        #[getter]
        pub(crate) fn length(&self) -> usize {
            1_000_000
        }

        pub(crate) fn at(&self, index: usize) -> Result<CapturedLine, String> {
            if !matches!(index, 0 | 999_999) {
                return Err(format!("unrequested file row {index}"));
            }
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(CapturedLine {
                offset: index,
                text: format!("{}:{index}", self.revision),
            })
        }
    }

    #[test]
    fn immutable_native_file_rows_read_only_bound_cells_when_replaced() {
        let reads = Arc::new(AtomicUsize::new(0));
        let mut registry = Registry::ui_set("test/captured-file");
        for (name, revision) in [("before", "before"), ("after", "after")] {
            let reads = reads.clone();
            registry.value(name, move || {
                Instance::new(CapturedRows {
                    reads: reads.clone(),
                    revision,
                })
            });
        }
        let host = Host::with_options(HostOptions {
            ui_sets: vec![registry],
            ..Default::default()
        })
        .unwrap();
        host.eval_source(
            r#"
            import { List, mount, signal } from "nsh";
            import { text } from "nsh:rt";
            import { before, after } from "test/captured-file";
            const rows = signal(before);
            globalThis.sameCapture = () => rows.set(rows());
            globalThis.replaceCapture = () => rows.set(after);
            mount(() => List({
                get each() { return rows(); },
                keyExtractor: row => String(row.offset),
                children: row => () => text(row().text),
            }));
        "#,
        )
        .unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let list = ops
            .iter()
            .find_map(|op| match op {
                nsh_core::Op::Create {
                    id,
                    tag: nsh_core::Tag::List,
                } => Some(*id),
                _ => None,
            })
            .unwrap();
        assert!(ops.iter().any(|op| matches!(
            op,
            nsh_core::Op::SetProp {
                prop: nsh_core::Prop::Count(1_000_000),
                ..
            }
        )));
        assert_eq!(
            reads.load(Ordering::SeqCst),
            0,
            "opening a capture must not read its lines"
        );
        host.bind_list(list, &[(0, 0), (1, 999_999)]);
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        assert!(
            host.eval_script("same-capture", "sameCapture(); true")
                .unwrap()
        );
        assert_eq!(reads.load(Ordering::SeqCst), 2);
        ops.clear();
        host.take_ops(&mut ops);
        ops.clear();
        assert!(
            host.eval_script("replace-capture", "replaceCapture(); true")
                .unwrap()
        );
        assert_eq!(
            reads.load(Ordering::SeqCst),
            4,
            "replacement must not compare every row key"
        );
        host.take_ops(&mut ops);
        let mut text: Vec<_> = ops
            .iter()
            .filter_map(|op| match op {
                nsh_core::Op::CreateText { text, .. } | nsh_core::Op::SetText { text, .. } => {
                    Some(text.as_str())
                }
                _ => None,
            })
            .collect();
        text.sort_unstable();
        assert_eq!(text, ["after:0", "after:999999"]);
        assert!(ops.iter().any(|op| matches!(
            op,
            nsh_core::Op::SetProp {
                prop: nsh_core::Prop::Splice(0, 1_000_000, 1_000_000),
                ..
            }
        )));
    }

    #[test]
    fn indexed_prepend_preserves_the_bound_item() {
        let host = Host::with_options(HostOptions::default()).unwrap();
        host.eval_source(
            r#"
            import { List, mount, signal } from "nsh";
            import { text } from "nsh:rt";
            const first = { length: 3, at(i) { return ["B", "C", "D"][i]; } };
            const rows = signal(first);
            globalThis.prepend = () => rows.set({
                length: 4,
                at(i) { return ["A", "B", "C", "D"][i]; },
                spliceFrom(old) { if (old === first) return [0, 0, 1]; }
            });
            mount(() => List({
                get each() { return rows(); },
                children: row => () => text(row()),
            }));
            "#,
        )
        .unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let list = ops
            .iter()
            .find_map(|op| match op {
                nsh_core::Op::Create {
                    id,
                    tag: nsh_core::Tag::List,
                } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 1)]);
        ops.clear();
        host.take_ops(&mut ops);
        assert!(ops.iter().any(|op| matches!(op,
            nsh_core::Op::CreateText { text, .. } if text == "C"
        )));
        ops.clear();
        assert!(host.eval_script("prepend", "prepend(); true").unwrap());
        host.take_ops(&mut ops);
        assert!(ops.iter().any(|op| matches!(
            op,
            nsh_core::Op::SetProp {
                prop: nsh_core::Prop::Splice(0, 0, 1),
                ..
            }
        )));
        assert!(
            !ops.iter()
                .any(|op| matches!(op, nsh_core::Op::SetText { .. }))
        );
    }

    #[test]
    fn retained_keyed_cells_refresh_without_structural_splices() {
        let host = Host::with_options(HostOptions::default()).unwrap();
        host.eval_source(
            r#"
            import { List, mount, signal } from "nsh";
            import { text } from "nsh:rt";
            const items = signal([{ id: "a", label: "before" }]);
            globalThis.updateRow = () => items.set([{ id: "a", label: "after" }]);
            mount(() => List({
                get each() { return items(); },
                keyExtractor: item => item.id,
                children: item => () => text(item().label),
            }));
        "#,
        )
        .unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let list = ops
            .iter()
            .find_map(|op| match op {
                nsh_core::Op::Create {
                    id,
                    tag: nsh_core::Tag::List,
                } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 0)]);
        ops.clear();
        host.take_ops(&mut ops);
        ops.clear();
        assert!(host.eval_script("update-row", "updateRow(); true").unwrap());
        host.take_ops(&mut ops);
        assert!(
            ops.iter().any(|op| matches!(op,
                nsh_core::Op::CreateText { text, .. } | nsh_core::Op::SetText { text, .. }
                    if &**text == "after"
            )),
            "{ops:?}"
        );
        assert!(
            !ops.iter().any(|op| matches!(
                op,
                nsh_core::Op::SetProp {
                    prop: nsh_core::Prop::Splice(..),
                    ..
                }
            )),
            "{ops:?}"
        );
    }

    #[test]
    fn initial_end_takes_precedence_and_false_preserves_the_index() {
        let host = Host::with_options(HostOptions::default()).unwrap();
        host.eval_source(r#"
            import { List } from "nsh";
            List({ each: [0], children: () => null, initialScrollAtEnd: true, initialScrollIndex: 0 });
            List({ each: [0], children: () => null, initialScrollAtEnd: false, initialScrollIndex: 7 });
            List({ each: [], children: () => null, initialScrollAtEnd: false });
        "#).unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let commands: Vec<_> = ops
            .into_iter()
            .filter_map(|op| match op {
                nsh_core::Op::Command { command, .. } => Some(command),
                _ => None,
            })
            .collect();
        assert!(matches!(
            commands.as_slice(),
            [
                nsh_core::Command::ScrollToEnd { animated: false },
                nsh_core::Command::ScrollToIndex {
                    index: 7,
                    animated: false,
                    ..
                },
            ]
        ));
    }

    #[test]
    fn cached_separators_keep_their_cell_owner() {
        let host = Host::with_options(HostOptions::default()).unwrap();
        host.with_raw(|raw| {
            // SAFETY: the host owns the live context for this closure.
            let cx = unsafe { rquickjs::Ctx::from_raw(std::ptr::NonNull::new_unchecked(raw)) };
            crate::reactive::install_globals(&cx);
        });
        host.eval_source(
            r#"
            import { List, signal, cleanup, effect } from "nsh";
            import { text } from "nsh:rt";
            const items = signal(["a", "b", "c", "d"].map(id => ({ id })));
            const color = signal("red");
            const state = globalThis.separators = { made: 0, cleaned: 0, colors: [], items, color };
            state.dispose = __nsh_reactive.createRoot(dispose => {
                List({
                    get each() { return items(); },
                    keyExtractor: item => item.id,
                    children: item => text(item().id),
                    separator: () => {
                        const id = state.made++;
                        cleanup(() => state.cleaned++);
                        effect(() => { state.colors[id] = color(); });
                        return text("-");
                    },
                });
                return dispose;
            });
            "#,
        )
        .unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let list = ops
            .iter()
            .find_map(|op| match op {
                nsh_core::Op::Create {
                    id,
                    tag: nsh_core::Tag::List,
                } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 0), (1, 1), (2, 2), (3, 3)]);
        let check = |source| {
            assert!(
                host.eval_script("separator-lifetime", source).unwrap(),
                "{source}"
            )
        };
        check("separators.made === 3 && separators.cleaned === 0");
        check(
            "separators.items.set(separators.items().map(item => ({...item}))); separators.cleaned === 0",
        );
        check("separators.color.set('blue'); separators.colors.join() === 'blue,blue,blue'");
        // Reordering and reusing a cell for the last row only hide its cached separator.
        check("separators.items.set([...separators.items()].reverse()); separators.cleaned === 0");
        host.bind_list(list, &[(0, 3), (1, 2), (2, 1), (3, 0)]);
        check("separators.made === 4 && separators.cleaned === 0");
        check("separators.items.set(separators.items().slice(0, 1)); separators.cleaned === 0");
        check(
            "separators.color.set('green'); separators.colors.join() === 'green,green,green,green'",
        );
        check(
            "separators.items.set(['a', 'b', 'c', 'd'].map(id => ({id}))); separators.made === 4",
        );
        host.bind_list(list, &[(0, 0), (1, 1), (2, 2), (3, 3)]);
        check("separators.made === 4 && separators.cleaned === 0");
        check("separators.dispose(); separators.cleaned === 4");
        check("separators.dispose(); separators.cleaned === 4");
        check(
            "separators.color.set('black'); separators.colors.join() === 'green,green,green,green'",
        );
    }

    /// A list's slots are its own: it makes each once and never passes
    /// them to its scroll view (as compiled JSX passes them: getters that
    /// make the slot's elements each time they are read).
    #[test]
    fn a_lists_slots_stay_with_the_list() {
        let host = Host::with_options(HostOptions::default()).unwrap();
        host.eval_source(
            "import { mount } from \"nsh\";\n\
             import { text } from \"nsh:rt\";\n\
             import { List } from \"nsh\";\n\
             mount(() => List({\n\
               each: [1, 2],\n\
               children: (n) => text(`Row ${n()}`),\n\
               get header() { return text(\"Head\"); },\n\
               get footer() { return text(\"Foot\"); },\n\
               get empty() { return text(\"None\"); },\n\
               get separator() { return () => text(\"-\"); },\n\
             }));",
        )
        .unwrap();
        for name in ["header", "footer", "empty", "separator"] {
            assert!(
                !host.warned(&format!("unsupported prop `{name}`")),
                "`{name}` went to the scroll view"
            );
        }
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let made = |wanted: &str| {
            ops.iter()
                .filter(
                    |op| matches!(op, nsh_core::Op::CreateText { text, .. } if &**text == wanted),
                )
                .count()
        };
        assert_eq!((made("Head"), made("Foot")), (1, 1));
    }

    /// Rows rebuilt as new objects with the same keys are the same rows:
    /// appending one splices only the new row in.
    #[test]
    fn keyed_rows_rebuilt_with_the_same_keys_splice_only_the_new_row() {
        let host = Host::with_options(HostOptions::default()).unwrap();
        host.eval_source(
            r#"
            import { List, mount, signal } from "nsh";
            import { text } from "nsh:rt";
            const items = signal(["a", "b", "c"].map(id => ({ id })));
            globalThis.keyed = { items };
            mount(() => List({
                get each() { return items(); },
                keyExtractor: item => item.id,
                children: item => text(item().id),
            }));
            "#,
        )
        .unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops.clear();
        assert!(
            host.eval_script(
                "keyed-append",
                "keyed.items.set([...keyed.items().map(i => ({...i})), {id: 'd'}]); true",
            )
            .unwrap()
        );
        host.take_ops(&mut ops);
        let splices: Vec<String> = ops
            .iter()
            .map(|op| format!("{op:?}"))
            .filter(|op| op.contains("Splice"))
            .collect();
        assert_eq!(splices.len(), 1, "{splices:?}");
        assert!(splices[0].contains("Splice(3, 0, 1)"), "{splices:?}");
    }
}
