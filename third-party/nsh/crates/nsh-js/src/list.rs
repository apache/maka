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
    /// Updated with the index only when the core binds this cell.
    item: JsValue,
    owner: u32,
}

struct ListData {
    props: JsValue,
    node: JsValue,
    /// Source whose count and splices the core has received.
    source: JsValue,
    /// Source accompanying ops that have not left the host yet.
    staged_source: Option<JsValue>,
    /// Last emitted count; an array may have been mutated since that emission.
    emitted_len: i64,
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
    /// Publish sources with their ops, after requests from the previous frame.
    pub(crate) fn publish_sources(&self, raw: *mut JsContext) {
        for data in self.map.borrow_mut().values_mut() {
            if let Some(source) = data.staged_source.take() {
                // SAFETY: replace the reference owned by this list.
                unsafe { qjs::JS_FreeValue(raw, data.source) };
                data.source = source;
            }
        }
    }

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
        qjs::JS_FreeValue(cx, data.source);
        if let Some(source) = data.staged_source {
            qjs::JS_FreeValue(cx, source);
        }
        for cell in data.cells.into_iter().flatten() {
            qjs::JS_FreeValue(cx, cell.node);
            qjs::JS_FreeValue(cx, cell.index);
            qjs::JS_FreeValue(cx, cell.item);
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

/// The data is either an array or a readonly indexed snapshot. Keep the
/// array path unchanged; indexed lengths use the core's existing u32 range.
fn source_length(cx: *mut JsContext, source: JsValue) -> Result<i64, JsValue> {
    // SAFETY: property reads and conversions of a live value.
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
                c"List source must have an at(index) method".as_ptr(),
            ));
        }
        let value = Guard(cx, get(cx, source, "length"));
        if qjs::JS_IsException(value.1) {
            return Err(value.1);
        }
        let mut len = 0f64;
        if !qjs::JS_IsNumber(value.1)
            || qjs::JS_ToFloat64(cx, &mut len, value.1) != 0
            || !len.is_finite()
            || len < 0.0
            || len > u32::MAX as f64
            || len.fract() != 0.0
        {
            return Err(qjs::JS_ThrowRangeError(
                cx,
                c"List source length must be an unsigned 32-bit integer".as_ptr(),
            ));
        }
        Ok(len as i64)
    }
}

