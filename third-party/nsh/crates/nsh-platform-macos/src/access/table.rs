//! AppKit's table relationships, derived on demand from the mounted roles.
//! No indices or spans are declared by NSH: mounted rows and their cells
//! are in tree order, with unit spans. Nested tables have their own axes.

use nsh_core::AccessibilityRole as Role;
use objc2::{
    DefinedClass, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, Sel},
    sel,
};
use objc2_app_kit::{NSAccessibility, NSAccessibilityColumnRole, NSAccessibilityElement, NSView};
use objc2_foundation::{NSArray, NSNotFound, NSRange, NSRect};

use super::{Reached, reached};
use crate::view::NshView;

fn role(view: &NshView) -> Role {
    view.try_state()
        .map_or(Role::None, |s| s.props.accessibility.role)
}

fn is_table(role: Role) -> bool {
    matches!(role, Role::Table | Role::Grid)
}

/// Only advertise table attributes on tables, and cell attributes on cells.
pub(crate) fn allows(view: &NshView, selector: Sel) -> Option<bool> {
    let role = role(view);
    if [
        sel!(accessibilityRows),
        sel!(accessibilityVisibleRows),
        sel!(accessibilitySelectedRows),
        sel!(accessibilityColumns),
        sel!(accessibilityVisibleColumns),
        sel!(accessibilityRowCount),
        sel!(accessibilityColumnCount),
        sel!(accessibilityCellForColumn:row:),
        sel!(accessibilityHeader),
    ]
    .contains(&selector)
    {
        Some(is_table(role))
    } else if selector == sel!(accessibilityVisibleCells) {
        Some(is_table(role) || role == Role::Row)
    } else if [
        sel!(accessibilityRowIndexRange),
        sel!(accessibilityColumnIndexRange),
    ]
    .contains(&selector)
    {
        Some(matches!(role, Role::Cell | Role::ColumnHeader))
    } else if selector == sel!(accessibilityColumnHeaderUIElements) {
        Some(is_table(role) || matches!(role, Role::Cell | Role::ColumnHeader))
    } else if selector == sel!(accessibilityIndex) {
        Some(role == Role::Row)
    } else {
        None
    }
}

/// Collects one axis through row groups and layout wrappers, stopping at
/// another structural element. Hidden and folded content stays hidden.
fn descendants(view: &NshView, accepts: fn(Role) -> bool) -> Vec<NshView> {
    fn gather(view: &NshView, accepts: fn(Role) -> bool, out: &mut Vec<NshView>) {
        if !view
            .try_state()
            .is_some_and(|s| reached(&s) == Reached::All)
        {
            return;
        }
        for child in view.child_views() {
            if child.try_state().is_none_or(|s| s.access.ax.hidden) {
                continue;
            }
            let role = role(&child);
            if accepts(role) && child.ns().isAccessibilityElement() {
                out.push(child);
            } else if !matches!(
                role,
                Role::Table | Role::Grid | Role::Row | Role::Cell | Role::ColumnHeader
            ) {
                gather(&child, accepts, out);
            }
        }
    }
    let mut out = Vec::new();
    gather(view, accepts, &mut out);
    out
}

/// The exposed rows of a table, including header rows and offscreen rows.
pub(crate) fn rows(view: &NshView) -> Option<Vec<NshView>> {
    is_table(role(view)).then(|| descendants(view, |r| r == Role::Row))
}

fn cells(row: &NshView) -> Vec<NshView> {
    descendants(row, |r| matches!(r, Role::Cell | Role::ColumnHeader))
}

/// Views as the same accessibility objects AppKit reaches in the view tree.
pub(crate) fn array(views: &[NshView]) -> Retained<NSArray> {
    NSArray::from_slice(
        &views
            .iter()
            .map(|v| v.ns().as_ref())
            .collect::<Vec<&AnyObject>>(),
    )
}

fn ancestor(view: &NshView, accepts: fn(Role) -> bool) -> Option<NshView> {
    let mut at = view.parent_view();
    while let Some(view) = at {
        let role = role(&view);
        if accepts(role) {
            return Some(view);
        }
        if matches!(
            role,
            Role::Table | Role::Grid | Role::Row | Role::Cell | Role::ColumnHeader
        ) {
            return None;
        }
        at = view.parent_view();
    }
    None
}

/// The index of a row among its table's rows.
pub(crate) fn row_index(view: &NshView) -> Option<usize> {
    let table = ancestor(view, is_table)?;
    rows(&table)?.iter().position(|r| r.ns() == view.ns())
}

/// A cell's zero-based row or column range, or an unknown range outside a table.
pub(crate) fn range(view: &NshView, column: bool) -> NSRange {
    let index = (|| {
        if !matches!(role(view), Role::Cell | Role::ColumnHeader) {
            return None;
        }
        let row = ancestor(view, |r| r == Role::Row)?;
        let index = row_index(&row)?;
        let cell_index = cells(&row).iter().position(|c| c.ns() == view.ns())?;
        if column {
            Some(cell_index)
        } else {
            Some(index)
        }
    })();
    index.map_or(NSRange::new(NSNotFound as usize, 0), |i| NSRange::new(i, 1))
}

/// The cell at a table coordinate. Negative and out-of-range indices have no cell.
pub(crate) fn cell(view: &NshView, column: isize, row: isize) -> Option<NshView> {
    let rows = rows(view)?;
    let row = rows.get(usize::try_from(row).ok()?)?;
    cells(row).get(usize::try_from(column).ok()?).cloned()
}

