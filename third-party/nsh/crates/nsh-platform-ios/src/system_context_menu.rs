//! `nsh/base`'s `ContextMenu` given `items`, on iOS: the system's context
//! menu (`UIContextMenuInteraction`), made from the mounted items and
//! answered natively; the trigger is what the system lifts, or the app's
//! preview when it has one. JS hears about it afterwards: `open`, then a
//! chosen action's `select` with the app's id (or `previewPress`), then
//! `close`.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::JsonValue;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_core_foundation::CGPoint;
use objc2_foundation::{NSArray, NSCopying, NSObject, NSObjectProtocol, NSString};
use objc2_ui_kit::{
    UIContextMenuConfiguration, UIContextMenuInteraction, UIContextMenuInteractionAnimating,
    UIContextMenuInteractionAppearance, UIContextMenuInteractionCommitAnimating,
    UIContextMenuInteractionCommitStyle, UIContextMenuInteractionDelegate, UIInteraction, UIMenu,
    UIMenuElement, UIPreviewParameters, UIResponder, UITargetedPreview, UIView, UIViewController,
    UIWindow,
};

use crate::{
    component::{ComponentContext, ComponentFactory, NativeComponent},
    system_menu_button::{Choose, Entry, elements, parse_items},
};

/// One opening of the menu. UIKit runs a chosen action's handler around
/// the dismissal, in no order it promises, so the choice waits here for the
/// dismissal and both are told together, the choice first.
#[derive(Default)]
struct Opening {
    /// The chosen action's id (or the preview pressed), not told yet.
    chosen: RefCell<Option<Choice>>,
    /// The dismissal was told: a choice now is told at once.
    ended: Cell<bool>,
}

/// What the user chose in the menu.
enum Choice {
    /// An action, by the app's id.
    Action(String),
    /// The app's preview.
    Preview,
}

impl Choice {
    fn tell(self, context: &ComponentContext) {
        match self {
            Choice::Action(id) => context.emit("select", JsonValue::from(id)),
            Choice::Preview => context.emit("previewPress", JsonValue::Null),
        }
    }
}

pub(crate) struct Ivars {
    entries: RefCell<Vec<Entry>>,
    title: RefCell<String>,
    disabled: Cell<bool>,
    /// The app gives a preview (`ContextMenu`'s `preview`).
    previews: Cell<bool>,
    /// The menu is up: from `willDisplay` to `willEnd`.
    shown: Cell<bool>,
    context: ComponentContext,
    /// The interaction and the view it is on.
    interaction: RefCell<Option<(Retained<UIContextMenuInteraction>, Weak<UIView>)>>,
    /// The trigger the current menu is about: its preview.
    trigger: RefCell<Option<Weak<UIView>>>,
    /// The opening the last configuration made, until its menu ends.
    opening: RefCell<Option<Rc<Opening>>>,
}

