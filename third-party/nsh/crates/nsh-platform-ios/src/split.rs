//! `nsh/base`'s `SplitView` on iOS and Mac Catalyst: a
//! `UISplitViewController` (`nsh_core::platform::SPLIT_VIEW_COMPONENT`)
//! whose columns are the navigation controllers of the `NavStack`s the view
//! places in its column wrappers, before the component's container
//! (`nsh-base`'s `split_view.rs` describes the component's props and
//! events).
//!
//! Expanded, each column shows its stack's own `UINavigationController`:
//! the system header, swipe back, and the split's own behavior (iPadOS 26's
//! floating sidebar, the swipe from the edge, the sidebar button, display
//! modes that follow the window). Which columns show is the app's
//! `columnVisibility`, applied as the preferred display mode; what the user
//! or the system shows instead is reported (`columnVisibilityChange`),
//! except the system's own changes while the window turns or is resized
//! with `automatic`.
//!
//! Collapsed (a horizontally compact window), the split shows its compact
//! column: one navigation controller of this module's
//! ([`SplitHost::compact`]), which the mounter fills with the columns'
//! pages in order (the sidebar's, then the content's, then the detail's,
//! as far as the visibility goes), taken out of the columns' navigation
//! controllers and given back when the split expands. Each page stays its
//! own stack's: going back from a page that is not its stack's first is
//! reported to the page as a native pop (`Dismiss`), going back from a
//! column's first page shows the column before (`compactColumnChange`), and
//! a page the app pushes on any column goes onto the compact stack. The
//! mounter's side is in `mount.rs` (`sync_split` and the split arms of the
//! stack callbacks).
//!
//! The system tab bar (`nsh/mobile`'s `TabBar`) follows the pages a split
//! shows as it would a stack's in the split's place ([`bar_role`]): the
//! expanded columns' pages together, the compact stack's while collapsed.

use std::cell::Cell;

use block2::RcBlock;
use nsh_base::ColumnVisibility;
use nsh_core::NodeId;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol, ProtocolObject},
};
use objc2_core_foundation::CGSize;
use objc2_ui_kit::{
    UINavigationController, UIResponder, UISplitViewController, UISplitViewControllerColumn,
    UISplitViewControllerDelegate, UISplitViewControllerDisplayMode,
    UISplitViewControllerSplitBehavior, UISplitViewControllerStyle, UITraitCollection, UIView,
    UIViewAutoresizing, UIViewController, UIViewControllerTransitionCoordinator,
    UIViewControllerTransitionCoordinatorContext,
};

use crate::{mount::SharedMounter, navigation::StackHost};

pub(crate) struct SplitIvars {
    /// The native component's node: the split's events go to it.
    id: NodeId,
    mounter: SharedMounter,
    /// The window changes size or traits: display modes change as the
    /// system decides.
    resizing: Cell<bool>,
    /// The split has appeared: before, the display mode it takes is the
    /// system's first.
    appeared: Cell<bool>,
}