/// The table's column headers, or the headers of a cell's column.
pub(crate) fn headers(view: &NshView) -> Option<Vec<NshView>> {
    if matches!(role(view), Role::Cell | Role::ColumnHeader) {
        let row = ancestor(view, |r| r == Role::Row)?;
        let table = ancestor(&row, is_table)?;
        let index = cells(&row).iter().position(|c| c.ns() == view.ns())?;
        return Some(
            rows(&table)?
                .iter()
                .filter_map(|r| {
                    cells(r)
                        .get(index)
                        .filter(|c| role(c) == Role::ColumnHeader)
                        .cloned()
                })
                .collect(),
        );
    }
    Some(
        rows(view)?
            .iter()
            .flat_map(cells)
            .filter(|c| role(c) == Role::ColumnHeader)
            .collect(),
    )
}

/// The first row containing column headers is the table's header.
pub(crate) fn header(view: &NshView) -> Option<NshView> {
    rows(view)?
        .into_iter()
        .find(|r| cells(r).iter().any(|c| role(c) == Role::ColumnHeader))
}

/// The number of mounted columns, including a ragged row's extra cells.
pub(crate) fn column_count(view: &NshView) -> usize {
    rows(view)
        .unwrap_or_default()
        .iter()
        .map(|r| cells(r).len())
        .max()
        .unwrap_or(0)
}

/// Visible cells are required for AppKit's cell-based tables.
pub(crate) fn visible_cells(view: &NshView) -> Option<Retained<NSArray>> {
    let cells = if role(view) == Role::Row {
        cells(view)
    } else {
        rows(view)?.iter().flat_map(cells).collect()
    };
    Some(array(
        &cells.into_iter().filter(NshView::shown).collect::<Vec<_>>(),
    ))
}

/// Stable column objects; their children and headers are read live, so retained
/// AX objects follow insertions, removals, hiding and reordering too.
pub(crate) fn columns(view: &NshView, visible: bool) -> Option<Retained<NSArray>> {
    if !is_table(role(view)) {
        return None;
    }
    let count = column_count(view);
    let mut s = view.state_mut();
    let columns = &mut s.access.columns;
    columns.truncate(count);
    while columns.len() < count {
        let column = Column::alloc(view.ns().mtm()).set_ivars(ColumnState {
            table: Weak::new(view.ns()),
            index: columns.len(),
        });
        // SAFETY: initializing the NSAccessibilityElement superclass.
        let column: Retained<Column> = unsafe { msg_send![super(column), init] };
        column.setAccessibilityElement(true);
        // SAFETY: immutable AppKit role constant.
        unsafe { column.setAccessibilityRole(Some(NSAccessibilityColumnRole)) };
        columns.push(column);
    }
    // Release the state before asking columns for their live cells.
    let columns = columns.clone();
    drop(s);
    Some(NSArray::from_slice(
        &columns
            .iter()
            .filter(|c| !visible || c.cells().iter().any(NshView::shown))
            .map(|c| AsRef::<AnyObject>::as_ref(&**c))
            .collect::<Vec<_>>(),
    ))
}

/// One column's weak table link and position in its mounted cells.
#[derive(Debug)]
pub(crate) struct ColumnState {
    // Weak: a column retained by a client must not keep the surface alive.
    table: Weak<NSView>,
    index: usize,
}

define_class!(
    #[unsafe(super(NSAccessibilityElement))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ColumnState]
    #[name = "NshAccessibilityColumn"]
    #[derive(Debug)]
    pub(crate) struct Column;

    impl Column {
        #[unsafe(method_id(accessibilityParent))]
        fn parent(&self) -> Option<Retained<AnyObject>> {
            self.ivars().table.load().map(|v| v.into_super().into_super().into_super())
        }

        #[unsafe(method(accessibilityIndex))]
        fn index(&self) -> isize {
            self.ivars().index as isize
        }

        #[unsafe(method_id(accessibilityChildren))]
        fn children(&self) -> Option<Retained<NSArray>> {
            Some(array(&self.cells()))
        }

        #[unsafe(method_id(accessibilityHeader))]
        fn header(&self) -> Option<Retained<AnyObject>> {
            self.cells().into_iter().find(|c| role(c) == Role::ColumnHeader)
                .map(|v| v.ns().retain().into_super().into_super().into_super())
        }

        #[unsafe(method(accessibilityFrame))]
        fn frame(&self) -> NSRect {
            self.cells().iter().map(|c| c.ns().accessibilityFrame()).reduce(|a, b| {
                let x = a.origin.x.min(b.origin.x);
                let y = a.origin.y.min(b.origin.y);
                NSRect::new(
                    objc2_foundation::NSPoint::new(x, y),
                    objc2_foundation::NSSize::new(
                        (a.origin.x + a.size.width).max(b.origin.x + b.size.width) - x,
                        (a.origin.y + a.size.height).max(b.origin.y + b.size.height) - y,
                    ),
                )
            }).unwrap_or_default()
        }
    }
);

impl Column {
    fn cells(&self) -> Vec<NshView> {
        self.ivars()
            .table
            .load()
            .and_then(|v| NshView::from_ns(&v))
            .and_then(|v| rows(&v))
            .unwrap_or_default()
            .iter()
            .filter_map(|r| cells(r).get(self.ivars().index).cloned())
            .collect()
    }
}
