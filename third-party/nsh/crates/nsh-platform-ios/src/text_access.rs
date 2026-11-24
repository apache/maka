//! A text view's inline links and inline views for VoiceOver.
//!
//! A text view is one element that reads its text, until the text has a
//! pressable link or an inline view VoiceOver can reach. Then it is a
//! container (`accessibilityElements`), as UIKit's own text views are: each
//! link is an element with the link trait (VoiceOver's Links rotor moves
//! through them) that a double tap presses, the plain stretches between
//! links read as static text, and inline views keep their own elements, all
//! in document order ([`nsh_platform_apple::text_access`], which macOS shares).
//! A text the app named, gave a role or made pressable stays one element.
//!
//! Elements are made lazily, when VoiceOver asks, and resolve their part
//! through the view's current snapshot by a logical identity: one VoiceOver
//! focuses survives relayout and streamed text.

use std::{collections::HashMap, rc::Rc, sync::Arc};

use nsh_core::{AttributedText, EventKind, NodeId};
use nsh_platform_apple::text_access::{
    SpokenPart, has_pressable_links, reading_order, spoken_parts,
};
use objc2::{
    DefinedClass, MainThreadOnly, Message, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject},
};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect};
use objc2_foundation::NSArray;
use objc2_ui_kit::{
    UIAccessibilityConvertFrameToScreenCoordinates, UIAccessibilityElement,
    UIAccessibilityTraitLink, UIAccessibilityTraitNotEnabled, UIAccessibilityTraitStaticText,
    UIAccessibilityTraits, UIBezierPath, UIResponder, UIView,
};

use crate::{press::PressAt, text::CoreTextLayout, text_view::TextView};

/// Which part an element stands for: the link's span (or `None` for plain
/// text) and how many parts of that span came before it.
type Identity = (Option<NodeId>, usize);

/// The parts of one content of a text view, and their elements.
pub(crate) struct Snapshot {
    text: Arc<AttributedText>,
    parts: Vec<SpokenPart>,
    identities: HashMap<Identity, usize>,
    elements: Vec<Retained<SpanElement>>,
}

define_class!(
    /// A link or a plain stretch of a text view's text.
    #[unsafe(super(UIAccessibilityElement, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Identity]
    #[name = "NshTextSpanElement"]
    pub(crate) struct SpanElement;

    impl SpanElement {
        #[unsafe(method_id(accessibilityLabel))]
        fn label(&self) -> Option<Retained<objc2_foundation::NSString>> {
            self.resolve()
                .map(|(_, snapshot, index)| objc2_foundation::NSString::from_str(&snapshot.parts[index].label))
        }

        #[unsafe(method(accessibilityTraits))]
        fn traits(&self) -> UIAccessibilityTraits {
            let Some((view, snapshot, index)) = self.resolve() else {
                return 0;
            };
            // SAFETY: immutable UIKit constants.
            unsafe {
                if snapshot.parts[index].node.is_none() {
                    UIAccessibilityTraitStaticText
                } else if view.accessibility_disabled() {
                    UIAccessibilityTraitLink | UIAccessibilityTraitNotEnabled
                } else {
                    UIAccessibilityTraitLink
                }
            }
        }

        #[unsafe(method(accessibilityFrame))]
        fn frame(&self) -> CGRect {
            self.resolve()
                .and_then(|(view, snapshot, index)| {
                    let rects = view.part_rects(&snapshot.parts[index]);
                    let bounds = rects.into_iter().reduce(union)?;
                    Some(UIAccessibilityConvertFrameToScreenCoordinates(bounds, &view))
                })
                .unwrap_or(CGRect::ZERO)
        }

        /// A part that wraps outlines each of its lines.
        #[unsafe(method_id(accessibilityPath))]
        fn path(&self) -> Option<Retained<UIBezierPath>> {
            self.resolve().and_then(|(view, snapshot, index)| {
                let rects = view.part_rects(&snapshot.parts[index]);
                (rects.len() > 1).then(|| {
                    let path = UIBezierPath::bezierPath();
                    for rect in rects {
                        let screen = UIAccessibilityConvertFrameToScreenCoordinates(rect, &view);
                        path.appendPath(&UIBezierPath::bezierPathWithRect(screen));
                    }
                    path
                })
            })
        }

        /// The middle of its first line: on the text even when it wraps.
        #[unsafe(method(accessibilityActivationPoint))]
        fn activation_point(&self) -> CGPoint {
            self.resolve()
                .and_then(|(view, snapshot, index)| {
                    let first = *view.part_rects(&snapshot.parts[index]).first()?;
                    let screen = UIAccessibilityConvertFrameToScreenCoordinates(first, &view);
                    Some(middle(screen))
                })
                .unwrap_or(CGPoint::ZERO)
        }

        #[unsafe(method(accessibilityActivate))]
        fn activate(&self) -> bool {
            self.resolve().is_some_and(|(view, snapshot, index)| {
                let part = &snapshot.parts[index];
                part.node.is_some_and(|node| view.press_span(node, part))
            })
        }
    }
);

