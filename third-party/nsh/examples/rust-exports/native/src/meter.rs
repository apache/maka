//! `rust-exports.meter`, a native component of the crate: a bar filled to
//! its `value` (a fraction, 0 to 1), the platform's own progress bar on
//! macOS and Linux and drawn with Direct2D on Windows. `lib.rs` registers it
//! with `#[native_components]`, so the hosts nsh builds for the app (`nsh
//! run`, `nsh test --target`, `nsh package`) show it; `App.tsx` declares it
//! with `nativeComponent`.

use std::rc::Rc;

use nsh_core::JsonValue;

/// The name `App.tsx` declares the component with.
const NAME: &str = "rust-exports.meter";

/// The fraction a `value` prop sets: 0 when removed or not a number.
fn fraction(value: Option<&JsonValue>) -> f64 {
    value
        .and_then(JsonValue::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0)
}

#[cfg(windows)]
pub(crate) fn register(components: &nsh_platform_windows::Components) {
    use nsh_platform_windows::{
        ComponentContext, NativeComponent,
        windows::Win32::Graphics::Direct2D::{
            Common::{D2D_RECT_F, D2D1_COLOR_F},
            ID2D1DeviceContext,
        },
    };

    struct Meter {
        value: f64,
        context: ComponentContext,
    }

    impl NativeComponent for Meter {
        fn draw(&self, dc: &ID2D1DeviceContext, (width, height): (f32, f32)) {
            let track = D2D1_COLOR_F {
                r: 0.82,
                g: 0.84,
                b: 0.86,
                a: 1.0,
            };
            let fill = D2D1_COLOR_F {
                r: 0.15,
                g: 0.39,
                b: 0.92,
                a: 1.0,
            };
            let filled = width * self.value as f32;
            // SAFETY: Direct2D calls on the context nsh draws the view with,
            // during its draw.
            unsafe {
                for (color, right) in [(track, width), (fill, filled)] {
                    if let Ok(brush) = dc.CreateSolidColorBrush(&color, None) {
                        let rect = D2D_RECT_F {
                            left: 0.0,
                            top: 0.0,
                            right,
                            bottom: height,
                        };
                        dc.FillRectangle(&rect, &brush);
                    }
                }
            }
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            if name == "value" {
                self.value = fraction(value);
                self.context.redraw();
            }
        }
    }

    components.register(
        NAME,
        Rc::new(|context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(Meter {
                value: 0.0,
                context,
            })
        }),
    );
}

#[cfg(target_os = "macos")]
pub(crate) fn register(components: &nsh_platform_macos::Components) {
    use nsh_platform_macos::{
        ComponentContext, NativeComponent,
        objc2::{MainThreadMarker, rc::Retained},
        objc2_app_kit::{NSProgressIndicator, NSView},
    };

    struct Meter(Retained<NSProgressIndicator>);

    impl NativeComponent for Meter {
        fn view(&self) -> Retained<NSView> {
            Retained::into_super(self.0.clone())
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            if name == "value" {
                self.0.setDoubleValue(fraction(value));
            }
        }
    }

    components.register(
        NAME,
        Rc::new(|_context: ComponentContext| -> Box<dyn NativeComponent> {
            let mtm = MainThreadMarker::new().expect("views are made on the main thread");
            let bar = NSProgressIndicator::new(mtm);
            bar.setIndeterminate(false);
            bar.setMinValue(0.0);
            bar.setMaxValue(1.0);
            Box::new(Meter(bar))
        }),
    );
}

#[cfg(target_os = "linux")]
pub(crate) fn register(components: &nsh_platform_linux::Components) {
    use nsh_platform_linux::{
        ComponentContext, NativeComponent,
        gtk4::{self as gtk, prelude::*},
    };

    struct Meter(gtk::ProgressBar);

    impl NativeComponent for Meter {
        fn widget(&self) -> gtk::Widget {
            self.0.clone().upcast()
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            if name == "value" {
                self.0.set_fraction(fraction(value));
            }
        }
    }

    components.register(
        NAME,
        Rc::new(|_context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(Meter(gtk::ProgressBar::new()))
        }),
    );
}