define_class!(
    /// The split view controller of a `SplitView`, its own delegate.
    #[unsafe(super(UISplitViewController, UIViewController, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SplitIvars]
    pub(crate) struct SplitController;

    unsafe impl NSObjectProtocol for SplitController {}

    impl SplitController {
        /// A split that collapsed or expanded without telling its delegate
        /// (the first time it is in a window) has its pages moved before
        /// it lays them out.
        #[unsafe(method(viewWillLayoutSubviews))]
        fn view_will_layout_subviews(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewWillLayoutSubviews] };
            let id = self.ivars().id;
            self.with_mounter(|m| m.split_settle(id));
        }

        #[unsafe(method(viewDidAppear:))]
        fn view_did_appear(&self, animated: bool) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), viewDidAppear: animated] };
            self.ivars().appeared.set(true);
        }

        #[unsafe(method(viewWillTransitionToSize:withTransitionCoordinator:))]
        fn view_will_transition_to_size(
            &self,
            size: CGSize,
            coordinator: &ProtocolObject<dyn UIViewControllerTransitionCoordinator>,
        ) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe {
                msg_send![super(self), viewWillTransitionToSize: size, withTransitionCoordinator: coordinator]
            };
            self.resizing_during(coordinator);
        }

        #[unsafe(method(willTransitionToTraitCollection:withTransitionCoordinator:))]
        fn will_transition_to_traits(
            &self,
            traits: &UITraitCollection,
            coordinator: &ProtocolObject<dyn UIViewControllerTransitionCoordinator>,
        ) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe {
                msg_send![super(self), willTransitionToTraitCollection: traits, withTransitionCoordinator: coordinator]
            };
            self.resizing_during(coordinator);
        }
    }

    unsafe impl UISplitViewControllerDelegate for SplitController {
        /// The user (the sidebar button, a swipe from the edge, a press
        /// beside an overlaid column) or the system changed what shows.
        #[unsafe(method(splitViewController:willChangeToDisplayMode:))]
        fn will_change_to_display_mode(
            &self,
            _split: &UISplitViewController,
            mode: UISplitViewControllerDisplayMode,
        ) {
            let ivars = self.ivars();
            let system = ivars.resizing.get() || !ivars.appeared.get();
            let id = ivars.id;
            self.with_mounter(|m| m.split_display_mode(id, mode, system));
        }

        /// Expanding shows the app's visibility, when it names one.
        #[unsafe(method(splitViewController:displayModeForExpandingToProposedDisplayMode:))]
        fn display_mode_for_expanding(
            &self,
            _split: &UISplitViewController,
            proposed: UISplitViewControllerDisplayMode,
        ) -> UISplitViewControllerDisplayMode {
            let id = self.ivars().id;
            let mtm = self.mtm();
            match self.ivars().mounter.get(mtm).try_borrow() {
                Ok(m) => m
                    .as_ref()
                    .and_then(|m| m.split_expanding_mode(id))
                    .unwrap_or(proposed),
                Err(_) => proposed,
            }
        }

        #[unsafe(method(splitViewControllerDidCollapse:))]
        fn did_collapse(&self, _split: &UISplitViewController) {
            let id = self.ivars().id;
            self.with_mounter(|m| m.split_settle(id));
        }

        #[unsafe(method(splitViewControllerDidExpand:))]
        fn did_expand(&self, _split: &UISplitViewController) {
            let id = self.ivars().id;
            self.with_mounter(|m| m.split_settle(id));
        }
    }
);

impl SplitController {
    fn new(
        mtm: MainThreadMarker,
        id: NodeId,
        mounter: SharedMounter,
        triple: bool,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(SplitIvars {
            id,
            mounter,
            resizing: Cell::new(false),
            appeared: Cell::new(false),
        });
        let style = if triple {
            UISplitViewControllerStyle::TripleColumn
        } else {
            UISplitViewControllerStyle::DoubleColumn
        };
        // SAFETY: UISplitViewController's initializer of a column-style
        // split.
        let this: Retained<Self> = unsafe { msg_send![super(this), initWithStyle: style] };
        // The controller is its own delegate (held weakly).
        this.setDelegate(Some(ProtocolObject::from_ref(&*this)));
        this
    }

    fn with_mounter(&self, f: impl FnOnce(&mut crate::mount::Mounter)) {
        // Split callbacks can come while a batch is applied (setting the
        // columns, the display mode): the mounter settles the split at its
        // end.
        if let Ok(mut m) = self.ivars().mounter.get(self.mtm()).try_borrow_mut()
            && let Some(m) = m.as_mut()
        {
            f(m);
        }
    }

    /// The display modes that change until `coordinator`'s transition ends
    /// are the system's.
    fn resizing_during(
        &self,
        coordinator: &ProtocolObject<dyn UIViewControllerTransitionCoordinator>,
    ) {
        self.ivars().resizing.set(true);
        // The block holds the controller until the transition ends.
        let this = self.retain();
        let done = RcBlock::new(
            move |_: std::ptr::NonNull<
                ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>,
            >| this.ivars().resizing.set(false),
        );
        if !coordinator.animateAlongsideTransition_completion(None, Some(&done)) {
            self.ivars().resizing.set(false);
        }
    }
}

/// The column of the split's `index`th (0 the sidebar, 1 the content, 2
/// the detail).
pub(crate) fn column(index: usize) -> UISplitViewControllerColumn {
    match index {
        0 => UISplitViewControllerColumn::Primary,
        1 => UISplitViewControllerColumn::Supplementary,
        _ => UISplitViewControllerColumn::Secondary,
    }
}

/// The display mode that shows `visibility` with `triple` columns, as
/// `behavior` (the split's own, as the window's size makes it) lays them
/// out: beside the detail where the columns tile, over it where they
/// overlay, displacing it where they displace.
pub(crate) fn display_mode(
    visibility: ColumnVisibility,
    triple: bool,
    behavior: UISplitViewControllerSplitBehavior,
) -> UISplitViewControllerDisplayMode {
    use UISplitViewControllerDisplayMode as Mode;
    use UISplitViewControllerSplitBehavior as Behavior;
    match visibility {
        ColumnVisibility::Automatic => Mode::Automatic,
        ColumnVisibility::DetailOnly => Mode::SecondaryOnly,
        ColumnVisibility::All if triple => match behavior {
            Behavior::Overlay => Mode::TwoOverSecondary,
            Behavior::Displace => Mode::TwoDisplaceSecondary,
            _ => Mode::TwoBesideSecondary,
        },
        // Two columns' `all` and three's `doubleColumn`: one column beside
        // (or over) the detail.
        _ => match behavior {
            Behavior::Overlay => Mode::OneOverSecondary,
            _ => Mode::OneBesideSecondary,
        },
    }
}