define_class!(
    /// A `ContextMenu`'s component view: no room, no touches, the delegate
    /// of the interaction it puts on the view around the trigger.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct NshContextMenu;

    impl NshContextMenu {
        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: calling the superclass implementation.
            let () = unsafe { msg_send![super(self), didMoveToWindow] };
            if self.window().is_some() {
                self.attach();
            }
        }

        // Leaving the window: the interaction leaves the view it is on, which
        // may stay (the component removed while the element around it
        // stays). Its superviews are still attached here.
        #[unsafe(method(willMoveToWindow:))]
        fn will_move_to_window(&self, window: Option<&UIWindow>) {
            if window.is_none() {
                self.detach();
            }
            // SAFETY: calling the superclass implementation.
            let () = unsafe { msg_send![super(self), willMoveToWindow: window] };
        }
    }

    unsafe impl NSObjectProtocol for NshContextMenu {}

    unsafe impl UIContextMenuInteractionDelegate for NshContextMenu {
        #[unsafe(method_id(contextMenuInteraction:configurationForMenuAtLocation:))]
        fn configuration_for_menu(
            &self,
            interaction: &UIContextMenuInteraction,
            location: CGPoint,
        ) -> Option<Retained<UIContextMenuConfiguration>> {
            self.configuration(interaction, location)
        }

        #[unsafe(method_id(contextMenuInteraction:configuration:highlightPreviewForItemWithIdentifier:))]
        fn highlight_preview(
            &self,
            _interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
            _identifier: &ProtocolObject<dyn NSCopying>,
        ) -> Option<Retained<UITargetedPreview>> {
            self.preview()
        }

        #[unsafe(method_id(contextMenuInteraction:configuration:dismissalPreviewForItemWithIdentifier:))]
        fn dismissal_preview(
            &self,
            _interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
            _identifier: &ProtocolObject<dyn NSCopying>,
        ) -> Option<Retained<UITargetedPreview>> {
            self.preview()
        }

        // Before iOS 16 the system asks for the previews without an item.
        #[unsafe(method_id(contextMenuInteraction:previewForHighlightingMenuWithConfiguration:))]
        fn highlighting_preview(
            &self,
            _interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
        ) -> Option<Retained<UITargetedPreview>> {
            self.preview()
        }

        #[unsafe(method_id(contextMenuInteraction:previewForDismissingMenuWithConfiguration:))]
        fn dismissing_preview(
            &self,
            _interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
        ) -> Option<Retained<UITargetedPreview>> {
            self.preview()
        }

        // The preview pressed: the menu goes (the app decides what the
        // press does), and the press is told with the dismissal, as a
        // chosen action is.
        #[unsafe(method(contextMenuInteraction:willPerformPreviewActionForMenuWithConfiguration:animator:))]
        fn will_perform_preview_action(
            &self,
            _interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
            animator: &ProtocolObject<dyn UIContextMenuInteractionCommitAnimating>,
        ) {
            animator.setPreferredCommitStyle(UIContextMenuInteractionCommitStyle::Dismiss);
            if let Some(opening) = self.ivars().opening.borrow().clone() {
                opening.choose(Choice::Preview, &self.ivars().context);
            }
        }

        #[unsafe(method(contextMenuInteraction:willDisplayMenuForConfiguration:animator:))]
        fn will_display(
            &self,
            interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
            _animator: Option<&ProtocolObject<dyn UIContextMenuInteractionAnimating>>,
        ) {
            let ivars = self.ivars();
            ivars.shown.set(true);
            // Rich: a held finger, the lifted preview; compact: the
            // secondary button's menu at the pointer.
            let by = if interaction.menuAppearance() == UIContextMenuInteractionAppearance::Compact
            {
                "pointer"
            } else {
                "touch"
            };
            ivars.context.emit("open", JsonValue::from(by));
        }

        #[unsafe(method(contextMenuInteraction:willEndForConfiguration:animator:))]
        fn will_end(
            &self,
            _interaction: &UIContextMenuInteraction,
            _configuration: &UIContextMenuConfiguration,
            animator: Option<&ProtocolObject<dyn UIContextMenuInteractionAnimating>>,
        ) {
            let ivars = self.ivars();
            ivars.shown.set(false);
            // Told once the menu went, a turn later, by when a chosen
            // action's handler has run: its `select` goes first, in the same
            // turn, so JS always hears the choice before the dismissal. A
            // handler running later still is told at once, after it.
            let (context, opening, mtm) = (ivars.context.clone(), ivars.opening.take(), self.mtm());
            let close = move || {
                let context = context.clone();
                let opening = MainThreadBound::new(opening.clone(), mtm);
                DispatchQueue::main().exec_async(move || {
                    let opening = opening.into_inner(MainThreadMarker::new().expect("main queue"));
                    if let Some(opening) = opening {
                        opening.ended.set(true);
                        if let Some(choice) = opening.chosen.take() {
                            choice.tell(&context);
                        }
                    }
                    context.emit("close", JsonValue::Null);
                });
            };
            match animator {
                Some(animator) => animator.addCompletion(&RcBlock::new(close)),
                None => close(),
            }
        }
    }
);

impl Opening {
    /// The user chose: told now when the dismissal was, else with it.
    fn choose(&self, choice: Choice, context: &ComponentContext) {
        if self.ended.get() {
            choice.tell(context);
        } else {
            self.chosen.replace(Some(choice));
        }
    }
}

