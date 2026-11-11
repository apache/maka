//! What `nsh/test`'s `App` drives: an app on a headless engine
//! ([`Headless`]), or on a real platform's host (`nsh test --target`),
//! whose test agent takes the same steps ([`crate::agent`]) through the
//! dev server ([`Host`]).

use std::time::Duration;

use nsh_core::{
    Dialog, ResolvedTextStyle,
    geometry::{Point, Points, Size},
    platform::{ColorScheme, Lifecycle},
};
use nsh_dev::protocol::{ClockChange, TestStep};
use serde_json::Value;

use crate::{
    headless::{DialogAnswer, Headless},
    module::LocaleSettingsOptions,
};

/// An app a test opened, driven by steps and read by queries.
pub(crate) trait Driver: Send {
    /// Names the step the batches that come next belong to (`--trace`).
    fn step(&mut self, name: &str);
    fn press(&mut self, selector: &str) -> Result<(), String>;
    fn long_press(&mut self, selector: &str) -> Result<(), String>;
    fn type_text(&mut self, selector: &str, text: &str) -> Result<(), String>;
    fn submit(&mut self, selector: &str) -> Result<(), String>;
    fn clear(&mut self, selector: &str) -> Result<(), String>;
    fn scroll(&mut self, selector: &str, distance: Points) -> Result<(), String>;
    fn drag(&mut self, selector: &str, by: Point<Points>) -> Result<(), String>;
    /// Drops local files (`file:` URLs) on what `selector` names.
    fn drop_files(&mut self, selector: &str, uris: Vec<String>) -> Result<(), String> {
        let _ = (selector, uris);
        Err("`dropFiles` runs headless and on Linux for now".into())
    }
    /// Drags without lifting, until [`Driver::drop_held`].
    fn drag_and_hold(&mut self, selector: &str, by: Point<Points>) -> Result<(), String> {
        let _ = (selector, by);
        Err("`dragAndHold` runs headless and on Linux for now".into())
    }
    /// Lifts the finger `drag_and_hold` left down.
    fn drop_held(&mut self) -> Result<(), String> {
        Err("`drop` runs headless and on Linux for now".into())
    }
    fn press_key(&mut self, keys: &str) -> Result<(), String>;
    /// Holds (`down`) or lets go of modifier keys for the pointer's steps.
    fn hold_keys(&mut self, keys: &str, down: bool) -> Result<(), String> {
        let _ = (keys, down);
        Err("holding keys (`keyboard.down` / `keyboard.up`) runs headless only for now: run the test without `--target`".into())
    }
    fn hover(&mut self, selector: &str) -> Result<(), String>;
    fn right_click(&mut self, selector: &str) -> Result<(), String>;
    /// Pastes `content` into the input `selector` names, as the user's
    /// paste does with it on the clipboard.
    fn paste(&mut self, selector: &str, content: &nsh_core::PasteEvent) -> Result<(), String>;
    fn choose_menu_item(&mut self, label: &str) -> Result<(), String>;
    fn close_menu(&mut self) -> Result<(), String>;
    fn back(&mut self) -> Result<(), String>;
    /// Goes forward in the browser's history (`app.forward`): the web's
    /// alone.
    fn forward(&mut self) -> Result<(), String> {
        Err(crate::failure::web_only("forward"))
    }
    fn wait(&mut self, time: Duration) -> Result<(), String>;
    fn wait_for_within(&mut self, selector: &str, timeout: Duration) -> Result<(), String>;
    fn wait_for_gone(&mut self, selector: &str, timeout: Duration) -> Result<(), String>;
    fn next_change(&mut self, timeout: Duration) -> Result<(), String>;
    /// What `waitUntil` waits for between looks on a manual clock: moves it
    /// by a display frame (`timeout` at most) and applies what came; how
    /// far it moved (zero on the system's clock, where it is
    /// [`Driver::next_change`]).
    fn next_frame(&mut self, timeout: Duration) -> Result<Duration, String>;
    fn set_viewport(&mut self, size: Size<Points>) -> Result<(), String>;
    fn set_color_scheme(&mut self, scheme: ColorScheme) -> Result<(), String>;
    /// Whether the app is in use, as the system reports it (`lifecycle()`).
    fn set_lifecycle(&mut self, state: Lifecycle) -> Result<(), String> {
        let _ = state;
        Err(headless_only("setLifecycle"))
    }
    /// The user's locale settings that `settings` names, as the system
    /// reports them (`localeSettings()`).
    fn set_locale_settings(&mut self, settings: LocaleSettingsOptions) -> Result<(), String> {
        let _ = settings;
        Err(headless_only("setLocaleSettings"))
    }
    /// The system hands the app a link that opens it (`openWithUrl`).
    fn open_with_url(&mut self, url: &str) -> Result<(), String> {
        let _ = url;
        Err(headless_only("openWithUrl"))
    }
    fn run_for(&mut self, time: Duration) -> Result<(), String>;
    fn fast_forward(&mut self, time: Duration) -> Result<(), String>;
    fn set_system_time(&mut self, at: std::time::SystemTime) -> Result<(), String>;
    /// The oldest dialog not answered yet.
    fn pending_dialog(&mut self) -> Option<Dialog>;
    fn answer_dialog(&mut self, answer: DialogAnswer) -> Result<(), String>;
    /// The oldest pick (`Picker.pickImages`, `Picker.pickFiles`) not answered yet; a real
    /// platform shows its picker and has none to answer.
    fn pending_pick(&mut self) -> Option<nsh_core::picker::Pick> {
        None
    }
    /// Answers the oldest pick with `files`.
    fn answer_pick(&mut self, files: Vec<nsh_core::picker::PickedFile>) -> Result<(), String> {
        drop(files);
        Err(headless_only("answering a pick"))
    }
    /// The picks the app asked for, in order.
    fn picks(&mut self) -> Result<Vec<nsh_core::picker::Pick>, String> {
        Err(headless_only("`picks()`"))
    }
    /// What the app's speech sessions asked for, in order.
    fn speech_requests(&mut self) -> Result<Vec<nsh_core::speech::SpeechRequest>, String> {
        Err(headless_only("`speechRequests()`"))
    }
    /// The user says `text` to the session listening.
    fn hear(&mut self, text: &str) -> Result<(), String> {
        let _ = text;
        Err(headless_only("speaking for the user"))
    }
    /// Ends the session listening, with `error` or as the user stops.
    fn end_speech(&mut self, error: Option<nsh_core::speech::SpeechError>) -> Result<(), String> {
        let _ = error;
        Err(headless_only("ending a speech session"))
    }
    /// What the app asked of the speaker, in order.
    fn audio_calls(&mut self) -> Result<Vec<crate::headless::AudioCall>, String> {
        Err(headless_only("`audio()`"))
    }
    /// The players playing reach their end.
    fn end_audio(&mut self) -> Result<(), String> {
        Err(headless_only("ending a player"))
    }
    fn texts(&mut self) -> Result<Vec<String>, String>;
    fn count(&mut self, selector: &str) -> Result<usize, String>;
    fn enabled(&mut self, selector: &str) -> Result<bool, String>;
    fn shows(&mut self, selector: &str) -> Result<bool, String>;
    fn value(&mut self, selector: &str) -> Result<Option<String>, String>;
    fn span_style(&mut self, selector: &str) -> Result<ResolvedTextStyle, String>;
    fn dialogs(&mut self) -> Result<Vec<Dialog>, String>;
    /// The open context menu's actions, `None` when none is open.
    fn menu(&mut self) -> Result<Option<Vec<crate::menu::Entry>>, String>;
    fn clipboard(&mut self) -> Result<Option<String>, String>;
    /// The embedding app sends event `name` with `data` to the app
    /// (`app.host.send`), which then settles.
    fn send_host_event(&mut self, name: &str, data: Value) -> Result<(), String>;
    /// The URLs the app opened, in order (`app.openedUrls`): recorded,
    /// never opened.
    fn opened_urls(&mut self) -> Result<Vec<String>, String>;
    /// A picture of the app: PNG bytes, or UTF-8 Cell JSON on the terminal target.
    fn screenshot(&mut self) -> Result<Vec<u8>, String>;
    /// The app's storage's entries, as a host keeps them (a headless
    /// engine's `App` reads its storage itself).
    fn storage(&mut self) -> Result<std::collections::BTreeMap<String, String>, String> {
        Err(headless_only("reading the storage this way"))
    }
    /// The state of the app's window `id` as the platform reports it;
    /// `None` while it is not open.
    fn window_state(&mut self, id: &str) -> Result<Option<nsh_core::desktop::WindowState>, String>;
    /// The user presses the close button of the app's window `id`.
    fn press_window_close(&mut self, id: &str) -> Result<(), String>;
    /// A picture of the app's window `id`, as [`Driver::screenshot`] is of
    /// the main window: PNG bytes of its content.
    fn window_screenshot(&mut self, id: &str) -> Result<Vec<u8>, String>;
}

