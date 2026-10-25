//! Opt-in native Windows regression checks. Run one case per process on an interactive desktop.
//! Select `GPUI_NATIVE_CASE=paint_race`, `input_restore`, or `recovery`, and
//! `GPUI_NATIVE_DCOMP=1` or `0`. Recovery additionally requires explicit reset opt-in.

use gpui::{
    App, AppContext, Application, AsyncApp, Bounds, Context, InteractiveElement, IntoElement,
    ParentElement, QuitMode, Render, Styled, Window, WindowBounds, WindowHandle, WindowOptions,
    div, point, px, rgb, size,
};
use std::{
    collections::BTreeMap,
    rc::Rc,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use windows::Win32::{
    Foundation::{HWND, POINT},
    Graphics::Gdi::{ClientToScreen, GetUpdateRect},
    UI::{
        Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
            MOUSEEVENTF_MOVE_NOCOALESCE, MOUSEINPUT, SendInput,
        },
        WindowsAndMessaging::{
            GetCursorPos, GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, SetCursorPos,
        },
    },
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static PHASE: AtomicUsize = AtomicUsize::new(0);
static PAUSE_RECOVERY: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);
static STATE: OnceLock<parking_lot::Mutex<Trace>> = OnceLock::new();
static PAINT_TARGET: AtomicUsize = AtomicUsize::new(0);
static PAINT_PHASE: AtomicUsize = AtomicUsize::new(0);
static PAINT_RETAINED: AtomicBool = AtomicBool::new(false);

pub(crate) fn paint_done(hwnd: HWND) {
    paint_finished(hwnd);
    paint_returned(hwnd);
}

fn paint_returned(hwnd: HWND) {
    if PAINT_TARGET.load(Ordering::SeqCst) == hwnd.0 as usize
        && PAINT_PHASE.load(Ordering::SeqCst) == 4
    {
        let retained = unsafe { GetUpdateRect(hwnd, None, false) }.as_bool();
        PAINT_RETAINED.store(retained, Ordering::SeqCst);
        mark(&format!("next paint update region retained: {retained}"));
        PAINT_PHASE.store(5, Ordering::SeqCst);
    }
}