/// The visibility display mode `mode` shows with `triple` columns (`None`
/// for `automatic`, which is no shown state).
pub(crate) fn visibility_of(
    mode: UISplitViewControllerDisplayMode,
    triple: bool,
) -> Option<ColumnVisibility> {
    use UISplitViewControllerDisplayMode as Mode;
    match mode {
        Mode::SecondaryOnly => Some(ColumnVisibility::DetailOnly),
        Mode::OneBesideSecondary | Mode::OneOverSecondary => Some(match triple {
            true => ColumnVisibility::DoubleColumn,
            false => ColumnVisibility::All,
        }),
        Mode::TwoBesideSecondary | Mode::TwoOverSecondary | Mode::TwoDisplaceSecondary => {
            Some(ColumnVisibility::All)
        }
        _ => None,
    }
}

/// How many columns the collapsed split's stack shows for `visibility`
/// (`nsh-base`'s `ColumnVisibility::compact_column`, plus one): the
/// sidebar for `automatic` and `all`, up to the content for three
/// columns' `doubleColumn`, up to the detail for `detailOnly`.
pub(crate) fn compact_columns(visibility: ColumnVisibility, triple: bool) -> usize {
    match visibility {
        ColumnVisibility::Automatic | ColumnVisibility::All => 1,
        ColumnVisibility::DoubleColumn => 1 + usize::from(triple),
        ColumnVisibility::DetailOnly => 2 + usize::from(triple),
    }
}

/// A `SplitView`'s split: its controller, the stacks of its columns, the
/// compact stack and what the app asks for.
pub(crate) struct SplitHost {
    /// The view the component's container shows: the controller's view
    /// fills it.
    pub(crate) holder: Retained<UIView>,
    /// Made once the number of columns is known (the props come after the
    /// component), again when it changes.
    pub(crate) controller: Option<Retained<SplitController>>,
    /// The stacks of the sidebar, the content and the detail.
    pub(crate) columns: [Option<NodeId>; 3],
    /// Three columns (a content column).
    pub(crate) triple: bool,
    /// The visibility the app asks for.
    pub(crate) requested: ColumnVisibility,
    /// Bumped by the component to show `requested` again.
    pub(crate) revision: u64,
    /// The request (and its revision) last applied.
    pub(crate) applied: Option<(ColumnVisibility, u64)>,
    /// The stack of the collapsed split (its compact column), its pages
    /// the columns'.
    pub(crate) compact: StackHost,
    /// The columns' pages are in `compact`: the split is collapsed.
    pub(crate) collapsed: bool,
    /// How many columns `compact` shows, first to last.
    pub(crate) compact_columns: usize,
    /// What the expanded split shows, as last reported or applied.
    pub(crate) shown: Option<ColumnVisibility>,
    /// The columns' sizes last reported, in points.
    pub(crate) sizes: [Option<(f32, f32)>; 3],
}

impl SplitHost {
    pub(crate) fn new(mtm: MainThreadMarker, id: NodeId, mounter: SharedMounter) -> Self {
        let holder = UIView::new(mtm);
        holder.setAutoresizingMask(
            UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
        );
        Self {
            holder,
            controller: None,
            columns: [None; 3],
            triple: false,
            requested: ColumnVisibility::Automatic,
            revision: 0,
            applied: None,
            compact: StackHost::new(mtm, id, mounter),
            collapsed: false,
            compact_columns: 1,
            shown: None,
            sizes: [None; 3],
        }
    }

    /// Takes prop `name` of the component (`columns`, `columnVisibility`,
    /// `revision`).
    pub(crate) fn set_prop(&mut self, name: &str, value: Option<&nsh_core::JsonValue>) {
        match name {
            "columns" => {
                self.triple = value.and_then(|v| v.as_str()) == Some("triple");
            }
            "columnVisibility" => {
                self.requested = value
                    .and_then(|v| v.as_str())
                    .and_then(ColumnVisibility::from_name)
                    .unwrap_or_default();
            }
            "revision" => {
                self.revision = value.and_then(|v| v.as_u64()).unwrap_or(0);
            }
            _ => {}
        }
    }