impl Driver for Headless {
    fn step(&mut self, name: &str) {
        Headless::step(self, name);
    }
    fn press(&mut self, selector: &str) -> Result<(), String> {
        Headless::press(self, selector)
    }
    fn long_press(&mut self, selector: &str) -> Result<(), String> {
        Headless::long_press(self, selector)
    }
    fn type_text(&mut self, selector: &str, text: &str) -> Result<(), String> {
        Headless::type_text(self, selector, text)
    }
    fn submit(&mut self, selector: &str) -> Result<(), String> {
        Headless::submit(self, selector)
    }
    fn clear(&mut self, selector: &str) -> Result<(), String> {
        Headless::clear(self, selector)
    }
    fn scroll(&mut self, selector: &str, distance: Points) -> Result<(), String> {
        Headless::scroll(self, selector, distance)
    }
    fn drag(&mut self, selector: &str, by: Point<Points>) -> Result<(), String> {
        Headless::drag(self, selector, by)
    }
    fn hold_keys(&mut self, keys: &str, down: bool) -> Result<(), String> {
        Headless::hold_keys(self, keys, down)
    }
    fn drag_and_hold(&mut self, selector: &str, by: Point<Points>) -> Result<(), String> {
        Headless::drag_and_hold(self, selector, by)
    }
    fn drop_files(&mut self, selector: &str, uris: Vec<String>) -> Result<(), String> {
        Headless::drop_files(self, selector, uris)
    }
    fn drop_held(&mut self) -> Result<(), String> {
        Headless::drop_held(self)
    }
    fn press_key(&mut self, keys: &str) -> Result<(), String> {
        Headless::press_key(self, keys)
    }
    fn hover(&mut self, selector: &str) -> Result<(), String> {
        Headless::hover(self, selector)
    }
    fn right_click(&mut self, selector: &str) -> Result<(), String> {
        Headless::right_click(self, selector)
    }
    fn paste(&mut self, selector: &str, content: &nsh_core::PasteEvent) -> Result<(), String> {
        Headless::paste(self, selector, content)
    }
    fn choose_menu_item(&mut self, label: &str) -> Result<(), String> {
        Headless::choose_menu_item(self, label)
    }
    fn close_menu(&mut self) -> Result<(), String> {
        Headless::close_menu(self)
    }
    fn back(&mut self) -> Result<(), String> {
        Headless::back(self)
    }
    fn wait(&mut self, time: Duration) -> Result<(), String> {
        Headless::wait(self, time)
    }
    fn wait_for_within(&mut self, selector: &str, timeout: Duration) -> Result<(), String> {
        Headless::wait_for_within(self, selector, timeout)
    }
    fn wait_for_gone(&mut self, selector: &str, timeout: Duration) -> Result<(), String> {
        Headless::wait_for_gone(self, selector, timeout)
    }
    fn next_change(&mut self, timeout: Duration) -> Result<(), String> {
        Headless::next_change(self, timeout)
    }
    fn next_frame(&mut self, timeout: Duration) -> Result<Duration, String> {
        Headless::next_frame(self, timeout)
    }
    fn set_viewport(&mut self, size: Size<Points>) -> Result<(), String> {
        Headless::set_viewport(self, size)
    }
    fn set_color_scheme(&mut self, scheme: ColorScheme) -> Result<(), String> {
        let name = match scheme {
            ColorScheme::Dark => "dark",
            _ => "light",
        };
        self.set_environment(&format!("setColorScheme({name})"), |e| {
            e.color_scheme = scheme;
        })
    }
    fn set_lifecycle(&mut self, state: Lifecycle) -> Result<(), String> {
        self.set_environment(&format!("setLifecycle({})", state.name()), |e| {
            e.lifecycle = state;
        })
    }
    fn set_locale_settings(&mut self, settings: LocaleSettingsOptions) -> Result<(), String> {
        let pins = settings.pins("setLocaleSettings")?;
        let what = format!("setLocaleSettings({})", settings.label());
        self.set_environment(&what, |e| pins.apply(e))
    }
    fn open_with_url(&mut self, url: &str) -> Result<(), String> {
        Headless::open_with_url(self, url)
    }
    fn run_for(&mut self, time: Duration) -> Result<(), String> {
        Headless::run_for(self, time)
    }
    fn fast_forward(&mut self, time: Duration) -> Result<(), String> {
        Headless::fast_forward(self, time)
    }
    fn set_system_time(&mut self, at: std::time::SystemTime) -> Result<(), String> {
        Headless::set_system_time(self, at)
    }
    fn pending_dialog(&mut self) -> Option<Dialog> {
        Headless::pending_dialog(self).cloned()
    }
    fn answer_dialog(&mut self, answer: DialogAnswer) -> Result<(), String> {
        Headless::answer_dialog(self, answer)
    }
    fn pending_pick(&mut self) -> Option<nsh_core::picker::Pick> {
        Headless::pending_pick(self)
    }
    fn answer_pick(&mut self, files: Vec<nsh_core::picker::PickedFile>) -> Result<(), String> {
        Headless::answer_pick(self, files)
    }
    fn picks(&mut self) -> Result<Vec<nsh_core::picker::Pick>, String> {
        self.catch_up();
        Ok(Headless::picks(self))
    }
    fn speech_requests(&mut self) -> Result<Vec<nsh_core::speech::SpeechRequest>, String> {
        self.catch_up();
        Ok(Headless::speech_requests(self))
    }
    fn hear(&mut self, text: &str) -> Result<(), String> {
        Headless::hear(self, text)
    }
    fn end_speech(&mut self, error: Option<nsh_core::speech::SpeechError>) -> Result<(), String> {
        Headless::end_speech(self, error)
    }
    fn audio_calls(&mut self) -> Result<Vec<crate::headless::AudioCall>, String> {
        self.catch_up();
        Ok(Headless::audio_calls(self))
    }
    fn end_audio(&mut self) -> Result<(), String> {
        Headless::end_audio(self)
    }
    fn texts(&mut self) -> Result<Vec<String>, String> {
        self.catch_up();
        Ok(self
            .screen()
            .texts()
            .into_iter()
            .map(str::to_owned)
            .collect())
    }
    fn count(&mut self, selector: &str) -> Result<usize, String> {
        self.catch_up();
        self.screen().count(selector)
    }
    fn enabled(&mut self, selector: &str) -> Result<bool, String> {
        self.catch_up();
        self.screen().enabled(selector)
    }
    fn shows(&mut self, selector: &str) -> Result<bool, String> {
        self.catch_up();
        self.screen().matches(selector)
    }
    fn value(&mut self, selector: &str) -> Result<Option<String>, String> {
        self.catch_up();
        Ok(self.screen().input_text(selector)?.map(str::to_owned))
    }
    fn span_style(&mut self, selector: &str) -> Result<ResolvedTextStyle, String> {
        self.catch_up();
        self.screen().span_style(selector)
    }
    fn dialogs(&mut self) -> Result<Vec<Dialog>, String> {
        self.catch_up();
        Ok(self.screen().dialogs().to_vec())
    }
    fn menu(&mut self) -> Result<Option<Vec<crate::menu::Entry>>, String> {
        self.catch_up();
        Ok(Headless::menu(self))
    }
    fn clipboard(&mut self) -> Result<Option<String>, String> {
        self.catch_up();
        Ok(self.screen().clipboard().map(str::to_owned))
    }
    fn send_host_event(&mut self, name: &str, data: Value) -> Result<(), String> {
        Headless::send_host_event(self, name, data)
    }
    fn opened_urls(&mut self) -> Result<Vec<String>, String> {
        self.catch_up();
        Ok(self.screen().opened_urls().to_vec())
    }
    fn screenshot(&mut self) -> Result<Vec<u8>, String> {
        Err(
            "a screenshot needs a real platform, which draws the app: run the test with `--target`"
                .into(),
        )
    }
    fn window_state(&mut self, id: &str) -> Result<Option<nsh_core::desktop::WindowState>, String> {
        Headless::window_state(self, id)
    }
    fn press_window_close(&mut self, id: &str) -> Result<(), String> {
        Headless::press_window_close(self, id)
    }
    fn window_screenshot(&mut self, id: &str) -> Result<Vec<u8>, String> {
        if Headless::window_state(self, id)?.is_none() {
            return Err(format!("no window {id:?} is open"));
        }
        self.screenshot()
    }
}