pub(crate) fn paint_started(hwnd: HWND) {
    if PAINT_TARGET.load(Ordering::SeqCst) == hwnd.0 as usize {
        let _ = PAINT_PHASE.compare_exchange(1, 2, Ordering::SeqCst, Ordering::SeqCst);
    }
}
pub(crate) fn paint_invalidated(hwnd: HWND) {
    if PAINT_TARGET.load(Ordering::SeqCst) == hwnd.0 as usize
        && PAINT_PHASE
            .compare_exchange(3, 4, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        let start = Instant::now();
        while PAINT_PHASE.load(Ordering::SeqCst) == 4 {
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "paint did not acknowledge invalidation"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
pub(crate) fn before_frame_request(hwnd: HWND) {
    if PAINT_TARGET.load(Ordering::SeqCst) != hwnd.0 as usize {
        return;
    }
    let start = Instant::now();
    while PAINT_PHASE.load(Ordering::SeqCst) == 2 {
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "paint did not finish its callbacks"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn paint_finished(hwnd: HWND) {
    if PAINT_TARGET.load(Ordering::SeqCst) != hwnd.0 as usize
        || PAINT_PHASE.load(Ordering::SeqCst) != 2
    {
        return;
    }
    // Let the real VSync worker consume the callback's next-frame request before
    // the old trailing ValidateRect would run. No synthetic input or redraw.
    PAINT_PHASE.store(3, Ordering::SeqCst);
    let start = Instant::now();
    while PAINT_PHASE.load(Ordering::SeqCst) == 3 {
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "worker did not invalidate during paint"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    // Observe the worker's actual Win32 update region before testing whether
    // paint completion preserves it; the worker cannot issue a rescuing redraw.
    assert!(
        unsafe { GetUpdateRect(hwnd, None, false) }.as_bool(),
        "worker invalidation has no update region"
    );
    mark("worker invalidation completed before current paint returned");
}

struct Trace {
    start: Instant,
    presents: BTreeMap<usize, Vec<(u64, i32, bool)>>,
    inputs: BTreeMap<usize, Vec<u64>>,
    recovered: Vec<usize>,
    device_errors: Vec<i32>,
    checkpoints: Vec<String>,
}
fn state() -> &'static parking_lot::Mutex<Trace> {
    STATE.get_or_init(|| {
        parking_lot::Mutex::new(Trace {
            start: Instant::now(),
            presents: BTreeMap::new(),
            inputs: BTreeMap::new(),
            recovered: Vec::new(),
            device_errors: Vec::new(),
            checkpoints: Vec::new(),
        })
    })
}
pub(crate) fn present(hwnd: HWND, direct_composition: bool, status: i32) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let mut trace = state().lock();
    let at = trace.start.elapsed().as_micros() as u64;
    trace
        .presents
        .entry(hwnd.0 as usize)
        .or_default()
        .push((at, status, direct_composition));
}
pub(crate) fn input(hwnd: usize) {
    if !ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    let mut trace = state().lock();
    let at = trace.start.elapsed().as_micros() as u64;
    trace.inputs.entry(hwnd).or_default().push(at);
}
pub(crate) fn recovered() {
    if ACTIVE.load(Ordering::Relaxed) {
        let mut trace = state().lock();
        let at = trace.start.elapsed().as_micros() as usize;
        trace.recovered.push(at);
    }
}
pub(crate) fn recovery_started() {
    if ACTIVE.load(Ordering::Relaxed) {
        PHASE.store(1, Ordering::SeqCst);
        mark("device recovery started");
    }
}
pub(crate) fn device_removed(status: i32) {
    if ACTIVE.load(Ordering::Relaxed) {
        state().lock().device_errors.push(status);
        mark(&format!("GetDeviceRemovedReason=0x{:08X}", status as u32));
    }
}
pub(crate) fn recovery_locked() {
    if ACTIVE.load(Ordering::Relaxed) && PAUSE_RECOVERY.swap(false, Ordering::SeqCst) {
        PHASE.store(2, Ordering::SeqCst);
        mark("recovery window-list read lock acquired; allowing UI lifecycle overlap");
        std::thread::sleep(Duration::from_millis(350));
    }
}
pub(crate) fn recovery_finished() {
    if ACTIVE.load(Ordering::Relaxed) {
        PHASE.store(3, Ordering::SeqCst);
        mark("device recovery finished");
    }
}
fn dump() {
    let trace = state().lock();
    let value = serde_json::json!({"presents_us_status_dcomp":trace.presents,"inputs_us":trace.inputs,"renderer_recovery_times_us":trace.recovered,"device_errors":trace.device_errors,"checkpoints":trace.checkpoints,"phase":PHASE.load(Ordering::SeqCst)});
    if let Some(path) = std::env::var_os("GPUI_NATIVE_TEST_LOG") {
        std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
}
fn mark(message: &str) {
    println!("NATIVE: {message}");
    state().lock().checkpoints.push(message.to_owned());
    dump();
}
fn successes(hwnd: usize) -> Vec<u64> {
    state()
        .lock()
        .presents
        .get(&hwnd)
        .into_iter()
        .flatten()
        .filter(|(_, status, _)| *status == 0)
        .map(|(at, _, _)| *at)
        .collect()
}
fn native(window: &Window) -> usize {
    match raw_window_handle::HasWindowHandle::window_handle(window)
        .unwrap()
        .as_raw()
    {
        raw_window_handle::RawWindowHandle::Win32(handle) => handle.hwnd.get() as usize,
        _ => unreachable!(),
    }
}
struct View {
    renders: Arc<AtomicUsize>,
    value: bool,
}
impl Render for View {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders.fetch_add(1, Ordering::SeqCst);
        div()
            .size_full()
            .on_mouse_move(cx.listener(|view, _, _, cx| {
                view.value = !view.value;
                cx.notify();
            }))
            .bg(rgb(if self.value { 0x286e42 } else { 0x243654 }))
            .child("Native frame lifecycle regression")
    }
}
fn open(cx: &mut App, index: usize) -> (WindowHandle<View>, Arc<AtomicUsize>) {
    let renders = Arc::new(AtomicUsize::new(0));
    let copy = renders.clone();
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    point(px(100. + index as f32 * 450.), px(100.)),
                    size(px(420.), px(320.)),
                ))),
                ..Default::default()
            },
            |_, cx| {
                cx.new(|_| View {
                    renders: copy,
                    value: false,
                })
            },
        )
        .unwrap();
    (window, renders)
}
async fn pause(cx: &AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}
fn chain(window: &Window, completed: Arc<AtomicUsize>, left: usize) {
    window.on_next_frame(move |window, _| {
        completed.fetch_add(1, Ordering::SeqCst);
        if left > 1 {
            chain(window, completed, left - 1);
        }
    });
}

#[allow(
    clippy::disallowed_methods,
    reason = "The reset tool blocks only a dedicated native-test OS thread."
)]
fn force_gpu_reset() {
    std::thread::spawn(|| {
        assert!(
            std::process::Command::new("DXCap.exe")
                .arg("-forcetdr")
                .status()
                .unwrap()
                .success()
        );
    });
}