impl SpanElement {
    fn new(view: &TextView, identity: Identity) -> Retained<Self> {
        let this = Self::alloc(view.mtm()).set_ivars(identity);
        let container: &AnyObject = view.as_ref();
        // SAFETY: UIAccessibilityElement's designated initializer; the
        // container is the text view (held weakly).
        let this: Retained<Self> =
            unsafe { msg_send![super(this), initWithAccessibilityContainer: container] };
        this.setIsAccessibilityElement(true);
        this
    }

    /// Its text view, the view's current parts and its own among them.
    fn resolve(&self) -> Option<(Retained<TextView>, Rc<Snapshot>, usize)> {
        let view = self.accessibilityContainer()?.downcast::<TextView>().ok()?;
        let snapshot = view.access_snapshot()?;
        let index = *snapshot.identities.get(self.ivars())?;
        Some((view, snapshot, index))
    }
}

impl TextView {
    /// Whether VoiceOver reads this text in parts ([module docs](self)).
    pub(crate) fn reads_in_parts(&self) -> bool {
        if self.hidden_from_accessibility() || !self.reads_only_content() {
            return false;
        }
        let (links, attachments) = match self.ivars().text.borrow().as_ref() {
            Some(t) => (has_pressable_links(t), !t.attachments.is_empty()),
            None => return false,
        };
        links || (attachments && self.inline_views().next().is_some())
    }