/// A real platform's host running an app for a test (`nsh test --target`):
/// it takes [`TestStep`]s through its test agent. Dropping it closes the
/// app.
pub trait Host: Send {
    /// Asks the host's agent to take `step`, waiting `timeout` at most:
    /// what a query gives (`null` for actions), or why it failed.
    fn step(&self, step: TestStep, timeout: Duration) -> Result<Value, String>;
}

/// How long a step may take on a host before the test gives up on it: its
/// own waits (a `waitFor`'s timeout, a quiet app) plus room for the round
/// trip.
const STEP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a host may take to move the app's clock and settle.
const CLOCK_STEP_TIMEOUT: Duration = Duration::from_secs(90);
/// A display frame, which a wait moves a manual clock by between two looks
/// (the agent's frame).
const FRAME: Duration = Duration::from_millis(16);

/// An app on a real platform's host.
pub(crate) struct Remote {
    host: Box<dyn Host>,
    /// The step taken now, which a traced app's batches print under.
    step: std::sync::Arc<std::sync::Mutex<String>>,
    /// The app runs on a manual clock (`open`'s `clock`).
    manual_clock: bool,
}

impl Remote {
    pub(crate) fn new(
        host: Box<dyn Host>,
        step: std::sync::Arc<std::sync::Mutex<String>>,
        manual_clock: bool,
    ) -> Self {
        Remote {
            host,
            step,
            manual_clock,
        }
    }