#[test]
#[ignore = "interactive desktop; GPUI_NATIVE_CASE=recovery also requires GPUI_TEST_ALLOW_GPU_RESET=1"]
fn interactive_frame_lifecycle() {
    let case = std::env::var("GPUI_NATIVE_CASE").unwrap_or_else(|_| "input_restore".into());
    assert!(matches!(
        case.as_str(),
        "input_restore" | "paint_race" | "recovery"
    ));
    let recovery = case == "recovery";
    if recovery {
        assert_eq!(
            std::env::var("GPUI_TEST_ALLOW_GPU_RESET").as_deref(),
            Ok("1")
        );
    }
    let disabled = std::env::var("GPUI_NATIVE_DCOMP").as_deref() == Ok("0");
    unsafe {
        if disabled {
            std::env::set_var("GPUI_DISABLE_DIRECT_COMPOSITION", "true");
        } else {
            std::env::remove_var("GPUI_DISABLE_DIRECT_COMPOSITION");
        }
    }
    ACTIVE.store(true, Ordering::SeqCst);
    mark(&format!(
        "pid={} case={} DirectComposition={}",
        std::process::id(),
        case,
        !disabled
    ));
    std::thread::spawn(|| {
        let start = Instant::now();
        let mut locked_at = None;
        while !DONE.load(Ordering::SeqCst) {
            if PHASE.load(Ordering::SeqCst) == 2 && locked_at.is_none() {
                locked_at = Some(Instant::now());
            }
            if locked_at.is_some_and(|at| at.elapsed() > Duration::from_secs(8))
                || start.elapsed() > Duration::from_secs(110)
            {
                mark("FAIL watchdog: no progress; terminating only this test process");
                std::process::exit(90);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    Application::with_platform(Rc::new(crate::WindowsPlatform::new(false).unwrap())).run(move |cx| {
        cx.set_quit_mode(QuitMode::Explicit);
        let (first, first_renders) = open(cx, 0);
        let (second, second_renders) = open(cx, 1);
        cx.spawn(async move |cx| {
            let a = first.update(cx, |_, window, _| { window.activate_window(); native(window) }).unwrap();
            let b = second.update(cx, |_, window, _| native(window)).unwrap();
            pause(cx, 3000).await;
            assert!(!successes(a).is_empty() && !successes(b).is_empty());
            {
                let trace = state().lock();
                for hwnd in [a, b] {
                    assert!(trace.presents[&hwnd].iter().any(|(_, status, dcomp)| *status == 0 && *dcomp == !disabled));
                }
            }
            mark("initial DXGI Present S_OK and actual DirectComposition state verified");
            if std::env::var("GPUI_NATIVE_CASE").as_deref() == Ok("paint_race") {
                let callbacks = Arc::new(AtomicUsize::new(0));
                PAINT_TARGET.store(a, Ordering::SeqCst);
                PAINT_PHASE.store(1, Ordering::SeqCst);
                first.update(cx, |_, window, _| chain(window, callbacks.clone(), 12)).unwrap();
                pause(cx, 2000).await;
                let completed = callbacks.load(Ordering::SeqCst);
                mark(&format!("paint race: phase={}, callbacks={completed}/12", PAINT_PHASE.load(Ordering::SeqCst)));
                if PAINT_PHASE.load(Ordering::SeqCst) == 5 && PAINT_RETAINED.load(Ordering::SeqCst) && completed == 12 {
                    DONE.store(true, Ordering::SeqCst);
                }
                cx.update(|cx| cx.quit());
                return;
            }
            if !recovery {
                let producer = std::thread::spawn(move || unsafe {
                    let mut original = POINT::default();
                    GetCursorPos(&mut original).unwrap();
                    let mut point = POINT { x: 100, y: 100 };
                    ClientToScreen(HWND(a as _), &mut point).ok().unwrap();
                    let width = GetSystemMetrics(SM_CXSCREEN) - 1;
                    let height = GetSystemMetrics(SM_CYSCREEN) - 1;
                    for index in 0..240 {
                        let event = INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT {
                            dx: (point.x + index % 2) * 65535 / width,
                            dy: point.y * 65535 / height,
                            dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE_NOCOALESCE,
                            ..Default::default()
                        } } };
                        assert_eq!(SendInput(&[event], std::mem::size_of::<INPUT>() as i32), 1);
                        std::thread::sleep(Duration::from_millis(4));
                    }
                    (original.x, original.y)
                });
                pause(cx, 2600).await;
                let original = producer.join().unwrap();
                let (last_input, input_count) = { let trace = state().lock(); let input = &trace.inputs[&a]; (*input.last().unwrap(), input.len()) };
                let presents = successes(a);
                let tail: Vec<_> = presents.into_iter().filter(|at| *at >= last_input + 100_000 && *at <= last_input + 850_000).collect();
                mark(&format!("high-rate input: {input_count} events; {} successful DXGI presents in 100–850 ms tail; view renders={}", tail.len(), first_renders.load(Ordering::SeqCst)));
    let mut intervals = vec![last_input + 100_000];
    intervals.extend(tail.iter().copied());
    intervals.push(last_input + 850_000);
    let maximum_gap = intervals
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .max()
        .unwrap();
    mark(&format!(
        "presentation tail maximum gap including interval edges: {maximum_gap} us"
    ));
                unsafe { SetCursorPos(original.0, original.1).unwrap(); }
                assert!(input_count >= 100);
                if tail.len() < 10 || tail.last().is_none_or(|at| *at < last_input + 750_000) || maximum_gap > 150_000 {
                    mark("FAIL: presentation sustain stopped or stalled after high-rate input");
                    cx.update(|cx| cx.quit());
                    return;
                }
                pause(cx, 600).await;
                let before = successes(a).len();
                pause(cx, 400).await;
                assert_eq!(successes(a).len(), before, "presentation did not return to idle");
                mark("presentation tail maintained, then parked");
            }
            second.update(cx, |_, window, _| window.minimize_window()).unwrap();
            pause(cx, 300).await;
            second.update(cx, |view, _, cx| { view.value = true; cx.notify(); }).unwrap();
            if recovery && std::env::var("GPUI_NATIVE_CHURN").as_deref() == Ok("0") {
                force_gpu_reset();
                for _ in 0..4500 {
                    if PHASE.load(Ordering::SeqCst) == 3 { break; }
                    pause(cx, 20).await;
                }
                assert_eq!(PHASE.load(Ordering::SeqCst), 3);
                assert!(!state().lock().device_errors.is_empty());
                assert!(state().lock().recovered.len() >= 2);
                mark("real device reset recovered both renderers while second window remained minimized");
            }
            if recovery && std::env::var("GPUI_NATIVE_CHURN").as_deref() != Ok("0") {
                let (transient, _) = cx.update(|cx| open(cx, 2));
                PAUSE_RECOVERY.store(true, Ordering::SeqCst);
                force_gpu_reset();
                for _ in 0..4500 {
                    if PHASE.load(Ordering::SeqCst) == 2 { break; }
                    pause(cx, 20).await;
                }
                assert_eq!(PHASE.load(Ordering::SeqCst), 2);
                mark("UI closing one window and opening another during GPU recovery dispatch");
                transient.update(cx, |_, window, _| window.remove_window()).unwrap();
                let (replacement, _) = cx.update(|cx| open(cx, 2));
                for _ in 0..250 {
                    if PHASE.load(Ordering::SeqCst) == 3 { break; }
                    pause(cx, 20).await;
                }
                assert_eq!(PHASE.load(Ordering::SeqCst), 3);
                replacement.update(cx, |view, _, cx| { view.value = true; cx.notify(); }).unwrap();
                pause(cx, 300).await;
                let c = replacement.update(cx, |_, window, _| native(window)).unwrap();
                assert!(!successes(c).is_empty());
                replacement.update(cx, |_, window, _| window.remove_window()).unwrap();
                mark("GPU recovery and overlapping window churn completed");
            }
            let before = successes(b).len();
            let before_renders = second_renders.load(Ordering::SeqCst);
            second.update(cx, |_, window, _| window.activate_window()).unwrap();
            pause(cx, 500).await;
            assert!(successes(b).len() > before, "restore did not present without an extra notify");
            assert!(second_renders.load(Ordering::SeqCst) > before_renders, "restore did not rebuild the changed view");
            let latest = *successes(b).last().unwrap();
            assert!(state().lock().presents[&b].iter().any(|(at,status,dcomp)| *at == latest && *status == 0 && *dcomp == !disabled));
            let before = successes(b).len();
            second.update(cx, |view, _, cx| { view.value = false; cx.notify(); }).unwrap();
            pause(cx, 200).await;
            assert!(successes(b).len() > before, "no successful present after restore");
            mark("minimize / restore resumed DXGI presentation");
            let callbacks = Arc::new(AtomicUsize::new(0));
            for handle in [first, second] {
                let callbacks = callbacks.clone();
                handle.update(cx, |_, window, _| chain(window, callbacks, 60)).unwrap();
            }
            pause(cx, 3000).await;
            assert_eq!(callbacks.load(Ordering::SeqCst), 120);
            second.update(cx, |_, window, _| window.remove_window()).unwrap();
            let before = successes(a).len();
            first.update(cx, |view, _, cx| { view.value = true; cx.notify(); }).unwrap();
            pause(cx, 300).await;
            assert!(successes(a).len() > before);
            mark("PASS: survivor presents after other window closes; 120 chained callbacks");
            DONE.store(true, Ordering::SeqCst);
            cx.update(|cx| cx.quit());
        }).detach();
    });
    assert!(
        DONE.load(Ordering::SeqCst),
        "native regression did not complete"
    );
    ACTIVE.store(false, Ordering::SeqCst);
}