    /// The controller for the number of columns asked for, made (again)
    /// when there is none for it: the one it replaces lets its columns go
    /// (its stacks are adopted again) and leaves its parent.
    pub(crate) fn controller_for_columns(
        &mut self,
        mtm: MainThreadMarker,
        id: NodeId,
        mounter: &SharedMounter,
    ) -> Retained<SplitController> {
        let style = if self.triple {
            UISplitViewControllerStyle::TripleColumn
        } else {
            UISplitViewControllerStyle::DoubleColumn
        };
        if let Some(controller) = &self.controller
            && controller.style() == style
        {
            return controller.clone();
        }
        if let Some(old) = self.controller.take() {
            remove_controller(&old);
        }
        let controller = SplitController::new(mtm, id, mounter.clone(), self.triple);
        controller.setViewController_forColumn(
            Some(&self.compact.nav),
            UISplitViewControllerColumn::Compact,
        );
        if let Some(view) = controller.view() {
            view.setAutoresizingMask(
                UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
            );
            view.setFrame(self.holder.bounds());
            self.holder.addSubview(&view);
        }
        self.columns = [None; 3];
        self.applied = None;
        self.shown = None;
        self.controller = Some(controller.clone());
        controller
    }

    /// Makes the controller a child of the controller showing the split
    /// (appearance callbacks, traits, rotation), once it is in a window.
    pub(crate) fn contain(&self) {
        let Some(controller) = &self.controller else {
            return;
        };
        if controller.parentViewController().is_some() || self.holder.window().is_none() {
            return;
        }
        let Some(parent) = crate::navigation::controller_of(&self.holder) else {
            return;
        };
        parent.addChildViewController(controller);
        controller.didMoveToParentViewController(Some(&parent));
    }

    /// Shows the app's visibility while expanded, if it changed since it
    /// was last applied (or the component asks to show it again):
    /// as the preferred display mode, animated in a window; a request made
    /// again over what the user showed shows and hides the columns too,
    /// since the preferred mode did not change.
    pub(crate) fn apply_visibility(&mut self) {
        let Some(controller) = self.controller.clone() else {
            return;
        };
        let request = (self.requested, self.revision);
        if self.applied == Some(request) || self.collapsed {
            return;
        }
        let again = self.applied.is_some_and(|(v, _)| v == self.requested);
        self.applied = Some(request);
        let visibility = self.requested;
        let triple = self.triple;
        let mode = display_mode(visibility, triple, controller.splitBehavior());
        if visibility != ColumnVisibility::Automatic {
            self.shown = Some(visibility);
        }
        let apply = {
            let controller = controller.clone();
            move || {
                controller.setPreferredDisplayMode(mode);
                if again && visibility_of(controller.displayMode(), triple) != Some(visibility) {
                    show_columns(&controller, visibility, triple);
                }
            }
        };
        if controller
            .viewIfLoaded()
            .is_some_and(|v| v.window().is_some())
            && !crate::mount::reduce_motion()
        {
            let block = RcBlock::new(apply);
            UIView::animateWithDuration_animations(0.3, &block, controller.mtm());
        } else {
            apply();
        }
    }

    /// The display mode the split expands to: the app's visibility when it
    /// names one.
    pub(crate) fn expanding_mode(&self) -> Option<UISplitViewControllerDisplayMode> {
        let controller = self.controller.as_ref()?;
        (self.requested != ColumnVisibility::Automatic)
            .then(|| display_mode(self.requested, self.triple, controller.splitBehavior()))
    }

    /// Lets the controller go (the component's node went).
    pub(crate) fn release(&mut self) {
        if let Some(controller) = self.controller.take() {
            remove_controller(&controller);
        }
        self.holder.removeFromSuperview();
    }
}

/// Shows the columns `visibility` shows and hides the others (a request
/// made again over what the user showed).
fn show_columns(controller: &UISplitViewController, visibility: ColumnVisibility, triple: bool) {
    use UISplitViewControllerColumn as Column;
    match visibility {
        ColumnVisibility::DetailOnly => {
            if triple {
                controller.hideColumn(Column::Supplementary);
            }
            controller.hideColumn(Column::Primary);
        }
        ColumnVisibility::DoubleColumn if triple => {
            controller.showColumn(Column::Supplementary);
            controller.hideColumn(Column::Primary);
        }
        ColumnVisibility::Automatic => {}
        _ => controller.showColumn(Column::Primary),
    }
}

