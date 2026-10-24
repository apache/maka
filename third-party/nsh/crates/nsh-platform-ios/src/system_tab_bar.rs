//! `nsh/mobile`'s `TabBar` on iOS: a `UITabBar` with the system appearance.
//! The app places it and decides what each tab shows; the component reports
//! its intrinsic height while its container owns its frame.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::JsonValue;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
    runtime::ProtocolObject, sel,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString};
use objc2_ui_kit::{UIImage, UIResponder, UITabBar, UITabBarDelegate, UITabBarItem, UIView};

use crate::component::{ComponentContext, ComponentFactory, NativeComponent};

/// What the delegate and the bar share: the items to show and which is
/// selected, for the bar to lay them out again when it gets its width.
struct BarIvars {
    items: Rc<RefCell<Vec<Retained<UITabBarItem>>>>,
    selected: Cell<usize>,
    /// The width the items were last laid out at: an element is made before
    /// the layout that sizes it, so the first `setItems:` lands at width 0
    /// and draws nothing until the bar is laid out again.
    width: Cell<f64>,
    height: Cell<f64>,
    context: ComponentContext,
}

define_class!(
    /// A `UITabBar` that shows its items once it has a width to lay them out
    /// in.
    #[unsafe(super(UITabBar, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = BarIvars]
    struct NshTabBar;

    impl NshTabBar {
        /// Shows the items, once the bar has a width (a turn after the
        /// layout that gave it one).
        #[unsafe(method(nshShowItems))]
        fn nsh_show_items(&self) {
            show(self, &self.ivars().items.borrow(), self.ivars().selected.get());
        }

        /// A bar makes its item views once it is in a window: the items set
        /// before that draw nothing.
        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: forwarding UIView's callback to its superclass on the main thread.
            let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
            show(self, &self.ivars().items.borrow(), self.ivars().selected.get());
        }

        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // UIKit can give the bar its natural height before the host is
            // sized. Flexible-height autoresizing then adds the host's height
            // to that initial size; fill the host exactly instead.
            if let Some(host) = self.superview() {
                let frame = host.bounds();
                if self.frame() != frame {
                    self.setFrame(frame);
                }
            }
            // SAFETY: the superclass' own layout.
            let _: () = unsafe { msg_send![super(self), layoutSubviews] };
            let width = self.bounds().size.width;
            let height = self.sizeThatFits(CGSize::new(width, f64::INFINITY)).height;
            if height != self.ivars().height.replace(height) {
                self.ivars().context.set_size(0.0, height as f32);
            }
            if width < 1.0 || width == self.ivars().width.get() {
                return;
            }
            self.ivars().width.set(width);
            // Items laid out while the bar had no width keep no labels: give
            // them up and set them again for the width it has now.
            self.setItems(None);
            // After the layout pass: items set inside it are not laid out.
            // SAFETY: this zero-argument selector is defined on this class above.
            // NSObject retains the receiver until the main run loop invokes it.
            let _: () = unsafe {
                msg_send![
                    self,
                    performSelector: sel!(nshShowItems),
                    withObject: std::ptr::null::<NSObject>(),
                    afterDelay: 0.0f64
                ]
            };
        }
    }
);

impl NshTabBar {
    fn new(
        mtm: MainThreadMarker,
        items: Rc<RefCell<Vec<Retained<UITabBarItem>>>>,
        context: ComponentContext,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BarIvars {
            items,
            selected: Cell::new(0),
            width: Cell::new(0.0),
            height: Cell::new(0.0),
            context,
        });
        // SAFETY: `UITabBar`'s initializer is `UIView`'s `initWithFrame:`;
        // a bar made with `init` has no item views. The element's layout
        // sets the frame again.
        let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(0.0, 0.0));
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

/// One tab as the app gave it (`TabBarItem`: `{ title, icon }`).
#[derive(Debug, Default, PartialEq)]
struct Tab {
    title: String,
    /// An SF Symbol's name, empty for none.
    icon: String,
}