    /// Takes `step` on the host; an action names what a traced app's
    /// batches print under, as headless runs name it.
    pub(crate) fn take(&self, step: TestStep) -> Result<Value, String> {
        if let Some(name) = step_name(&step) {
            *self.step.lock().unwrap_or_else(|e| e.into_inner()) = name;
        }
        let timeout = match &step {
            TestStep::Wait { ms } | TestStep::WaitFor { timeout_ms: ms, .. } => {
                STEP_TIMEOUT + Duration::from_millis(*ms)
            }
            // The timers due on the way run meanwhile.
            TestStep::Clock { .. } => CLOCK_STEP_TIMEOUT,
            _ => STEP_TIMEOUT,
        };
        self.host.step(step, timeout)
    }

    /// Moves the app's manual clock as `change` says; `what` names the
    /// step when the app has none.
    fn clock(&self, what: &str, change: ClockChange) -> Result<(), String> {
        if !self.manual_clock {
            return Err(format!(
                "clock.{what} needs a manual clock: open the app with one (`open(entry, {{ clock: {{}} }})`)"
            ));
        }
        self.action(TestStep::Clock { change })
    }

    fn action(&self, step: TestStep) -> Result<(), String> {
        self.take(step).map(drop)
    }

    fn query<T: serde::de::DeserializeOwned>(&self, step: TestStep) -> Result<T, String> {
        let value = self.take(step)?;
        serde_json::from_value(value).map_err(|e| format!("the host answered oddly: {e}"))
    }
}