/// What a navigation controller is to a `SplitView`'s split, for the
/// system tab bar (`navigation::slide_bottom_bar`): the pages the split
/// shows move the bar as the pages of a stack in the split's place would.
pub(crate) enum BarRole {
    /// None of a split's: a stack's own, or one in a page of a column.
    Stack,
    /// One the split shows its pages in now (the compact column's while it
    /// is collapsed, a column's while it is expanded): the bar is looked for
    /// from `place`, where the split is in the app's views, and stays off
    /// screen while a page of any of `shown` asks (an expanded split's
    /// columns, side by side).
    Shown {
        place: Retained<UIView>,
        shown: Vec<Retained<UINavigationController>>,
    },
    /// One whose pages show in another of the split's (a column's in the
    /// collapsed split's compact column, that one's in the expanded
    /// columns): it does not move the bar.
    Idle,
}

/// What navigation controller `nav` is to a `SplitView`'s split.
pub(crate) fn bar_role(nav: &UINavigationController) -> BarRole {
    use UISplitViewControllerColumn as Column;
    let Some(split) = nav
        .splitViewController()
        .and_then(|split| split.downcast::<SplitController>().ok())
    else {
        return BarRole::Stack;
    };
    let target: &UIViewController = nav;
    let is_nav = |controller: &UIViewController| std::ptr::eq(controller, target);
    let mut columns = vec![Column::Primary];
    if split.style() == UISplitViewControllerStyle::TripleColumn {
        columns.push(Column::Supplementary);
    }
    columns.push(Column::Secondary);
    let columns: Vec<Retained<UINavigationController>> = columns
        .into_iter()
        .filter_map(|column| split.viewControllerForColumn(column))
        .filter_map(|controller| controller.downcast::<UINavigationController>().ok())
        .collect();
    let compact = split
        .viewControllerForColumn(Column::Compact)
        .is_some_and(|controller| is_nav(&controller));
    if !compact && !columns.iter().any(|column| is_nav(column)) {
        return BarRole::Stack;
    }
    let place = split.viewIfLoaded().and_then(|view| view.superview());
    match (place, split.isCollapsed(), compact) {
        (Some(place), true, true) => BarRole::Shown {
            place,
            shown: vec![nav.retain()],
        },
        (Some(place), false, false) => BarRole::Shown {
            place,
            shown: columns,
        },
        _ => BarRole::Idle,
    }
}

/// Takes `controller` out of its parent and the view hierarchy.
fn remove_controller(controller: &SplitController) {
    controller.willMoveToParentViewController(None);
    if let Some(view) = controller.viewIfLoaded() {
        view.removeFromSuperview();
    }
    controller.removeFromParentViewController();
}

#[cfg(test)]
mod tests {
    use objc2_ui_kit::{
        UISplitViewControllerDisplayMode as Mode, UISplitViewControllerSplitBehavior as Behavior,
    };

    use super::*;

    #[test]
    fn display_modes_show_the_visibility_they_are_made_for() {
        for triple in [false, true] {
            for behavior in [Behavior::Tile, Behavior::Overlay, Behavior::Displace] {
                for visibility in [
                    ColumnVisibility::All,
                    ColumnVisibility::DoubleColumn,
                    ColumnVisibility::DetailOnly,
                ] {
                    let mode = display_mode(visibility, triple, behavior);
                    let shown = visibility_of(mode, triple);
                    // Two columns' `doubleColumn` is their `all`.
                    let expected = match (visibility, triple) {
                        (ColumnVisibility::DoubleColumn, false) => ColumnVisibility::All,
                        _ => visibility,
                    };
                    assert_eq!(
                        shown,
                        Some(expected),
                        "{visibility:?} {triple} {behavior:?}"
                    );
                }
            }
            assert_eq!(
                display_mode(ColumnVisibility::Automatic, triple, Behavior::Tile),
                Mode::Automatic
            );
            assert_eq!(visibility_of(Mode::Automatic, triple), None);
        }
        assert_eq!(
            display_mode(ColumnVisibility::All, true, Behavior::Tile),
            Mode::TwoBesideSecondary
        );
        assert_eq!(
            display_mode(ColumnVisibility::All, false, Behavior::Overlay),
            Mode::OneOverSecondary
        );
    }

    #[test]
    fn the_collapsed_stack_shows_columns_up_to_the_first_the_visibility_shows() {
        assert_eq!(compact_columns(ColumnVisibility::Automatic, true), 1);
        assert_eq!(compact_columns(ColumnVisibility::All, true), 1);
        assert_eq!(compact_columns(ColumnVisibility::DoubleColumn, true), 2);
        assert_eq!(compact_columns(ColumnVisibility::DetailOnly, true), 3);
        assert_eq!(compact_columns(ColumnVisibility::DoubleColumn, false), 1);
        assert_eq!(compact_columns(ColumnVisibility::DetailOnly, false), 2);
    }
}
