//! Real host processes on private PTYs: no display, shell or user terminal is touched.

use std::{
    ffi::{CStr, OsStr},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt, process::CommandExt},
    },
    path::PathBuf,
    process::{Command, ExitStatus, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

mod supervise;
use supervise::ExpectedExit;

const DRAIN_READS: usize = 16;
const FILL_TIMEOUT: Duration = Duration::from_secs(1);
const EXIT_TIMEOUT: Duration = Duration::from_secs(1);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

struct Host {
    process: Arc<supervise::Process>,
    slave: File,
    original: libc::termios,
    directory: PathBuf,
}

impl Host {
    fn spawn(controlling: bool, fps: bool, terminal_input: bool) -> Self {
        Self::spawn_source(
            controlling,
            fps,
            terminal_input,
            "import { mount, Text } from 'nsh'; mount(() => <Text>PTY-ready</Text>);",
            &[],
        )
    }

    fn spawn_source(
        controlling: bool,
        fps: bool,
        terminal_input: bool,
        source: &str,
        assets: &[(&str, &[u8])],
    ) -> Self {
        let directory = supervise::fixture();
        for (name, bytes) in assets {
            let path = directory.join("assets").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        let code = nsh_bundler::compile_module("Idle.tsx", source, &[]).unwrap();
        fs::write(directory.join("bundle.js"), code).unwrap();
        let (mut master, mut slave) = (-1, -1);
        let mut size = libc::winsize {
            ws_row: 24,
            ws_col: 100,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: output descriptors and the winsize are valid; null requests the default name and termios.
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
        // SAFETY: openpty returned two unique, owned descriptors.
        let (master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
        for file in [&master, &slave] {
            // SAFETY: the owned descriptor is valid. Keep the parent's PTY handles out of exec.
            assert_eq!(
                unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
                0
            );
        }
        // SAFETY: fcntl only reads/updates flags of this test's master descriptor.
        unsafe {
            let flags = libc::fcntl(master.as_raw_fd(), libc::F_GETFL);
            assert!(flags >= 0);
            assert_eq!(
                libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK),
                0
            );
        }
        // The probe has its own open file description: the host restoring stdout flags
        // cannot turn the test's fill writes into blocking writes.
        let mut name = [0 as libc::c_char; 512];
        // SAFETY: the live slave fd and the caller-owned name buffer are valid.
        assert_eq!(
            unsafe { libc::ttyname_r(slave.as_raw_fd(), name.as_mut_ptr(), name.len()) },
            0
        );
        // SAFETY: ttyname_r succeeded and terminated the name within the buffer.
        let name = unsafe { CStr::from_ptr(name.as_ptr()) };
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
            .open(OsStr::from_bytes(name.to_bytes()))
            .unwrap();
        let original = termios(&probe);
        let mut command = Command::new(env!("CARGO_BIN_EXE_nsh-tui-host"));
        command
            .arg("--bundle")
            .arg(directory.join("bundle.js"))
            .arg("--log-file")
            .arg(directory.join("host.log"))
            .arg("--data-dir")
            .arg(directory.join("data"))
            .stdin(if terminal_input {
                Stdio::from(slave.try_clone().unwrap())
            } else {
                Stdio::null()
            })
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(
                File::create(directory.join("stderr.log")).unwrap(),
            ));
        if fps {
            command.arg("--fps");
        }
        // SAFETY: the child hook uses only async-signal-safe syscalls, with no allocation or locks.
        unsafe {
            command.pre_exec(move || {
                supervise::new_session()?;
                if controlling && libc::ioctl(libc::STDOUT_FILENO, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Self {
            process: supervise::track(command.spawn().unwrap(), master),
            slave: probe,
            original,
            directory,
        }
    }

    fn start(controlling: bool, fps: bool) -> Self {
        let mut host = Self::spawn(controlling, fps, true);
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut output = Vec::new();
        loop {
            host.drain(&mut output);
            if output
                .windows(b"PTY-ready".len())
                .any(|part| part == b"PTY-ready")
            {
                break;
            }
            assert!(
                host.process.child().try_wait().unwrap().is_none(),
                "host exited before drawing"
            );
            assert!(
                Instant::now() < deadline,
                "host did not draw: {}",
                String::from_utf8_lossy(&output)
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let pid = host.process.child().id() as libc::pid_t;
        // SAFETY: read-only identity queries of the live, owned host process.
        unsafe {
            assert_eq!(libc::getsid(pid), pid);
            assert_eq!(libc::getpgid(pid), pid);
        }
        host
    }

    fn drain(&mut self, output: &mut Vec<u8>) {
        let mut terminal = self.process.master();
        let Some(master) = terminal.as_mut() else {
            return;
        };
        let mut bytes = [0; 8192];
        for _ in 0..DRAIN_READS {
            match master.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => output.extend_from_slice(&bytes[..count]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.raw_os_error() == Some(libc::EIO) =>
                {
                    break;
                }
                Err(error) => panic!("read PTY: {error}"),
            }
        }
    }

    fn signal(&self, signal: libc::c_int) {
        let mut child = self.process.child();
        assert!(
            child.try_wait().unwrap().is_none(),
            "host exited before signal"
        );
        // SAFETY: this child is owned and has not been reaped, so its PID cannot be reused.
        assert_eq!(unsafe { libc::kill(child.id() as libc::pid_t, signal) }, 0);
    }

    fn wait(&mut self, drain_output: bool, timeout: Duration) -> (ExitStatus, Vec<u8>) {
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        loop {
            if drain_output {
                self.drain(&mut output);
            }
            let status = self.process.child().try_wait().unwrap();
            if let Some(status) = status {
                if drain_output {
                    self.drain(&mut output);
                }
                return (status, output);
            }
            assert!(
                Instant::now() < deadline,
                "host {} did not exit within {timeout:?}: {}",
                self.process.child().id(),
                fs::read_to_string(self.directory.join("stderr.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.process.stop();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn termios(file: &File) -> libc::termios {
    let mut value = std::mem::MaybeUninit::uninit();
    // SAFETY: the live PTY descriptor and output buffer are valid.
    assert_eq!(
        unsafe { libc::tcgetattr(file.as_raw_fd(), value.as_mut_ptr()) },
        0
    );
    // SAFETY: tcgetattr succeeded and initialized the buffer.
    unsafe { value.assume_init() }
}

#[test]
fn signals_exit_the_host_and_restore_the_terminal() {
    supervise::run(
        "signals_exit_the_host_and_restore_the_terminal",
        ExpectedExit::Success,
        || {
            for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGINT] {
                let mut host = Host::start(false, false);
                // Enter the input poll without supplying another byte.
                std::thread::sleep(Duration::from_millis(50));
                host.process
                    .master()
                    .as_mut()
                    .unwrap()
                    .write_all(b"\x1b[")
                    .unwrap();
                std::thread::sleep(Duration::from_millis(50));
                host.signal(signal);
                let (status, output) = host.wait(true, EXIT_TIMEOUT);
                assert!(status.success(), "signal {signal}: {status}");
                let restored = termios(&host.slave);
                // PENDIN is kernel bookkeeping for input reprocessing after leaving raw mode.
                assert_eq!(
                    restored.c_lflag & !libc::PENDIN,
                    host.original.c_lflag & !libc::PENDIN
                );
                assert_eq!(restored.c_iflag, host.original.c_iflag);
                // SAFETY: only reads the flags of this scenario's retained probe descriptor.
                let flags = unsafe { libc::fcntl(host.slave.as_raw_fd(), libc::F_GETFL) };
                assert!(
                    flags >= 0 && flags & libc::O_NONBLOCK != 0,
                    "host restoration changed the probe's blocking mode"
                );
                let output = String::from_utf8_lossy(&output);
                assert!(
                    output.contains("\x1b[?1049l"),
                    "alternate screen must close: {output:?}"
                );
                assert!(
                    output.contains("\x1b[?25h"),
                    "cursor must be restored: {output:?}"
                );
            }
        },
    );
}

#[test]
fn terminal_hangup_exits_with_or_without_a_controlling_terminal() {
    supervise::run(
        "terminal_hangup_exits_with_or_without_a_controlling_terminal",
        ExpectedExit::Success,
        || {
            for controlling in [true, false] {
                let mut host = Host::start(controlling, false);
                std::thread::sleep(Duration::from_millis(50));
                host.process.close_terminal();
                let _ = host.wait(true, EXIT_TIMEOUT);
            }
        },
    );
}

#[cfg(target_os = "macos")]
fn cpu_time(pid: u32) -> Duration {
    unsafe extern "C" {
        fn proc_pid_rusage(
            pid: libc::c_int,
            flavor: libc::c_int,
            buffer: *mut libc::rusage_info_t,
        ) -> libc::c_int;
    }
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::uninit();
    // SAFETY: this live child's PID and the output buffer match RUSAGE_INFO_V2.
    assert_eq!(
        unsafe {
            proc_pid_rusage(
                pid as libc::c_int,
                libc::RUSAGE_INFO_V2,
                info.as_mut_ptr().cast(),
            )
        },
        0
    );
    // SAFETY: proc_pid_rusage succeeded and initialized the output.
    let info = unsafe { info.assume_init() };
    Duration::from_nanos(info.ri_user_time + info.ri_system_time)
}

#[cfg(target_os = "linux")]
fn cpu_time(pid: u32) -> Duration {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect();
    let ticks = fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap();
    // SAFETY: sysconf only queries the process CPU clock tick rate.
    let rate = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    assert!(rate > 0);
    Duration::from_secs_f64(ticks as f64 / rate as f64)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
#[ignore = "measures a real host's CPU over five idle seconds per monitor setting"]
fn bench_terminal_idle_cpu() {
    supervise::run("bench_terminal_idle_cpu", ExpectedExit::Success, || {
        for fps in [false, true] {
            let mut host = Host::start(true, fps);
            // Allow startup and the final HUD idle refresh to finish before measuring.
            std::thread::sleep(Duration::from_secs(2));
            host.drain(&mut Vec::new());
            let before = cpu_time(host.process.child().id());
            let started = Instant::now();
            std::thread::sleep(Duration::from_secs(5));
            let cpu = cpu_time(host.process.child().id()) - before;
            let elapsed = started.elapsed();
            let percent = cpu.as_secs_f64() / elapsed.as_secs_f64() * 100.0;
            let mut output = Vec::new();
            host.drain(&mut output);
            host.signal(libc::SIGTERM);
            assert!(host.wait(true, EXIT_TIMEOUT).0.success());
            println!(
                "terminal idle: fps={fps}, CPU {percent:.3}% of one core, {} bytes over {:.3}s",
                output.len(),
                elapsed.as_secs_f64()
            );
            assert!(output.is_empty(), "an idle terminal must stop drawing");
            assert!(percent < 2.0, "idle host used {percent:.3}% CPU");
        }
    });
}

#[test]
fn closed_standard_input_does_not_fall_back_to_the_controlling_terminal() {
    supervise::run(
        "closed_standard_input_does_not_fall_back_to_the_controlling_terminal",
        ExpectedExit::Success,
        || {
            let mut host = Host::spawn(true, false, false);
            assert!(!host.wait(true, STARTUP_TIMEOUT).0.success());
            let error = fs::read_to_string(host.directory.join("stderr.log")).unwrap();
            assert!(
                error.contains("interactive terminal input is closed or redirected"),
                "{error}"
            );
        },
    );
}

#[test]
fn shutdown_interrupts_a_full_terminal_output_queue() {
    supervise::run(
        "shutdown_interrupts_a_full_terminal_output_queue",
        ExpectedExit::Success,
        || {
            for controlling in [false, true] {
                let mut host = Host::start(controlling, false);
                // SAFETY: only this private PTY's open file description is changed, never the user's terminal.
                unsafe {
                    let flags = libc::fcntl(host.slave.as_raw_fd(), libc::F_GETFL);
                    assert!(flags >= 0);
                    assert_eq!(
                        libc::fcntl(
                            host.slave.as_raw_fd(),
                            libc::F_SETFL,
                            flags | libc::O_NONBLOCK
                        ),
                        0
                    );
                }
                let fill_deadline = Instant::now() + FILL_TIMEOUT;
                loop {
                    assert!(
                        Instant::now() < fill_deadline,
                        "PTY output did not apply backpressure"
                    );
                    match host.slave.write(&[b'x'; 8192]) {
                        Ok(0) => panic!("PTY unexpectedly closed"),
                        Ok(_) => {}
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                        Err(error) => panic!("fill PTY: {error}"),
                    }
                }
                host.process
                    .master()
                    .as_mut()
                    .unwrap()
                    .write_all(b"\x08e")
                    .unwrap();
                std::thread::sleep(Duration::from_millis(100));
                assert!(
                    host.process.child().try_wait().unwrap().is_none(),
                    "output backpressure must wait, not fail"
                );
                host.signal(libc::SIGTERM);
                assert!(host.wait(false, EXIT_TIMEOUT).0.success());
                if !controlling {
                    assert_eq!(
                        termios(&host.slave).c_lflag & !libc::PENDIN,
                        host.original.c_lflag & !libc::PENDIN
                    );
                }
            }
        },
    );
}

#[test]
fn watchdog_reaps_a_blocked_scenario() {
    supervise::run(
        "watchdog_reaps_a_blocked_scenario",
        ExpectedExit::Watchdog,
        || {
            let host = Host::start(false, false);
            fs::write("host.pid", host.process.child().id().to_string()).unwrap();
            supervise::expire_soon();
            loop {
                std::thread::park();
            }
        },
    );
}

#[test]
fn failed_scenario_reaps_its_host() {
    supervise::run(
        "failed_scenario_reaps_its_host",
        ExpectedExit::Panic,
        || {
            let host = Host::start(false, false);
            fs::write("host.pid", host.process.child().id().to_string()).unwrap();
            panic!("intentional lifecycle failure");
        },
    );
}

#[test]
fn bundled_fonts_leave_the_host_running() {
    supervise::run(
        "bundled_fonts_leave_the_host_running",
        ExpectedExit::Success,
        || {
            let mut host = Host::spawn_source(
                false,
                false,
                true,
                r#"
            import { mount, Text } from 'nsh';
            import { font } from 'nsh:rt';
            const family = font('asset:/fonts/Pacifico-Regular.ttf', 'Pacifico');
            setTimeout(() => mount(() => <Text style={{ fontFamily: family }}>Font-ready</Text>), 100);
        "#,
                &[(
                    "fonts/Pacifico-Regular.ttf",
                    include_bytes!("../../../../examples/gallery/fonts/Pacifico-Regular.ttf"),
                )],
            );
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            let mut output = Vec::new();
            loop {
                host.drain(&mut output);
                assert!(
                    host.process.child().try_wait().unwrap().is_none(),
                    "host exited: {}",
                    String::from_utf8_lossy(&output)
                );
                if output
                    .windows(b"Font-ready".len())
                    .any(|part| part == b"Font-ready")
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "font specimen did not draw: {}",
                    String::from_utf8_lossy(&output)
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            host.signal(libc::SIGTERM);
            assert!(host.wait(true, EXIT_TIMEOUT).0.success());
        },
    );
}