impl NshContextMenu {
    fn new(mtm: MainThreadMarker, context: ComponentContext) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars {
            entries: RefCell::default(),
            title: RefCell::default(),
            disabled: Cell::new(false),
            previews: Cell::new(false),
            shown: Cell::new(false),
            context,
            interaction: RefCell::default(),
            trigger: RefCell::default(),
            opening: RefCell::default(),
        });
        // SAFETY: UIView's designated initializer.
        let this: Retained<Self> = unsafe { msg_send![super(this), init] };
        this.setUserInteractionEnabled(false);
        this
    }

    /// The view the interaction goes on: the one around the component's
    /// container and its preview (`ContextMenu`'s wrapper), which holds the
    /// trigger; and the wrapper.
    fn host(&self) -> Option<(Retained<UIView>, Retained<UIView>)> {
        let container = self.superview()?;
        let wrapper = container.superview()?;
        let host = wrapper.superview()?;
        Some((host, wrapper))
    }

    /// The app's preview, laid out out of sight beside the component's
    /// container: the holder's content.
    fn preview_view(&self) -> Option<Retained<UIView>> {
        let container = self.superview()?;
        let wrapper = container.superview()?;
        let holder = wrapper
            .subviews()
            .iter()
            .find(|view| !std::ptr::eq::<UIView>(&**view, &*container))?;
        let preview = holder.subviews().firstObject()?;
        let size = preview.bounds().size;
        (preview.window().is_some() && size.width >= 1.0 && size.height >= 1.0).then_some(preview)
    }

    /// Puts the interaction on the view around the trigger, moving it there
    /// from where it was.
    fn attach(&self) {
        let Some((host, _)) = self.host() else { return };
        let ivars = self.ivars();
        let on_host = ivars
            .interaction
            .borrow()
            .as_ref()
            .and_then(|(_, view)| view.load())
            .is_some_and(|view| std::ptr::eq::<UIView>(&*view, &*host));
        if on_host {
            return;
        }
        self.detach();
        let mtm = self.mtm();
        let interaction = UIContextMenuInteraction::initWithDelegate(
            UIContextMenuInteraction::alloc(mtm),
            ProtocolObject::from_ref(self),
        );
        // SAFETY: UIView's `addInteraction:` with a UIInteraction; the view
        // keeps it, the interaction keeps its delegate weakly.
        let () = unsafe { msg_send![&*host, addInteraction: &*interaction] };
        ivars
            .interaction
            .replace(Some((interaction, Weak::from_retained(&host))));
    }

    fn detach(&self) {
        if let Some((interaction, view)) = self.ivars().interaction.take()
            && let Some(view) = view.load()
        {
            // SAFETY: UIView's `removeInteraction:` with one it holds.
            let () = unsafe { msg_send![&*view, removeInteraction: &*interaction] };
        }
    }

    /// The menu about the trigger at `location` (in the interaction's view),
    /// none when the menu is disabled or empty or nothing is there.
    fn configuration(
        &self,
        interaction: &UIContextMenuInteraction,
        location: CGPoint,
    ) -> Option<Retained<UIContextMenuConfiguration>> {
        let ivars = self.ivars();
        if ivars.disabled.get() || ivars.entries.borrow().is_empty() {
            return None;
        }
        let host = interaction.view()?;
        let (_, wrapper) = self.host()?;
        let trigger = trigger_at(&host, &wrapper, location)?;
        ivars.trigger.replace(Some(Weak::from_retained(&trigger)));
        let mtm = self.mtm();
        let opening = Rc::new(Opening::default());
        ivars.opening.replace(Some(opening.clone()));
        let context = ivars.context.clone();
        let choose: Choose = Rc::new(move |id| opening.choose(Choice::Action(id), &context));
        let children = elements(&ivars.entries.borrow(), false, &choose, mtm);
        let menu = UIMenu::menuWithTitle_children(
            &NSString::from_str(&ivars.title.borrow()),
            &children,
            mtm,
        );
        // The menu is made now, from the items mounted beforehand; the
        // system's suggested elements are left out, as the app's menu is
        // all it shows.
        let provider = RcBlock::new(move |_: NonNull<NSArray<UIMenuElement>>| {
            Retained::as_ptr(&menu).cast_mut()
        });
        // The app's preview, asked for once the finger held long enough
        // (it is made when the finger went down): a picture of it, as it
        // is then. None (the trigger lifts) when it is not laid out yet.
        let this = Weak::from_retained(&self.retain());
        let content = ivars.previews.get().then(|| {
            RcBlock::new(move || -> *mut UIViewController {
                let picture = this
                    .load()
                    .and_then(|menu| menu.preview_view())
                    .and_then(|view| picture(&view, mtm));
                // A block returns its object autoreleased.
                picture.map_or(std::ptr::null_mut(), Retained::autorelease_return)
            })
        });
        // SAFETY: no identifier (the system makes one), a preview provider
        // block (or none: the trigger is the preview, `preview`) and an
        // action provider block, both copied by the configuration; the
        // menu the action provider returns is kept alive by its block, and
        // the system retains it.
        let configuration = unsafe {
            UIContextMenuConfiguration::configurationWithIdentifier_previewProvider_actionProvider(
                None,
                content
                    .as_ref()
                    .map_or(std::ptr::null_mut(), RcBlock::as_ptr),
                RcBlock::as_ptr(&provider),
                mtm,
            )
        };
        Some(configuration)
    }

    /// The trigger as the system lifts it: itself, clipped to its outline
    /// (each corner as drawn), on the system's platter behind what it
    /// leaves transparent.
    fn preview(&self) -> Option<Retained<UITargetedPreview>> {
        let trigger = self.ivars().trigger.borrow().as_ref()?.load()?;
        trigger.window()?;
        let mtm = self.mtm();
        let parameters = UIPreviewParameters::new(mtm);
        parameters.setVisiblePath(Some(&crate::decor::outline(&trigger)));
        Some(UITargetedPreview::initWithView_parameters(
            UITargetedPreview::alloc(mtm),
            &trigger,
            &parameters,
        ))
    }
}

