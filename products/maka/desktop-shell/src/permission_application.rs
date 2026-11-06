/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! The permission application's trusted-path icon and file drag source.

use nsh_engine::JsonValue;
use nsh_platform_macos::{
    ComponentContext, Components, NativeComponent,
    objc2::{
        AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::Retained, runtime::ProtocolObject,
    },
    objc2_app_kit::{
        NSCompositingOperation, NSDragOperation, NSDraggingContext, NSDraggingItem,
        NSDraggingSession, NSDraggingSource, NSEvent, NSImage, NSResponder, NSView, NSWorkspace,
    },
    objc2_foundation::{
        NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
    },
};
use std::{
    cell::Cell,
    path::Path,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// The caller supplies a verified Host application or an explicit local preview
/// argument. Neither component props nor JS commands may choose this path.
pub(crate) fn register(
    components: &Components,
    mtm: MainThreadMarker,
    application: &Path,
    alive: Arc<AtomicBool>,
) -> Result<(), String> {
    let path = application
        .to_str()
        .ok_or("the permission application's path is not valid UTF-8")?;
    let path = NSString::from_str(path);
    let icon = NSWorkspace::sharedWorkspace().iconForFile(&path);
    let url = NSURL::fileURLWithPath(&path);
    components.register(
        "maka.permissionApplication",
        Rc::new(move |ctx| {
            ctx.set_size(96.0, 96.0);
            Box::new(ApplicationComponent(ApplicationIcon::new(
                mtm,
                icon.clone(),
                url.clone(),
                alive.clone(),
                ctx,
            )))
        }),
    );
    Ok(())
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum DragPhase {
    #[default]
    Idle,
    Armed,
    Active,
}

#[derive(Default)]
struct DragGesture {
    phase: Cell<DragPhase>,
}

impl DragGesture {
    fn press(&self) {
        if self.phase.get() == DragPhase::Idle {
            self.phase.set(DragPhase::Armed);
        }
    }

    fn begin(&self) -> bool {
        if self.phase.get() != DragPhase::Armed {
            return false;
        }
        // AppKit owns the session. Claim this gesture before calling into it:
        // its tracking loop may deliver more events before the call returns.
        self.phase.set(DragPhase::Active);
        true
    }

    fn release(&self) {
        if self.phase.get() == DragPhase::Armed {
            self.phase.set(DragPhase::Idle);
        }
    }

    fn end(&self) {
        self.phase.set(DragPhase::Idle);
    }
}

struct IconState {
    icon: Retained<NSImage>,
    url: Retained<NSURL>,
    alive: Arc<AtomicBool>,
    gesture: DragGesture,
    context: ComponentContext,
}

define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MakaPermissionApplicationIcon"]
    #[ivars = IconState]
    struct ApplicationIcon;
    unsafe impl NSObjectProtocol for ApplicationIcon {}
    unsafe impl NSDraggingSource for ApplicationIcon {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn drag_operations(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
            if self.ivars().alive.load(Ordering::Acquire) { NSDragOperation::Copy } else { NSDragOperation::None }
        }
        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn drag_ended(&self, _session: &NSDraggingSession, _point: NSPoint, _operation: NSDragOperation) {
            self.ivars().gesture.end();
        }
    }
    impl ApplicationIcon {
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) {
            self.ivars().icon.drawInRect_fromRect_operation_fraction(
                self.icon_rect(), NSRect::ZERO, NSCompositingOperation::SourceOver, 1.0);
        }
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool { false }
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            self.ivars().alive.load(Ordering::Acquire)
        }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            if self.ivars().alive.load(Ordering::Acquire) { self.ivars().gesture.press(); }
        }
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) { self.ivars().gesture.release(); }
        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) {
            if !self.ivars().alive.load(Ordering::Acquire) || !self.ivars().gesture.begin() { return; }
            let writer = ProtocolObject::from_ref(&*self.ivars().url);
            let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), writer);
            // SAFETY: contents is an NSImage, one of AppKit's supported drag images.
            unsafe { item.setDraggingFrame_contents(self.icon_rect(), Some(&self.ivars().icon)); }
            let items = NSArray::from_retained_slice(&[item]);
            let source: &ProtocolObject<dyn NSDraggingSource> = ProtocolObject::from_ref(self);
            // SAFETY: NSView's selector with a live event and initialized items/source.
            // AppKit has returned nil on this boundary in practice, despite the
            // SDK's nonnull annotation; do not use its panicking generated binding.
            let session: Option<Retained<NSDraggingSession>> = unsafe {
                msg_send![self, beginDraggingSessionWithItems: &*items, event: event, source: source]
            };
            if session.is_none() {
                self.ivars().gesture.end();
                let message = "AppKit did not begin the application-file drag (returned no NSDraggingSession)";
                eprintln!("maka-desktop-shell: {message}");
                self.ivars().context.emit("dragError", serde_json::json!({"message": message}));
            } else {
                self.ivars().context.emit("dragStart", JsonValue::Null);
            }
        }
    }
);

impl ApplicationIcon {
    fn new(
        mtm: MainThreadMarker,
        icon: Retained<NSImage>,
        url: Retained<NSURL>,
        alive: Arc<AtomicBool>,
        context: ComponentContext,
    ) -> Retained<Self> {
        let allocated = Self::alloc(mtm).set_ivars(IconState {
            icon,
            url,
            alive,
            context,
            gesture: DragGesture::default(),
        });
        // SAFETY: NSView's designated initializer, with all subclass ivars initialized.
        let view: Retained<Self> =
            unsafe { msg_send![super(allocated), initWithFrame: NSRect::ZERO] };
        view
    }
    fn icon_rect(&self) -> NSRect {
        let bounds = self.bounds();
        let side = bounds.size.width.min(bounds.size.height).min(96.0);
        NSRect::new(
            NSPoint::new(
                (bounds.size.width - side) / 2.0,
                (bounds.size.height - side) / 2.0,
            ),
            NSSize::new(side, side),
        )
    }
}

struct ApplicationComponent(Retained<ApplicationIcon>);

impl NativeComponent for ApplicationComponent {
    fn view(&self) -> Retained<NSView> {
        Retained::into_super(self.0.clone())
    }
    fn set_prop(&mut self, _name: &str, _value: Option<&JsonValue>) {}
}

#[cfg(test)]
mod tests {
    use super::DragGesture;

    #[test]
    fn a_gesture_starts_only_one_session_even_with_reentrant_mouse_events() {
        let gesture = DragGesture::default();
        assert!(!gesture.begin());
        gesture.press();
        assert!(gesture.begin());
        assert!(!gesture.begin());
        gesture.press();
        gesture.release();
        assert!(!gesture.begin());
        gesture.end();
        assert!(!gesture.begin());
        gesture.press();
        assert!(gesture.begin());
    }

    #[test]
    fn click_cancel_or_failed_start_cannot_replay_but_a_new_gesture_can_drag() {
        let gesture = DragGesture::default();
        gesture.press();
        gesture.release();
        assert!(!gesture.begin());
        gesture.press();
        assert!(gesture.begin());
        // Both the native session-ended callback and a nil start end the gesture.
        gesture.end();
        assert!(!gesture.begin());
        gesture.press();
        assert!(gesture.begin());
    }
}