    /// The parts of the text shown, made again when it changed (elements
    /// keep their identity across).
    pub(crate) fn access_snapshot(&self) -> Option<Rc<Snapshot>> {
        let text = self.ivars().text.borrow().clone()?;
        let mut kept = self.ivars().access.borrow_mut();
        if let Some(snapshot) = kept.as_ref()
            && Arc::ptr_eq(&snapshot.text, &text)
        {
            return Some(snapshot.clone());
        }
        let old = kept.take();
        let parts = spoken_parts(&text);
        let mut ordinals = HashMap::<Option<NodeId>, usize>::new();
        let mut identities = HashMap::with_capacity(parts.len());
        let elements = parts
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let ordinal = ordinals.entry(part.node).or_default();
                let identity = (part.node, *ordinal);
                *ordinal += 1;
                identities.insert(identity, index);
                old.as_ref()
                    .and_then(|old| Some(old.elements[*old.identities.get(&identity)?].clone()))
                    .unwrap_or_else(|| SpanElement::new(self, identity))
            })
            .collect();
        let snapshot = Rc::new(Snapshot {
            text,
            parts,
            identities,
            elements,
        });
        *kept = Some(snapshot.clone());
        Some(snapshot)
    }

    /// `accessibilityElements` while the text reads in parts: its parts and
    /// its inline views in document order.
    pub(crate) fn access_elements(&self) -> Option<Retained<NSArray>> {
        if !self.reads_in_parts() {
            return None;
        }
        let snapshot = self.access_snapshot()?;
        let parts: Vec<(u32, Retained<AnyObject>)> = snapshot
            .parts
            .iter()
            .zip(&snapshot.elements)
            .map(|(part, element)| (part.range.start, any(&**element)))
            .collect();
        let inline: Vec<(u32, Retained<AnyObject>)> = self
            .inline_views()
            .map(|view| (self.offset_at(middle(view.frame())), any(&*view)))
            .collect();
        Some(NSArray::from_retained_slice(&reading_order(parts, inline)))
    }

    /// The text's views (each of its attachments) that hold something
    /// VoiceOver reaches. UIKit's own subviews of the text (its selection's)
    /// have no node id as their tag.
    fn inline_views(&self) -> impl Iterator<Item = Retained<UIView>> {
        self.subviews()
            .into_iter()
            .filter(|view| view.tag() > 0 && reaches(view))
    }

    /// The caret offset nearest to `point` (view coordinates).
    fn offset_at(&self, point: CGPoint) -> u32 {
        let layout = self.ivars().layout.borrow();
        layout
            .as_ref()
            .and_then(|(layout, content)| {
                let text = layout.downcast::<CoreTextLayout>()?;
                Some(
                    text.position_at(CGPoint::new(
                        point.x - content.origin.x.0 as CGFloat,
                        point.y - content.origin.y.0 as CGFloat,
                    ))
                    .offset,
                )
            })
            .unwrap_or(u32::MAX)
    }

    /// The boxes of `part` on each line it covers (view coordinates).
    fn part_rects(&self, part: &SpokenPart) -> Vec<CGRect> {
        self.range_rects(part.range.start as usize, part.range.end as usize)
            .into_iter()
            .map(|(rect, ..)| rect)
            .filter(|rect| rect.size.width > 0.0)
            .collect()
    }

    /// Presses link `node` as a tap on it does: its press events, at the
    /// middle of its first line.
    fn press_span(&self, node: NodeId, part: &SpokenPart) -> bool {
        if self.accessibility_disabled() {
            return false;
        }
        let link = self.ivars().text.borrow().as_ref().and_then(|t| {
            t.links
                .iter()
                .find(|l| l.node == node && l.events.contains(EventKind::Press))
                .copied()
        });
        let (Some(link), Some(target)) = (link, self.keyboard_target()) else {
            return false;
        };
        let point = self
            .part_rects(part)
            .first()
            .map_or_else(|| middle(self.bounds()), |rect| middle(*rect));
        let at = PressAt {
            in_window: self.convertPoint_toView(point, None),
            modifiers: 0,
            clicks: 1,
        };
        for kind in [EventKind::PressDown, EventKind::PressUp, EventKind::Press] {
            target.link_event(&link, kind, self.id(), at);
        }
        true
    }
}

/// Whether `view` is or holds an element VoiceOver reaches.
fn reaches(view: &UIView) -> bool {
    // SAFETY: plain UIAccessibility getters of a view.
    let (hidden, element): (bool, bool) = unsafe {
        (
            msg_send![view, accessibilityElementsHidden],
            msg_send![view, isAccessibilityElement],
        )
    };
    if view.isHidden() || hidden {
        return false;
    }
    if element {
        return true;
    }
    // SAFETY: UIAccessibilityContainer's getter, nil for most views.
    let listed: Option<Retained<NSArray>> = unsafe { msg_send![view, accessibilityElements] };
    listed.is_some_and(|l| l.count() > 0) || view.subviews().iter().any(|v| reaches(&v))
}

fn any<T: Message + AsRef<AnyObject>>(object: &T) -> Retained<AnyObject> {
    let object: &AnyObject = object.as_ref();
    object.retain()
}

fn union(a: CGRect, b: CGRect) -> CGRect {
    let (left, top) = (a.origin.x.min(b.origin.x), a.origin.y.min(b.origin.y));
    let right = (a.origin.x + a.size.width).max(b.origin.x + b.size.width);
    let bottom = (a.origin.y + a.size.height).max(b.origin.y + b.size.height);
    CGRect::new(
        CGPoint::new(left, top),
        objc2_core_foundation::CGSize::new(right - left, bottom - top),
    )
}

fn middle(rect: CGRect) -> CGPoint {
    CGPoint::new(
        rect.origin.x + rect.size.width / 2.0,
        rect.origin.y + rect.size.height / 2.0,
    )
}