/// A controller showing a picture of `view` at its size: what the system
/// lifts beside the menu.
fn picture(view: &UIView, mtm: MainThreadMarker) -> Option<Retained<UIViewController>> {
    let bounds = view.bounds();
    view.layoutIfNeeded();
    // SAFETY: UIGraphicsImageRenderer draws on this (main) thread; the
    // block runs inside `imageWithActions:`. UIImageView takes the image.
    let shown: Retained<UIView> = unsafe {
        let renderer_class = objc2::runtime::AnyClass::get(c"UIGraphicsImageRenderer")?;
        let renderer: Retained<objc2::runtime::AnyObject> =
            msg_send![msg_send![renderer_class, alloc], initWithBounds: bounds];
        let source = view.retain();
        let draw = RcBlock::new(move |_context: *mut objc2::runtime::AnyObject| {
            let _: bool =
                msg_send![&*source, drawViewHierarchyInRect: bounds, afterScreenUpdates: true];
        });
        let image: Option<Retained<objc2::runtime::AnyObject>> =
            msg_send![&*renderer, imageWithActions: &*draw];
        let image = image?;
        let image_view_class = objc2::runtime::AnyClass::get(c"UIImageView")?;
        msg_send![msg_send![image_view_class, alloc], initWithImage: &*image]
    };
    let controller = UIViewController::new(mtm);
    shown.setFrame(bounds);
    controller.setView(Some(&shown));
    controller.setPreferredContentSize(bounds.size);
    Some(controller)
}

/// The trigger at `location` in `host`: its topmost subview there, other
/// than the component's wrapper.
fn trigger_at(host: &UIView, wrapper: &UIView, location: CGPoint) -> Option<Retained<UIView>> {
    let views: Vec<Retained<UIView>> = host.subviews().iter().collect();
    views.into_iter().rev().find(|view| {
        !std::ptr::eq::<UIView>(&**view, wrapper)
            && !view.isHidden()
            && contains(view.frame(), location)
    })
}

fn contains(frame: objc2_core_foundation::CGRect, p: CGPoint) -> bool {
    p.x >= frame.origin.x
        && p.y >= frame.origin.y
        && p.x < frame.origin.x + frame.size.width
        && p.y < frame.origin.y + frame.size.height
}

struct SystemContextMenu {
    view: Retained<NshContextMenu>,
}

impl NativeComponent for SystemContextMenu {
    fn view(&self) -> &UIView {
        &self.view
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        let ivars = self.view.ivars();
        match name {
            // A menu shown keeps the items it opened with; new ones are the
            // next opening's.
            "items" => {
                ivars.entries.replace(parse_items(
                    value.and_then(JsonValue::as_array).map_or(&[], |v| v),
                ));
            }
            "title" => {
                ivars.title.replace(
                    value
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                );
            }
            "preview" => {
                ivars
                    .previews
                    .set(value.and_then(JsonValue::as_bool).unwrap_or(false));
            }
            "disabled" => {
                ivars
                    .disabled
                    .set(value.and_then(JsonValue::as_bool).unwrap_or(false));
            }
            // The app closing it; the system has no way to open one.
            "open" => {
                if value.and_then(JsonValue::as_bool) == Some(false)
                    && ivars.shown.get()
                    && let Some((interaction, _)) = &*ivars.interaction.borrow()
                {
                    interaction.dismissMenu();
                }
            }
            _ => {}
        }
    }
}

/// Makes the component of each `ContextMenu` given `items`
/// (`nsh_core::platform::CONTEXT_MENU_COMPONENT`), which every surface has
/// (`Components::default`).
pub(crate) fn factory() -> ComponentFactory {
    Rc::new(|context: ComponentContext| {
        let mtm = MainThreadMarker::new().expect("the context menu is made on the main thread");
        Box::new(SystemContextMenu {
            view: NshContextMenu::new(mtm, context),
        }) as Box<dyn NativeComponent>
    })
}

#[cfg(test)]
mod tests {
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};

    use super::contains;

    #[test]
    fn a_frame_holds_its_start_but_not_its_end() {
        let frame = CGRect::new(CGPoint::new(10.0, 20.0), CGSize::new(100.0, 40.0));
        assert!(contains(frame, CGPoint::new(10.0, 20.0)));
        assert!(contains(frame, CGPoint::new(109.0, 59.0)));
        assert!(!contains(frame, CGPoint::new(110.0, 30.0)));
        assert!(!contains(frame, CGPoint::new(50.0, 19.0)));
    }
}
