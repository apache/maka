//! A private process and PTY exercise the real parser while every frame queues another.

use std::{
    fs::{self, File},
    io::{self, IsTerminal, Write},
    os::{
        fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    process::{Command, Stdio},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use nsh_engine::{HostChannel, JsonValue};
use nsh_platform_tui::{AppOptions, AppView, Bundle, CacheOptions, Input, RunEvent, run_app};
use ratatui_core::{
    backend::{Backend, ClearType, TestBackend, WindowSize},
    buffer::Cell,
    layout::{Position, Size},
    terminal::Terminal,
};

const TIMEOUT: Duration = Duration::from_secs(5);

#[test]
fn continuous_frames_accept_terminal_focus_and_activation_keys() {
    let directory = std::env::temp_dir().join(format!("nsh-tui-input-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let log_path = directory.join("worker.log");
    let log = File::create(&log_path).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "terminal::input_tests::continuous_frames_worker",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log));
    // SAFETY: setsid is async-signal-safe and only detaches the child from the user's terminal.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut worker = command.spawn().unwrap();
    let deadline = Instant::now() + TIMEOUT * 3;
    let status = loop {
        if let Some(status) = worker.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            worker.kill().unwrap();
            break worker.wait().unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let log = fs::read_to_string(log_path).unwrap();
    fs::remove_dir_all(directory).unwrap();
    assert!(
        status.success() && log.contains("activated Photos through continuous frames"),
        "continuous-frame input worker: {status}\n{log}"
    );
}

struct UpdatingBackend {
    backend: TestBackend,
    host: HostChannel,
    wake: mpsc::Receiver<()>,
}

struct SavedStdio {
    input: OwnedFd,
    output: OwnedFd,
}

impl Drop for SavedStdio {
    fn drop(&mut self) {
        // SAFETY: restore the worker's original descriptors before libtest prints its result.
        unsafe {
            libc::dup2(self.input.as_raw_fd(), libc::STDIN_FILENO);
            libc::dup2(self.output.as_raw_fd(), libc::STDOUT_FILENO);
        }
    }
}

impl Backend for UpdatingBackend {
    type Error = io::Error;

    fn draw<'a, I>(&mut self, cells: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.backend.draw(cells).unwrap();
        Ok(())
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.backend.hide_cursor().unwrap();
        Ok(())
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.backend.show_cursor().unwrap();
        Ok(())
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.backend.get_cursor_position().unwrap())
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        self.backend.set_cursor_position(position).unwrap();
        Ok(())
    }
    fn clear(&mut self) -> io::Result<()> {
        self.backend.clear().unwrap();
        Ok(())
    }
    fn clear_region(&mut self, region: ClearType) -> io::Result<()> {
        self.backend.clear_region(region).unwrap();
        Ok(())
    }
    fn size(&self) -> io::Result<Size> {
        Ok(self.backend.size().unwrap())
    }
    fn window_size(&mut self) -> io::Result<WindowSize> {
        Ok(self.backend.window_size().unwrap())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.host.send("tick", JsonValue::Null).unwrap();
        // Queue actual engine work before returning from the completed terminal frame.
        // This pins the busy-frame interleaving without a timer or expensive painting.
        self.wake.recv_timeout(TIMEOUT).expect("next engine frame");
        Ok(())
    }
}

#[test]
#[ignore = "launched by continuous_frames_accept_terminal_focus_and_activation_keys on a private PTY"]
fn continuous_frames_worker() {
    assert!(!io::stdin().is_terminal());
    // SAFETY: read-only check that the parent detached this worker's session.
    assert_eq!(unsafe { libc::getsid(0) }, unsafe { libc::getpid() });
    let _stdio = SavedStdio {
        input: io::stdin().as_fd().try_clone_to_owned().unwrap(),
        output: io::stdout().as_fd().try_clone_to_owned().unwrap(),
    };
    let (mut master, mut slave) = (-1, -1);
    let mut size = libc::winsize {
        ws_row: 50,
        ws_col: 200,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: openpty initializes two owned descriptors; null selects default terminal settings.
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::addr_of_mut!(size),
            )
        },
        0
    );
    // SAFETY: these descriptors belong solely to this isolated worker. Stderr keeps the parent's log.
    unsafe {
        assert_eq!(libc::dup2(slave, libc::STDIN_FILENO), libc::STDIN_FILENO);
        assert_eq!(libc::dup2(slave, libc::STDOUT_FILENO), libc::STDOUT_FILENO);
        libc::close(slave);
    }
    // SAFETY: openpty returned this unique descriptor, now owned by File.
    let mut input = unsafe { File::from_raw_fd(master) };
    let _session = super::Session::enter(false).unwrap();
    let (wake, awakened) = mpsc::channel();
    let mut options = AppOptions::default();
    options.cache = CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = wake.send(());
    }));
    let mut view = AppView::new(options);
    view.on_error(|error| panic!("app error: {error}"));
    let host = view.host();
    let (reported, reports) = mpsc::channel();
    host.handle("focused", move |call| {
        reported
            .send(call.data().as_str().unwrap().to_owned())
            .unwrap();
    });
    let (pressed, presses) = mpsc::channel();
    host.handle("pressed", move |call| {
        pressed
            .send(call.data().as_str().unwrap().to_owned())
            .unwrap();
    });
    let code = nsh_bundler::compile_module(
        "Keys.tsx",
        r#"
        import { host, mount, signal, Text, View } from "nsh";
        const tick = signal(0);
        host.on("tick", () => tick.update(n => n + 1));
        function Button(props) {
            return <View onFocus={() => host.post("focused", props.label)}
                onPress={() => host.post("pressed", props.label)} style={{height: 32}}>
                <Text>{props.label}</Text>
            </View>;
        }
        mount(() => <View style={{flex: 1}}>
            <Button label="Theme"/><Button label="Stocks"/>
            <Button label="AI Chat"/><Button label="Photos"/>
            <Text>ready {tick()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let mut initial = Terminal::new(TestBackend::new(200, 50)).unwrap();
    view.draw_terminal(&mut initial).unwrap();
    view.load(
        Bundle::source(code)
            .with_capabilities_json(Some(r#"{"host": ["focused", "pressed"]}"#))
            .unwrap(),
    )
    .unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        view.draw_terminal(&mut initial).unwrap();
        let contents: String = initial
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        if contents.contains("ready 0") {
            break;
        }
        awakened
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("initial frame");
    }
    while awakened.try_recv().is_ok() {}
    let backend = UpdatingBackend {
        backend: TestBackend::new(200, 50),
        host,
        wake: awakened,
    };
    let mut terminal = Terminal::new(backend).unwrap();
    input.write_all(b"\x0e\x0e\x0e\x0e\r").unwrap();
    let mut received = 0;
    let mut polls = 0;
    let deadline = Instant::now() + TIMEOUT;
    run_app(&mut terminal, &mut view, |wait| {
        assert!(
            Instant::now() < deadline,
            "Photos was not activated: received {received}/5 keys in {polls} busy-frame polls; focus reports: {:?}", reports.try_iter().collect::<Vec<_>>()
        );
        assert!(
            wait.is_zero(),
            "a completed frame must already have pending engine work: {wait:?}"
        );
        polls += 1;
        if let Ok(label) = presses.try_recv() {
            assert_eq!(label, "Photos");
            return Ok(RunEvent::Exit);
        }
        let event = super::poll(wait)?;
        if let RunEvent::Input(Input::Key {
            key,
            modifiers,
            release,
        }) = &event
        {
            assert!(received < 5, "unexpected extra key: {event:?}");
            assert_eq!(key, if received < 4 { "n" } else { "Enter" });
            assert_eq!(modifiers.ctrl, received < 4);
            assert!(!release);
            received += 1;
        }
        Ok(event)
    })
    .unwrap();
    assert_eq!(received, 5);
    assert!(
        polls > received,
        "activation must arrive through the real engine"
    );
    assert_eq!(
        reports.try_iter().collect::<Vec<_>>(),
        ["Theme", "Stocks", "AI Chat", "Photos"]
    );
    eprintln!("activated Photos through continuous frames");
}