/// The name `--trace` prints an action's batches under (as
/// [`Headless`]'s steps name theirs); `None` for a query.
fn step_name(step: &TestStep) -> Option<String> {
    Some(match step {
        TestStep::Press { selector } => format!("press({selector})"),
        TestStep::LongPress { selector } => format!("longPress({selector})"),
        TestStep::Type { selector, text } => format!("type({selector}, {text:?})"),
        TestStep::Submit { selector } => format!("submit({selector})"),
        TestStep::Clear { selector } => format!("clear({selector})"),
        TestStep::Scroll { selector, distance } => {
            format!("scroll({selector}, {})", Points(*distance))
        }
        TestStep::Drag { selector, x, y } => {
            format!("drag({selector}, {}, {})", Points(*x), Points(*y))
        }
        TestStep::PressKey { keys } => format!("keyboard.press({keys})"),
        TestStep::Hover { selector } => format!("hover({selector})"),
        TestStep::RightClick { selector } => format!("rightClick({selector})"),
        TestStep::Paste { selector, .. } => format!("paste({selector})"),
        TestStep::ChooseMenuItem { label } => format!("chooseMenuItem({label})"),
        TestStep::CloseMenu => "closeMenu".to_owned(),
        TestStep::HostSend { name, .. } => format!("host.send({name})"),
        TestStep::Back => "back".to_owned(),
        TestStep::Forward => "forward".to_owned(),
        TestStep::PressWindowClose { id } => format!("window({id}).pressClose"),
        TestStep::Wait { ms } => format!("wait({ms})"),
        TestStep::Clock {
            change: ClockChange::RunFor { ms },
        } => format!("clock.runFor({ms})"),
        TestStep::Clock {
            change: ClockChange::FastForward { ms },
        } => format!("clock.fastForward({ms})"),
        TestStep::WaitFor {
            selector,
            gone: false,
            ..
        } => format!("waitFor({selector})"),
        TestStep::WaitFor { selector, .. } => format!("waitFor({selector}, gone)"),
        TestStep::SetViewport { width, height } => {
            format!("setViewport({}, {})", Points(*width), Points(*height))
        }
        TestStep::SetColorScheme { dark } => {
            format!("setColorScheme({})", if *dark { "dark" } else { "light" })
        }
        _ => return None,
    })
}