/// The tabs of an `items` prop; what is not a `{ title, icon }` object is a
/// tab without a title.
fn parse_items(items: &[JsonValue]) -> Vec<Tab> {
    let text = |item: &JsonValue, key: &str| {
        item.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    items
        .iter()
        .map(|item| Tab {
            title: text(item, "title"),
            icon: text(item, "icon"),
        })
        .collect()
}

/// Shows `items` on `bar`, with `selected` chosen.
fn show(bar: &UITabBar, items: &[Retained<UITabBarItem>], selected: usize) {
    if items.is_empty() {
        // An empty list empties the bar: the items it holds belong to a list
        // that is gone, and a bar left holding them keeps them showing and
        // tappable.
        let none = NSArray::new();
        bar.setItems(Some(&none));
        bar.setSelectedItem(None);
        return;
    }
    let array = NSArray::from_retained_slice(items);
    bar.setItems(Some(&array));
    bar.setNeedsLayout();
    // An index past the tabs selects none.
    bar.setSelectedItem(items.get(selected).map(|item| &**item));
}

struct DelegateIvars {
    context: ComponentContext,
}

define_class!(
    /// Reports the tab the user chose, by its index (the item's tag).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    struct TabDelegate;

    unsafe impl NSObjectProtocol for TabDelegate {}

    unsafe impl UITabBarDelegate for TabDelegate {
        #[unsafe(method(tabBar:didSelectItem:))]
        fn did_select(&self, _bar: &UITabBar, item: &UITabBarItem) {
            self.ivars()
                .context
                // The index itself: `onChange(index)`.
                .emit("change", serde_json::json!(item.tag() as u32));
        }
    }
);

impl TabDelegate {
    fn new(mtm: MainThreadMarker, context: ComponentContext) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars { context });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// The tab bar of one `TabBar` element.
pub(crate) struct SystemTabBar {
    bar: Retained<NshTabBar>,
    /// The tabs, as the app gave them.
    tabs: Vec<Tab>,
    items: Rc<RefCell<Vec<Retained<UITabBarItem>>>>,
    mtm: MainThreadMarker,
    _delegate: Retained<TabDelegate>,
}

impl SystemTabBar {
    /// Makes the items from the tabs the app gave and shows them, with the
    /// current selection.
    fn rebuild(&mut self) {
        let items: Vec<_> = self
            .tabs
            .iter()
            .enumerate()
            .map(|(index, tab)| {
                let image = (!tab.icon.is_empty())
                    .then(|| UIImage::systemImageNamed(&NSString::from_str(&tab.icon)))
                    .flatten();
                UITabBarItem::initWithTitle_image_tag(
                    UITabBarItem::alloc(self.mtm),
                    Some(&NSString::from_str(&tab.title)),
                    image.as_deref(),
                    index as isize,
                )
            })
            .collect();
        *self.items.borrow_mut() = items;
        let items = self.items.borrow();
        show(&self.bar, &items, self.bar.ivars().selected.get());
        drop(items);
    }
}

impl NativeComponent for SystemTabBar {
    fn view(&self) -> &UIView {
        &self.bar
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        // `TabBar`'s own props arrive as `$items` and `$selectedIndex`.
        match (name.strip_prefix('$').unwrap_or(name), value) {
            ("items", value) => {
                let items = value.and_then(JsonValue::as_array);
                self.tabs = items.map(|items| parse_items(items)).unwrap_or_default();
                self.rebuild();
            }
            ("selectedIndex", value) => {
                // Removed (or not a whole number): the first tab, the default.
                let selected = value.and_then(JsonValue::as_u64).unwrap_or(0) as usize;
                self.bar.ivars().selected.set(selected);
                let items = self.items.borrow();
                // Only the selection: the items and their layout stay.
                self.bar
                    .setSelectedItem(items.get(selected).map(|item| &**item));
            }
            _ => {}
        }
    }
}

/// Makes the bar of each `TabBar` element (`nsh_core::platform::TAB_BAR_COMPONENT`),
/// which every surface has (`Components::default`).
pub(crate) fn factory() -> ComponentFactory {
    Rc::new(|context: ComponentContext| {
        let mtm = MainThreadMarker::new().expect("the tab bar is made on the main thread");
        let items = Rc::new(RefCell::new(Vec::new()));
        let bar = NshTabBar::new(mtm, items.clone(), context.clone());
        let delegate = TabDelegate::new(mtm, context.clone());
        bar.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        Box::new(SystemTabBar {
            bar,
            tabs: Vec::new(),
            items,
            mtm,
            _delegate: delegate,
        }) as Box<dyn NativeComponent>
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Tab, parse_items};

    /// Each tab carries its own title and icon; a tab without an icon has
    /// none.
    #[test]
    fn tabs_carry_their_titles_and_icons() {
        let tabs = parse_items(&[
            json!({ "title": "Records", "icon": "list.bullet" }),
            json!({ "title": "Stats" }),
        ]);
        assert_eq!(
            tabs,
            [
                Tab {
                    title: "Records".into(),
                    icon: "list.bullet".into(),
                },
                Tab {
                    title: "Stats".into(),
                    icon: String::new(),
                },
            ]
        );
    }
}