fn source_item(cx: *mut JsContext, source: JsValue, index: i64) -> JsValue {
    // SAFETY: reads one array item or calls the snapshot's method with its
    // original receiver; the method value is owned by the guard.
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
        source: UNDEFINED,
        staged_source: None,
        emitted_len: 0,
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
    // The items: tells the core how they changed (by identity: the common
    // start and end stay), so measurements follow their items.
    let func = native(cx, splice_run, 1, &mut [node, props]);
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
    // SAFETY: an inline check and a conversion of a live value.
    unsafe {
        if qjs::JS_IsNumber(initial) {
            let mut index = 0f64;
            qjs::JS_ToFloat64(cx, &mut index, initial);
            dom::push_op(
                cx,
                Op::Command {
                    id,
                    command: Command::ScrollToIndex {
                        index: index.max(0.0) as u32,
                        animated: false,
                        automatic: false,
                        view_position: Percentage(0.0),
                        view_offset: Points::ZERO,
                    },
                },
            )
            .map_err(fail)?;
        }
        qjs::JS_FreeValue(cx, initial);
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

/// A run of the items effect: the items set last in, the current out.
unsafe extern "C" fn splice_run(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values; values got are freed or returned.
    unsafe {
        let (node, props) = (*data, *data.add(1));
        let old = arg(argc, argv, 0);
        let next = get(cx, props, "each");
        if qjs::JS_IsException(next) {
            return next;
        }
        let id = dom::node_id(cx, node).expect("a list node");
        let old_len = lists(cx)
            .map
            .borrow()
            .get(&id)
            .map_or(0, |data| data.emitted_len);
        let next_len = match source_length(cx, next) {
            Ok(length) => length,
            Err(e) => {
                qjs::JS_FreeValue(cx, next);
                return e;
            }
        };
        if old_len > 0 {
            let max = old_len.min(next_len);
            let same = |i: i64, j: i64| {
                let a = qjs::JS_GetPropertyInt64(cx, old, i);
                let b = qjs::JS_GetPropertyInt64(cx, next, j);
                let s = qjs::JS_IsStrictEqual(cx, a, b);
                qjs::JS_FreeValue(cx, a);
                qjs::JS_FreeValue(cx, b);
                s
            };
            let mut start = 0;
            let mut end = 0;
            // A new indexed source is a new snapshot. Comparing its items
            // would materialize the whole source just to find a splice.
            // A notified mutation of the same array has no recoverable old
            // contents to diff. Rebind the range, as for an indexed snapshot.
            if qjs::JS_IsArray(old)
                && qjs::JS_IsArray(next)
                && !qjs::JS_IsStrictEqual(cx, old, next)
            {
                while start < max && same(start, start) {
                    start += 1;
                }
                while end < max - start && same(old_len - 1 - end, next_len - 1 - end) {
                    end += 1;
                }
            }
            let removed = old_len - start - end;
            let inserted = next_len - start - end;
            if removed > 0 || inserted > 0 {
                let mut values = [
                    qjs::JS_NewFloat64(start as f64),
                    qjs::JS_NewFloat64(removed as f64),
                    qjs::JS_NewFloat64(inserted as f64),
                ];
                let splice = qjs::JS_NewArrayFrom(cx, 3, values.as_mut_ptr());
                if let Err(e) = set(cx, node, "splice", splice) {
                    qjs::JS_FreeValue(cx, next);
                    return e;
                }
            }
        }
        if let Err(e) = set(cx, node, "count", qjs::JS_NewFloat64(next_len as f64)) {
            qjs::JS_FreeValue(cx, next);
            return e;
        }
        if let Some(data) = lists(cx).map.borrow_mut().get_mut(&id) {
            data.emitted_len = next_len;
            if let Some(previous) = data.staged_source.replace(qjs::JS_DupValue(cx, next)) {
                qjs::JS_FreeValue(cx, previous);
            }
        }
        next
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

/// A list slot's value, resolved by the normal child insertion path.
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
        get(cx, props, &key)
    }
}

/// Keeps a slot's getter and returned functions in their own memos: a
/// reactive child changing must not make the slot's component again.
fn slot_reader(cx: *mut JsContext, props: JsValue, key: &str) -> JsValue {
    let key = new_string(cx, key);
    let reader = native(cx, slot_run, 0, &mut [props, key]);
    // SAFETY: the reader keeps its own key.
    unsafe { qjs::JS_FreeValue(cx, key) };
    dom::item_memo(cx, reader)
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
        let reader = slot_reader(cx, props, key);
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
        let len = source_length(cx, each);
        qjs::JS_FreeValue(cx, each);
        let empty = match len {
            Ok(len) => len == 0,
            Err(e) => return e,
        };
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
                    let reader = slot_reader(cx, props, "empty");
                    let r = dom::insert_value_at(cx, cell, reader, None);
                    qjs::JS_FreeValue(cx, reader);
                    r
                })
            });
            if let Some(d) = lists(cx).map.borrow_mut().get_mut(&id) {
                d.extras.push(root);
            }
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
            if let Some(id) = dom::node_id(cx, list)
                && let Some(d) = lists(cx).map.borrow_mut().get_mut(&id)
            {
                d.extras.retain(|&owner| owner != root as u32);
            }
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
    let source = {
        let map = lists(cx).map.borrow();
        let data = map.get(&list)?;
        // Keep this publication alive across arbitrary indexed-source calls.
        // SAFETY: the list owns the borrowed source.
        Guard(cx, unsafe { qjs::JS_DupValue(cx, data.source) })
    };
    let mut failed = false;
    let mut bound = Vec::with_capacity(binds.len());
    reactive::batch_with(cx, || {
        for &(slot, index) in binds {
            let value = Guard(
                cx,
                reactive::untracked_with(cx, || source_item(cx, source.1, index as i64)),
            );
            // Resolve first: an exception must leave both signals unchanged.
            // SAFETY: inline check of the owned result.
            if unsafe { qjs::JS_IsException(value.1) } {
                failed = true;
                break;
            }
            let existing = lists(cx)
                .map
                .borrow()
                .get(&list)
                .and_then(|d| d.cells.get(slot as usize))
                .and_then(|c| c.as_ref().map(|c| (c.index, c.item)));
            match existing {
                Some((index_signal, item_signal)) => {
                    // SAFETY: set_signal consumes the duplicated value.
                    reactive::set_signal(cx, item_signal, unsafe { qjs::JS_DupValue(cx, value.1) });
                    reactive::set_signal(cx, index_signal, qjs::JS_NewFloat64(index as f64));
                }
                None => {
                    if make_cell(cx, list, slot, index, value.1).is_err() {
                        failed = true;
                        break;
                    }
                }
            }
            bound.push((slot, index));
        }
    });
    let r = reactive::finish_value(cx, UNDEFINED);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(r) } {
        failed = true;
    }
    // After the batch: the cells' new content is in the queue already.
    for &(slot, index) in &bound {
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
fn make_cell(
    cx: *mut JsContext,
    list: NodeId,
    slot: u32,
    first: u32,
    value: JsValue,
) -> Result<(), JsValue> {
    let (props, list_node, owner) = {
        let map = lists(cx).map.borrow();
        let Some(d) = map.get(&list) else {
            return Ok(());
        };
        (d.props, d.node, d.owner)
    };
    let mut made = None;
    let (root, r) = reactive::with_root_under(cx, owner, || -> Result<(), JsValue> {
        let cell = dom::create_element(cx, Tag::Cell)?;
        let index = reactive::new_signal(cx, qjs::JS_NewFloat64(first as f64));
        let item = reactive::new_signal(cx, value);
        made = Some((cell, index, item));
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
            if qjs::JS_IsException(content) {
                return Err(content);
            }
        }
        let r = if has(cx, props, "separator") {
            // The separator is lazy, but belongs to the cell rather than
            // the insertion effect, which runs again when the cell is reused.
            let owner = qjs::JS_NewFloat64(reactive::current_owner(cx) as f64);
            // SAFETY: a placeholder for the separator once made.
            let holder = unsafe { qjs::JS_NewArray(cx) };
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
    if let Some((node, index, item)) = made {
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
                    item,
                    owner: root,
                });
            }
            None => {
                drop(map);
                // SAFETY: ours (the list went meanwhile).
                unsafe {
                    qjs::JS_FreeValue(cx, node);
                    qjs::JS_FreeValue(cx, index);
                    qjs::JS_FreeValue(cx, item);
                }
            }
        }
    }
    r
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
        let (content, props, index, holder, owner) = (
            *data,
            *data.add(1),
            *data.add(2),
            *data.add(3),
            *data.add(4),
        );
        let i = qjs::JS_Call(cx, index, UNDEFINED, 0, ptr::null_mut());
        let mut n = 0f64;
        qjs::JS_ToFloat64(cx, &mut n, i);
        qjs::JS_FreeValue(cx, i);
        let each = get(cx, props, "each");
        let len = source_length(cx, each);
        qjs::JS_FreeValue(cx, each);
        let len = match len {
            Ok(len) => len,
            Err(e) => return e,
        };
        if (n as i64) >= len - 1 {
            return qjs::JS_DupValue(cx, content);
        }
        let mut separator = qjs::JS_GetPropertyUint32(cx, holder, 0);
        if qjs::JS_IsUndefined(separator) {
            let mut root = 0f64;
            qjs::JS_ToFloat64(cx, &mut root, owner);
            separator =
                reactive::with_owner(cx, root as u32, || slot_reader(cx, props, "separator"));
            if qjs::JS_IsException(separator) {
                return separator;
            }
            qjs::JS_SetPropertyUint32(cx, holder, 0, qjs::JS_DupValue(cx, separator));
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
    let props = Guard(cx, props);
    let each = Guard(cx, get(cx, props.1, "each"));
    let len = match source_length(cx, each.1) {
        Ok(len) => len,
        Err(e) => return e,
    };
    let key_of = Guard(cx, get(cx, props.1, "keyExtractor"));
    // SAFETY: inline tag check on the property read above.
    if unsafe { qjs::JS_IsException(key_of.1) } {
        return key_of.1;
    }
    // SAFETY: tokens are new objects; values got are freed or moved.
    let token = |index: i64, viewable: bool| -> Result<JsValue, JsValue> {
        unsafe {
            let item = source_item(cx, each.1, index);
            if qjs::JS_IsException(item) {
                return Err(item);
            }
            let key = if qjs::JS_IsFunction(cx, key_of.1) {
                let mut args = [item, qjs::JS_NewFloat64(index as f64)];
                qjs::JS_Call(cx, key_of.1, UNDEFINED, 2, args.as_mut_ptr())
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
                if qjs::JS_IsException(k) {
                    qjs::JS_FreeValue(cx, item);
                    return Err(k);
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
    let mut read_tokens = || -> Result<(), JsValue> {
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
    };
    if let Err(e) = read_tokens() {
        // SAFETY: tokens not yet transferred to their arrays.
        for token in viewable.into_iter().chain(changed) {
            unsafe { qjs::JS_FreeValue(cx, token) };
        }
        return e;
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
        let handler = get(cx, props.1, "onViewableItemsChange");
        let mut args = [info];
        let r = if qjs::JS_IsFunction(cx, handler) {
            qjs::JS_Call(cx, handler, UNDEFINED, 1, args.as_mut_ptr())
        } else {
            UNDEFINED
        };
        for v in [handler, info] {
            qjs::JS_FreeValue(cx, v);
        }
        r
    }
}

/// `nsh/list`: `List` (its tags compile to `nsh:rt`'s `list`, the same
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
        // Arrays also have at(): infer their elements before indexed sources.
        &[
            "<T>(props: Omit<ListProps<T>, \"each\"> & { each: readonly T[] }): YNode",
            "<T>(props: Omit<ListProps<T>, \"each\"> & { each: ReadonlyListSource<T> }): YNode",
            "<T>(props: ListProps<T>): YNode",
        ],
    ),
)];

/// `nsh/list`'s types.
pub(crate) const TYPES: &str = r#"/** A component (`Header`) or an element (`<Header />`). Functions and
 * their returned children stay reactive, as in ordinary JSX children. */
export type ListSlot = (() => JSX.Element) | JSX.Element;

/** A readonly indexed snapshot. Only rendered and viewable items are read.
 * Replace the source object to replace the snapshot; unlike arrays, a new
 * source replaces the entire item range without comparing individual items. */
export interface ReadonlyListSource<T> {
  /** The item count, an integer in the same unsigned 32-bit range as arrays. */
  readonly length: number;
  /** Returns the item at a requested index, with this source as its receiver. */
  at(index: number): T;
}

/** An item that became viewable or stopped being viewable. */
export interface ViewToken<T> {
  item: T;
  key: string;
  index: number;
  isViewable: boolean;
}

export interface ViewabilityConfig {
  /** Percent of the viewport an item must cover to count as viewable. */
  viewAreaCoveragePercentThreshold?: number;
  /** Percent of an item that must be visible. Without either threshold, any visible pixel counts. */
  itemVisiblePercentThreshold?: number;
  /** Milliseconds items must stay viewable before they are reported. */
  minimumViewTime?: number;
}

/** A list's props: its own, and those of the scroll view it is (the test
 * id, accessibility, classes, touch and layout events, ...), which it
 * passes on as they are. */
export interface ListProps<T> extends Omit<ViewProps, "children">, ScrollingHostProps, ListHostProps {
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
  ref?: YNode | ((node: YNode) => void);
  /** Renders one row. Called once per recycled cell; `item` and `index`
   * change when the cell is reused for another item. */
  children: (item: () => T, index: () => number) => JSX.Element;
}

/** What an app passes to a Rust component that lays out a list of rows
 * (an `Items` prop): the data and the rows; the component decides the
 * layout. */
export type ListItemsProps<T> = Pick<ListProps<T>, "each" | "children" | "keyExtractor" | "stickyHeaderIndices" | "initialScrollIndex" | "onViewableItemsChange" | "viewabilityConfig" | "refreshing" | "onRefresh" | "onLoadMore" | "loadMoreThreshold" | "header" | "footer" | "empty">;
"#;

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, rc::Rc};

    use nsh_core::{EventKind, EventPayload, NodeId, Op, PayloadValue, Prop, Tag};

    use crate::{Host, HostOptions};

    fn take_ops(host: &Host) -> Vec<Op> {
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops
    }

    fn created_text(ops: &[Op], wanted: &str) -> NodeId {
        ops.iter()
            .find_map(|op| match op {
                Op::CreateText { id, text } if text == wanted => Some(*id),
                _ => None,
            })
            .unwrap_or_else(|| panic!("missing text {wanted:?}: {ops:?}"))
    }

    fn assert_js_exception(message: &str, expected: &str) {
        let (title, stack) = message
            .split_once('\n')
            .unwrap_or_else(|| panic!("missing exception stack: {message}"));
        assert_eq!(title, format!("Error: {expected}"));
        assert!(
            stack
                .lines()
                .any(|line| line.trim_start().starts_with("at ")),
            "missing exception frames: {message}"
        );
    }

    #[test]
    fn array_splices_keep_retained_row_state_until_the_core_rebinds() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal, cleanup } from "nsh";
            import { each } from "nsh:rt";
            import { List } from "nsh";
            const a = { text: "A" }, b = { text: "B" }, x = { text: "X" };
            const source = signal([a, b]);
            let made = 0, cleaned = 0;
            globalThis.prepend = () => source.set([x, a, b]);
            globalThis.remove = () => source.set([a, b]);
            globalThis.replace = () => source.set([{ text: "C" }, b]);
            globalThis.check = (m, c) => {
                if (made !== m || cleaned !== c) throw Error(`owners ${made}/${cleaned}`);
            };
            mount(() => List({
                get each() { return source(); },
                children: (item, index) => each(() => [item()], (row) => {
                    made++;
                    cleanup(() => cleaned++);
                    const selected = signal(false);
                    globalThis.select = () => selected.set(true);
                    return () => `${row().text}/${index()}/${selected()}`;
                }),
            }));
        "#,
        )
        .unwrap();
        let list = take_ops(&host)
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 1)]);
        let body = created_text(&take_ops(&host), "B/1/false");
        host.eval_script("select.js", "select(); check(1, 0)")
            .unwrap();
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "B/1/true")));
        host.eval_script("prepend.js", "prepend(); check(1, 0)")
            .unwrap();
        let pending = take_ops(&host);
        assert!(pending.iter().any(|op| matches!(op,
            Op::SetProp { id, prop: Prop::Splice(0, 0, 1) } if *id == list)));
        host.bind_list(list, &[(0, 2)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "B/2/true")));
        host.eval_script("remove.js", "remove(); check(1, 0)")
            .unwrap();
        take_ops(&host);
        host.bind_list(list, &[(0, 1)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "B/1/true")));
        host.eval_script("retained.js", "check(1, 0)").unwrap();
        host.bind_list(list, &[(0, 0)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "A/0/false")));
        host.eval_script("recycled.js", "check(2, 1); replace(); check(2, 1)")
            .unwrap();
        take_ops(&host);
        host.bind_list(list, &[(0, 0)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "C/0/false")));
        host.eval_script("replaced.js", "check(3, 2)").unwrap();
    }

    #[test]
    fn pending_frame_binds_read_the_source_already_published_to_the_core() {
        let host = Host::new().unwrap();
        host.eval_source(r#"
            import { mount, signal, List } from "nsh";
            const source = signal(["A", "B"]);
            globalThis.prepend = () => source.set(["X", "A", "B"]);
            mount(() => List({ get each() { return source(); }, children: (item) => () => item() }));
        "#).unwrap();
        let list = take_ops(&host)
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 0)]);
        let body = created_text(&take_ops(&host), "A");
        host.eval_script("prepend.js", "prepend()").unwrap();
        // Driver answers the previous frame's requests before taking new ops.
        host.bind_list(list, &[(0, 1)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "B")));
        host.bind_list(list, &[(0, 1)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "A")));
    }

    #[test]
    fn notifying_a_mutated_array_rebinds_its_previous_range() {
        let host = Host::new().unwrap();
        host.eval_source(r#"
            import { mount, signal, List } from "nsh";
            const rows = ["A", "B"];
            const source = signal(rows, { equals: false });
            globalThis.replace = () => { rows[0] = "Changed"; source.set(rows); };
            globalThis.shrink = () => { rows.splice(0, 1); source.set(rows); };
            mount(() => List({ get each() { return source(); }, children: (item) => () => item() }));
        "#).unwrap();
        let list = take_ops(&host)
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 0)]);
        let body = created_text(&take_ops(&host), "A");
        host.eval_script("replace.js", "replace()").unwrap();
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetProp { id, prop: Prop::Splice(0, 2, 2) } if *id == list)));
        host.bind_list(list, &[(0, 0)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "Changed")));
        host.eval_script("shrink.js", "shrink()").unwrap();
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetProp { id, prop: Prop::Splice(0, 2, 1) } if *id == list)));
        host.bind_list(list, &[(0, 0)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "B")));
    }

    #[test]
    fn array_splices_keep_surviving_keyed_row_owners() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal, cleanup } from "nsh";
            import { each, text } from "nsh:rt";
            import { List } from "nsh";
            const rows = signal(["summary", "final"]);
            let finalMade = 0, finalCleaned = 0;
            globalThis.expand = () => rows.set(["summary", "process", "final"]);
            globalThis.collapse = () => rows.set(["summary", "final"]);
            globalThis.replaceFinal = () => rows.set(["summary", "replacement"]);
            globalThis.check = (made, cleaned) => {
                if (finalMade !== made || finalCleaned !== cleaned)
                    throw Error(`final owner ${finalMade}/${finalCleaned}, expected ${made}/${cleaned}`);
            };
            mount(() => List({
                get each() { return rows(); },
                children: (item) => each(() => [item()], (owned) => {
                    const key = owned();
                    if (key === "final") finalMade++;
                    cleanup(() => { if (key === "final") finalCleaned++; });
                    return text(key);
                }, (key) => key),
            }));
            "#,
        )
        .unwrap();
        let initial = take_ops(&host);
        let list = initial
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 0), (1, 1)]);
        created_text(&take_ops(&host), "final");
        host.eval_script("expand.js", "expand(); check(1, 0)")
            .unwrap();
        // The core preserves the final item's slot and moves its index.
        // The JS row must keep that same owner before and after the bind.
        take_ops(&host);
        host.bind_list(list, &[(1, 2), (2, 1)]);
        host.eval_script("expanded.js", "check(1, 0)").unwrap();
        take_ops(&host);
        host.eval_script("collapse.js", "collapse(); check(1, 0)")
            .unwrap();
        take_ops(&host);
        host.bind_list(list, &[(1, 1)]);
        host.eval_script("collapsed.js", "check(1, 0)").unwrap();
        take_ops(&host);
        // A genuine same-index replacement reaches its keyed child when the
        // core consumes the splice and binds the replacement.
        host.eval_script("replace.js", "replaceFinal(); check(1, 0)")
            .unwrap();
        take_ops(&host);
        host.bind_list(list, &[(1, 1)]);
        host.eval_script("replaced.js", "check(1, 1)").unwrap();
        created_text(&take_ops(&host), "replacement");
        assert!(!host.has_exception());
    }

    #[test]
    fn pending_previous_frame_bind_keeps_the_selected_row_owner() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal, cleanup } from "nsh";
            import { each, text } from "nsh:rt";
            import { List } from "nsh";
            const rows = signal(["A", "B"]);
            let made = 0, cleaned = 0, select;
            globalThis.prepend = value => rows.set([value, ...rows()]);
            globalThis.selectB = () => select(true);
            globalThis.check = () => {
                if (made !== 1 || cleaned !== 0)
                    throw Error(`B owner ${made}/${cleaned}, expected 1/0`);
            };
            mount(() => List({
                get each() { return rows(); },
                children: (item, index) => each(() => [item()], owned => {
                    const key = owned();
                    const selected = signal(false);
                    if (key === "B") { made++; select = value => selected.set(value); }
                    cleanup(() => { if (key === "B") cleaned++; });
                    return () => `${key}:${selected()}:${index()}`;
                }, key => key),
            }));
        "#,
        )
        .unwrap();
        let list = take_ops(&host)
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 1)]);
        let original = created_text(&take_ops(&host), "B:false:1");
        host.eval_script("select.js", "selectB(); check()").unwrap();
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == original && text == "B:true:1")));
        host.eval_script("first.js", "prepend('X'); check()")
            .unwrap();
        // Core consumes this splice and queues slot 0 -> index 2.
        take_ops(&host);
        // Next turn's JS timers can run before that pending bind is served.
        host.eval_script("second.js", "prepend('Y'); check()")
            .unwrap();
        host.bind_list(list, &[(0, 2)]);
        host.eval_script("old-bind.js", "check()").unwrap();
        let pending = take_ops(&host);
        assert!(
            !pending
                .iter()
                .any(|op| matches!(op, Op::Remove { child, .. } if *child == original))
        );
        host.bind_list(list, &[(0, 3)]);
        host.eval_script("current-bind.js", "check()").unwrap();
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == original && text == "B:true:3")));

        assert!(!host.has_exception());
    }

    #[test]
    fn indexed_snapshots_render_requested_rows_and_keep_cell_owners() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { mount, signal, cleanup } from "nsh";
            import { cond, text } from "nsh:rt";
            import { List } from "nsh";
            const shown = signal(true);
            let made = 0, cleaned = 0, visible;
            function snapshot(prefix) {
                return {
                    length: 1000000, prefix,
                    at(index) {
                        if (index !== 2 && index !== 999999)
                            throw Error(`unrequested item ${index}`);
                        return { id: String(index), text: `${this.prefix} ${index}` };
                    },
                };
            }
            const source = signal(snapshot("Original"));
            globalThis.replace = () => source.set(snapshot("Updated"));
            globalThis.hide = () => shown.set(false);
            globalThis.check = (expectedMade, expectedCleaned, expectedVisible) => {
                if (made !== expectedMade || cleaned !== expectedCleaned || visible !== expectedVisible)
                    throw Error(`state ${made}/${cleaned}/${visible}`);
            };
            mount(() => cond(() => shown(), () => List({
                get each() { return source(); },
                keyExtractor: (item) => item.id,
                onViewableItemsChange: ({ viewableItems }) => {
                    visible = viewableItems.map(({ item, key, index }) => `${key}:${index}:${item.text}`).join(",");
                },
                children: (item) => {
                    made++;
                    cleanup(() => cleaned++);
                    return () => item().text;
                },
            }), () => text("Gone")));
            "#,
        )
        .unwrap();
        let initial = take_ops(&host);
        let list = initial
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        assert!(initial.iter().any(|op| matches!(
            op,
            Op::SetProp { id, prop: Prop::Count(1_000_000) } if *id == list
        )));
        host.bind_list(list, &[(0, 2)]);
        let bound = take_ops(&host);
        let body = created_text(&bound, "Original 2");
        let cell = bound
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::Cell } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 999_999)]);
        let recycled = take_ops(&host);
        assert!(recycled.iter().any(|op| matches!(
            op,
            Op::SetText { id, text } if *id == body && text == "Original 999999"
        )));
        assert!(recycled.iter().any(|op| matches!(
            op,
            Op::SetProp { id, prop: Prop::CellIndex(999_999) } if *id == cell
        )));
        assert!(
            !recycled
                .iter()
                .any(|op| matches!(op, Op::Create { tag: Tag::Cell, .. }))
        );
        host.eval_script("replace.js", "replace(); check(1, 0, undefined)")
            .unwrap();
        let replaced = take_ops(&host);
        assert!(replaced.iter().any(|op| matches!(
            op,
            Op::SetProp { id, prop: Prop::Splice(0, 1_000_000, 1_000_000) } if *id == list
        )));
        host.bind_list(list, &[(0, 999_999)]);
        assert!(take_ops(&host).iter().any(|op| matches!(op,
            Op::SetText { id, text } if *id == body && text == "Updated 999999")));
        host.dispatch_event(
            list,
            EventKind::ViewableItemsChange,
            &EventPayload::Map(vec![
                ("first", PayloadValue::Number(999_999.0)),
                ("last", PayloadValue::Number(999_999.0)),
            ]),
        );
        host.eval_script(
            "visible.js",
            "check(1, 0, '999999:999999:Updated 999999'); hide(); check(1, 1, '999999:999999:Updated 999999')",
        )
        .unwrap();
        created_text(&take_ops(&host), "Gone");
        host.eval_script("disposed.js", "replace()").unwrap();
        assert!(take_ops(&host).is_empty());
        assert!(!host.has_exception());
    }

    #[test]
    fn indexed_source_exceptions_reach_the_host_without_poisoning_the_context() {
        for (source, expected) in [
            (
                "{ get length() { throw Error('source length failed'); }, at() {} }",
                "source length failed",
            ),
            (
                "{ length: 1, get at() { throw Error('source method failed'); } }",
                "source method failed",
            ),
        ] {
            let host = Host::new().unwrap();
            let error = host
                .eval_source(&format!(
                    "import {{ mount }} from 'nsh'; import {{ List }} from 'nsh';\n\
                     mount(() => List({{ each: {source}, children: (item) => () => item() }}));"
                ))
                .unwrap_err();
            assert_js_exception(&error.message, expected);
            assert!(!host.has_exception());
            host.eval_source("import { text } from 'nsh:rt'; text('Context recovered');")
                .unwrap();
            created_text(&take_ops(&host), "Context recovered");
        }
        let mut host = Host::new().unwrap();
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        host.set_error_handler(Box::new(move |error| {
            seen.borrow_mut().push(error.message.clone())
        }));
        host.eval_source(
            r#"
            import { mount } from "nsh";
            import { List } from "nsh";
            mount(() => List({
                each: { length: 3, at(index) {
                    if (index === 1) throw Error("source item failed");
                    return `Row ${index}`;
                } },
                onViewableItemsChange: () => { throw Error("invalid source reported"); },
                children: (item) => () => item(),
            }));
            "#,
        )
        .unwrap();
        let list = take_ops(&host)
            .iter()
            .find_map(|op| match op {
                Op::Create { id, tag: Tag::List } => Some(*id),
                _ => None,
            })
            .unwrap();
        host.bind_list(list, &[(0, 0)]);
        let body = created_text(&take_ops(&host), "Row 0");
        host.bind_list(list, &[(0, 1)]);
        {
            let errors = errors.borrow();
            assert_eq!(errors.len(), 1, "{errors:?}");
            assert_js_exception(&errors[0], "source item failed");
        }
        assert!(!host.has_exception());
        take_ops(&host);
        host.bind_list(list, &[(0, 2)]);
        let recovered = take_ops(&host);
        assert!(
            recovered.iter().any(|op| matches!(
                op,
                Op::SetText { id, text } if *id == body && text == "Row 2"
            )),
            "recovered ops: {recovered:?}; original body: {body:?}"
        );
        host.dispatch_event(
            list,
            EventKind::ViewableItemsChange,
            &EventPayload::Map(vec![
                ("first", PayloadValue::Number(0.0)),
                ("last", PayloadValue::Number(1.0)),
            ]),
        );
        {
            let errors = errors.borrow();
            assert_eq!(errors.len(), 2, "{errors:?}");
            assert_js_exception(&errors[0], "source item failed");
            assert_js_exception(&errors[1], "source item failed");
        }
        assert!(!host.has_exception());
        host.bind_list(list, &[(0, 0)]);
        let recovered = take_ops(&host);
        assert!(recovered.iter().any(|op| matches!(
            op,
            Op::SetText { id, text } if *id == body && text == "Row 0"
        )));
        assert_eq!(errors.borrow().len(), 2);
        assert!(!host.has_exception());
    }

    const REACTIVE_SLOTS: &str = r#"
        import { mount, signal, cleanup } from "nsh";
        import { component, cond, text } from "nsh:rt";
        import { List } from "nsh";
        const active = signal(true);
        const shown = signal(true);
        let made = 0, cleaned = 0, rows = 0;
        function Status() {
            made++;
            cleanup(() => cleaned++);
            return cond(() => active(), () => text("Updating"), () => text("Ready"));
        }
        globalThis.update = (value) => active.set(value);
        globalThis.show = (value) => shown.set(value);
        globalThis.checkLife = (expectedMade, expectedCleaned, expectedRows) => {
            if (made !== expectedMade || cleaned !== expectedCleaned || rows !== expectedRows)
                throw Error(`lifecycle ${made}/${cleaned}/${rows}, expected ${expectedMade}/${expectedCleaned}/${expectedRows}`);
        };
        mount(() => cond(() => shown(), () => List({
            each: SLOT_ITEMS,
            children: (item) => { rows++; return () => `Row ${item()}`; },
            get SLOT_PROPERTY() { return SLOT_EXPRESSION; },
        }), () => text("Gone")));
    "#;

    const SLOT_FORMS: [(&str, usize); 3] = [
        ("() => active() ? text(\"Updating\") : text(\"Ready\")", 0),
        ("component(Status, {})", 1),
        ("() => component(Status, {})", 1),
    ];

    /// Plain callable children, components rooted in an `If`, and slot
    /// factories all update without remounting a component or losing cleanup.
    #[test]
    fn list_slots_keep_reactive_children_and_their_owners() {
        for slot in ["header", "footer", "empty"] {
            for (expression, components) in SLOT_FORMS {
                let host = Host::new().unwrap();
                host.eval_source(
                    &REACTIVE_SLOTS
                        .replace("SLOT_ITEMS", "[]")
                        .replace("SLOT_PROPERTY", slot)
                        .replace("SLOT_EXPRESSION", expression),
                )
                .unwrap();
                let first = take_ops(&host);
                let updating = created_text(&first, "Updating");
                assert!(
                    first
                        .iter()
                        .any(|op| matches!(op, Op::Insert { child, .. } if *child == updating))
                );

                host.eval_script("update.js", "update(false)").unwrap();
                let changed = take_ops(&host);
                let ready = created_text(&changed, "Ready");
                assert!(
                    changed
                        .iter()
                        .any(|op| matches!(op, Op::Remove { child, .. } if *child == updating))
                );
                assert!(
                    changed
                        .iter()
                        .any(|op| matches!(op, Op::Insert { child, .. } if *child == ready))
                );
                host.eval_script("lifecycle.js", &format!("checkLife({components}, 0, 0)"))
                    .unwrap();

                host.eval_script("hide.js", "show(false)").unwrap();
                created_text(&take_ops(&host), "Gone");
                host.eval_script(
                    "disposed.js",
                    &format!("checkLife({components}, {components}, 0); update(true)"),
                )
                .unwrap();
                assert!(take_ops(&host).is_empty(), "a disposed slot still rendered");

                host.eval_script("show.js", "show(true)").unwrap();
                created_text(&take_ops(&host), "Updating");
                host.eval_script(
                    "remounted.js",
                    &format!("checkLife({}, {components}, 0)", components * 2),
                )
                .unwrap();
            }
        }
    }

    /// Separators stay lazy and keep their component through cell reuse;
    /// changing their child while hidden is reflected when they return.
    #[test]
    fn separators_keep_reactive_children_across_cell_reuse() {
        for (expression, components) in SLOT_FORMS {
            let host = Host::new().unwrap();
            host.eval_source(
                &REACTIVE_SLOTS
                    .replace("SLOT_ITEMS", "[1, 2, 3]")
                    .replace("SLOT_PROPERTY", "separator")
                    .replace("SLOT_EXPRESSION", expression),
            )
            .unwrap();
            let list = take_ops(&host)
                .iter()
                .find_map(|op| match op {
                    Op::Create { id, tag: Tag::List } => Some(*id),
                    _ => None,
                })
                .expect("a list");
            host.bind_list(list, &[(0, 2)]);
            let last = take_ops(&host);
            created_text(&last, "Row 3");
            assert!(
                !last
                    .iter()
                    .any(|op| matches!(op, Op::CreateText { text, .. } if text == "Updating"))
            );
            host.eval_script("lazy.js", "checkLife(0, 0, 1)").unwrap();

            host.bind_list(list, &[(0, 0)]);
            let first = take_ops(&host);
            let updating = created_text(&first, "Updating");
            assert!(
                first
                    .iter()
                    .any(|op| matches!(op, Op::Insert { child, .. } if *child == updating))
            );
            host.eval_script("update.js", "update(false)").unwrap();
            let changed = take_ops(&host);
            let ready = created_text(&changed, "Ready");
            assert!(
                changed
                    .iter()
                    .any(|op| matches!(op, Op::Remove { child, .. } if *child == updating))
            );
            assert!(
                changed
                    .iter()
                    .any(|op| matches!(op, Op::Insert { child, .. } if *child == ready))
            );

            host.bind_list(list, &[(0, 2)]);
            assert!(
                take_ops(&host)
                    .iter()
                    .any(|op| matches!(op, Op::Remove { child, .. } if *child == ready))
            );
            host.eval_script("hidden.js", "update(true)").unwrap();
            let hidden = take_ops(&host);
            let hidden_updating = created_text(&hidden, "Updating");
            assert!(
                !hidden
                    .iter()
                    .any(|op| matches!(op, Op::Insert { child, .. } if *child == hidden_updating))
            );
            host.bind_list(list, &[(0, 1)]);
            let reused = take_ops(&host);
            assert!(
                reused
                    .iter()
                    .any(|op| matches!(op, Op::Insert { child, .. } if *child == hidden_updating))
            );
            host.eval_script("kept.js", &format!("checkLife({components}, 0, 1)"))
                .unwrap();

            host.eval_script("hide.js", "show(false)").unwrap();
            created_text(&take_ops(&host), "Gone");
            host.eval_script(
                "disposed.js",
                &format!("checkLife({components}, {components}, 1); update(false)"),
            )
            .unwrap();
            assert!(
                take_ops(&host).is_empty(),
                "a disposed separator still rendered"
            );
        }
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
}