/// What a test asks of a real platform that only headless runs do.
pub(crate) fn headless_only(what: &str) -> String {
    format!("{what} runs headless only for now: run the test without `--target`")
}

fn ms(time: Duration) -> u64 {
    time.as_millis().min(u128::from(u64::MAX)) as u64
}

impl Driver for Remote {
    fn step(&mut self, name: &str) {
        *self.step.lock().unwrap_or_else(|e| e.into_inner()) = name.to_owned();
    }
    fn press(&mut self, selector: &str) -> Result<(), String> {
        self.action(TestStep::Press {
            selector: selector.into(),
        })
    }
    fn long_press(&mut self, selector: &str) -> Result<(), String> {
        self.action(TestStep::LongPress {
            selector: selector.into(),
        })
    }
    fn type_text(&mut self, selector: &str, text: &str) -> Result<(), String> {
        self.action(TestStep::Type {
            selector: selector.into(),
            text: text.into(),
        })
    }
    fn submit(&mut self, selector: &str) -> Result<(), String> {
        self.action(TestStep::Submit {
            selector: selector.into(),
        })
    }
    fn clear(&mut self, selector: &str) -> Result<(), String> {
        self.action(TestStep::Clear {
            selector: selector.into(),
        })
    }
    fn scroll(&mut self, selector: &str, distance: Points) -> Result<(), String> {
        self.action(TestStep::Scroll {
            selector: selector.into(),
            distance: distance.0,
        })
    }
    fn drag(&mut self, selector: &str, by: Point<Points>) -> Result<(), String> {
        self.action(TestStep::Drag {
            selector: selector.into(),
            x: by.x.0,
            y: by.y.0,
        })
    }
    fn press_key(&mut self, keys: &str) -> Result<(), String> {
        self.action(TestStep::PressKey { keys: keys.into() })
    }
    fn drag_and_hold(&mut self, selector: &str, by: Point<Points>) -> Result<(), String> {
        self.action(TestStep::DragAndHold {
            selector: selector.into(),
            x: by.x.0,
            y: by.y.0,
        })
    }
    fn drop_held(&mut self) -> Result<(), String> {
        self.action(TestStep::Drop)
    }
    fn drop_files(&mut self, selector: &str, uris: Vec<String>) -> Result<(), String> {
        self.action(TestStep::DropFiles {
            selector: selector.into(),
            uris,
        })
    }
    fn hold_keys(&mut self, keys: &str, down: bool) -> Result<(), String> {
        self.action(TestStep::HoldKeys {
            keys: keys.into(),
            down,
        })
    }
    fn hover(&mut self, selector: &str) -> Result<(), String> {
        self.action(TestStep::Hover {
            selector: selector.into(),
        })
    }
    fn right_click(&mut self, selector: &str) -> Result<(), String> {
        self.action(TestStep::RightClick {
            selector: selector.into(),
        })
    }
    fn paste(&mut self, selector: &str, content: &nsh_core::PasteEvent) -> Result<(), String> {
        self.action(TestStep::Paste {
            selector: selector.into(),
            text: content.text.clone(),
            html: content.html.clone(),
            files: content
                .files
                .iter()
                .map(|f| nsh_dev::protocol::TestFile::new(&f.name, &f.mime, f.data.clone()))
                .collect(),
            uris: content.uris.clone(),
        })
    }
    fn choose_menu_item(&mut self, label: &str) -> Result<(), String> {
        self.action(TestStep::ChooseMenuItem {
            label: label.into(),
        })
    }
    fn close_menu(&mut self) -> Result<(), String> {
        self.action(TestStep::CloseMenu)
    }
    fn back(&mut self) -> Result<(), String> {
        self.action(TestStep::Back)
    }
    fn forward(&mut self) -> Result<(), String> {
        self.action(TestStep::Forward)
    }
    // On a manual clock the app's time passes too, as headless.
    fn wait(&mut self, time: Duration) -> Result<(), String> {
        self.action(TestStep::Wait { ms: ms(time) })?;
        if self.manual_clock {
            self.action(TestStep::Clock {
                change: ClockChange::RunFor { ms: ms(time) },
            })?;
        }
        Ok(())
    }
    fn wait_for_within(&mut self, selector: &str, timeout: Duration) -> Result<(), String> {
        self.action(TestStep::WaitFor {
            selector: selector.into(),
            timeout_ms: ms(timeout),
            gone: false,
        })
    }
    fn wait_for_gone(&mut self, selector: &str, timeout: Duration) -> Result<(), String> {
        self.action(TestStep::WaitFor {
            selector: selector.into(),
            timeout_ms: ms(timeout),
            gone: true,
        })
    }
    fn next_change(&mut self, timeout: Duration) -> Result<(), String> {
        self.action(TestStep::NextChange {
            timeout_ms: ms(timeout),
        })
    }
    fn next_frame(&mut self, timeout: Duration) -> Result<Duration, String> {
        if !self.manual_clock {
            return self.next_change(timeout).map(|()| Duration::ZERO);
        }
        // A whole millisecond at least: the wait's time runs out.
        let by = ms(timeout.min(FRAME)).max(1);
        self.action(TestStep::NextFrame { ms: by })?;
        Ok(Duration::from_millis(by))
    }
    fn set_viewport(&mut self, size: Size<Points>) -> Result<(), String> {
        self.action(TestStep::SetViewport {
            width: size.width.0,
            height: size.height.0,
        })
    }
    fn set_color_scheme(&mut self, scheme: ColorScheme) -> Result<(), String> {
        self.action(TestStep::SetColorScheme {
            dark: scheme == ColorScheme::Dark,
        })
    }
    fn run_for(&mut self, time: Duration) -> Result<(), String> {
        self.clock("runFor", ClockChange::RunFor { ms: ms(time) })
    }
    fn fast_forward(&mut self, time: Duration) -> Result<(), String> {
        self.clock("fastForward", ClockChange::FastForward { ms: ms(time) })
    }
    fn set_system_time(&mut self, at: std::time::SystemTime) -> Result<(), String> {
        let unix_ms = match at.duration_since(std::time::UNIX_EPOCH) {
            Ok(since) => since.as_secs_f64() * 1000.0,
            Err(before) => -before.duration().as_secs_f64() * 1000.0,
        };
        self.clock("setSystemTime", ClockChange::SetSystemTime { unix_ms })
    }
    fn pending_dialog(&mut self) -> Option<Dialog> {
        self.query(TestStep::PendingDialog).ok().flatten()
    }
    fn answer_dialog(&mut self, answer: DialogAnswer) -> Result<(), String> {
        let button = match answer {
            DialogAnswer::Press(text) => Some(text),
            DialogAnswer::Dismiss => None,
        };
        self.action(TestStep::AnswerDialog { button })
    }
    fn texts(&mut self) -> Result<Vec<String>, String> {
        self.query(TestStep::Texts)
    }
    fn count(&mut self, selector: &str) -> Result<usize, String> {
        self.query(TestStep::Count {
            selector: selector.into(),
        })
    }
    fn enabled(&mut self, selector: &str) -> Result<bool, String> {
        self.query(TestStep::Enabled {
            selector: selector.into(),
        })
    }
    fn shows(&mut self, selector: &str) -> Result<bool, String> {
        self.query(TestStep::Shows {
            selector: selector.into(),
        })
    }
    fn value(&mut self, selector: &str) -> Result<Option<String>, String> {
        self.query(TestStep::Value {
            selector: selector.into(),
        })
    }
    fn span_style(&mut self, selector: &str) -> Result<ResolvedTextStyle, String> {
        let span: nsh_dev::protocol::SpanStyle = self.query(TestStep::SpanStyle {
            selector: selector.into(),
        })?;
        Ok(ResolvedTextStyle {
            color: nsh_core::Color(span.color),
            font_size: nsh_core::Points(span.font_size),
            font_weight: span.font_weight,
            italic: span.italic,
            decoration: nsh_core::TextDecoration {
                underline: span.underline,
                line_through: span.line_through,
            },
            background: span.background.map(|color| nsh_core::TextBackground {
                color: nsh_core::Color(color),
                radius: nsh_core::Points::ZERO,
                node: 0,
            }),
            ..ResolvedTextStyle::default()
        })
    }
    fn dialogs(&mut self) -> Result<Vec<Dialog>, String> {
        self.query(TestStep::Dialogs)
    }
    fn menu(&mut self) -> Result<Option<Vec<crate::menu::Entry>>, String> {
        self.query(TestStep::Menu)
    }
    fn clipboard(&mut self) -> Result<Option<String>, String> {
        self.query(TestStep::Clipboard)
    }
    fn send_host_event(&mut self, name: &str, data: Value) -> Result<(), String> {
        self.action(TestStep::HostSend {
            name: name.into(),
            data,
        })
    }
    fn opened_urls(&mut self) -> Result<Vec<String>, String> {
        self.query(TestStep::OpenedUrls)
    }
    fn screenshot(&mut self) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        let png: String = self.query(TestStep::Screenshot)?;
        base64::engine::general_purpose::STANDARD
            .decode(png)
            .map_err(|e| format!("the host sent a broken picture: {e}"))
    }
    fn storage(&mut self) -> Result<std::collections::BTreeMap<String, String>, String> {
        self.query(TestStep::Scene {
            query: nsh_dev::protocol::SceneQuery::Storage,
        })
    }
    fn window_state(&mut self, id: &str) -> Result<Option<nsh_core::desktop::WindowState>, String> {
        let value = self.take(TestStep::WindowState { id: id.into() })?;
        crate::window_json::from_json(value)
    }
    fn press_window_close(&mut self, id: &str) -> Result<(), String> {
        self.action(TestStep::PressWindowClose { id: id.into() })
    }
    fn window_screenshot(&mut self, id: &str) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        let png: String = self.query(TestStep::WindowScreenshot { id: id.into() })?;
        base64::engine::general_purpose::STANDARD
            .decode(png)
            .map_err(|e| format!("the host sent a broken picture: {e}"))
    }
}

impl Drop for Remote {
    fn drop(&mut self) {
        // The host exits; dropping the host handle reaps it.
        let _ = self.host.step(TestStep::Quit, Duration::from_secs(5));
    }
}
