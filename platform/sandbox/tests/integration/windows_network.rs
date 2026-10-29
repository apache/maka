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

#![cfg(windows)]

use maka_sandbox::{
    filesystem::Scope,
    windows::{
        AccountId, Credential, NetworkRules, Password, WriteCapability, WriteToken,
        acl::{self, Permission},
    },
};
use std::{
    io,
    net::{TcpListener, TcpStream, UdpSocket},
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    },
    ptr,
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{GENERIC_ALL, LocalFree, WAIT_OBJECT_0},
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        ImpersonateLoggedOnUser, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, LogonUserW,
        RevertToSelf, SECURITY_ATTRIBUTES,
    },
    Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL, WRITE_DAC,
    },
    System::{StationsAndDesktops::*, Threading::*},
};

#[test]
#[ignore = "requires administrator; creates and removes a temporary local account and WFP rules"]
fn account_boundaries_and_per_execution_write_scopes_preserve_other_users() {
    let mut account = Account::new().unwrap();
    let namespace = Uuid::new_v4();
    eprintln!(
        "sandbox network acceptance namespace={namespace}, account={}",
        account.name
    );
    let rules = Rules(NetworkRules::new(namespace));
    let desktop = Desktop::new(&account.sid).unwrap();
    filesystem_boundaries(&account, &desktop);
    let mut cases = Vec::new();
    let mut tcp = Vec::new();
    for ip in ["127.0.0.1", "::1"] {
        let listener = TcpListener::bind((ip, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        cases.push((format!(
            "$c=[System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::{}); $t=$c.ConnectAsync([System.Net.IPAddress]::Parse('{ip}'),{port}); if(-not $t.Wait(3000)){{exit 24}}; $c.Dispose()",
            if ip == "::1" { "InterNetworkV6" } else { "InterNetwork" }
        ), None));
        tcp.push(listener);
        let listener = UdpSocket::bind((ip, 0)).unwrap();
        listener
            .set_read_timeout(Some(std::time::Duration::from_millis(200)))
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        cases.push((format!(
            "$c=[System.Net.Sockets.UdpClient]::new([System.Net.Sockets.AddressFamily]::{}); $c.Connect([System.Net.IPAddress]::Parse('{ip}'),{port}); [void]$c.Send([byte[]](1),1); $c.Dispose()",
            if ip == "::1" { "InterNetworkV6" } else { "InterNetwork" }
        ), Some(listener)));
        cases.push((format!(
            "$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('{ip}'),0); $l.Start(); $l.Stop()"
        ), None));
    }
    for phase in ["baseline", "blocked", "gateway", "removed"] {
        match phase {
            "blocked" => {
                account.enabled(false).unwrap();
                rules
                    .0
                    .install(
                        &[maka_sandbox::windows::AccountNetwork {
                            sid: &account.sid,
                            proxy_port: None,
                        }],
                        &[],
                    )
                    .unwrap();
                // Replacement is atomic and does not accumulate stale filters.
                rules
                    .0
                    .install(
                        &[maka_sandbox::windows::AccountNetwork {
                            sid: &account.sid,
                            proxy_port: None,
                        }],
                        &[],
                    )
                    .unwrap();
                account.enabled(true).unwrap();
            }
            "gateway" => {
                account.enabled(false).unwrap();
                rules
                    .0
                    .install(
                        &[maka_sandbox::windows::AccountNetwork {
                            sid: &account.sid,
                            proxy_port: std::num::NonZeroU16::new(
                                tcp[0].local_addr().unwrap().port(),
                            ),
                        }],
                        &[],
                    )
                    .unwrap();
                account.enabled(true).unwrap();
            }
            "removed" => {
                account.enabled(false).unwrap();
                rules.0.remove().unwrap();
                rules.0.remove().unwrap();
                account.enabled(true).unwrap();
            }
            _ => {}
        }
        for (index, (case, udp)) in cases.iter().enumerate() {
            let status = account.run_restricted(case, &desktop).unwrap();
            if let Some(receiver) = udp {
                // UDP can accept a datagram before asynchronous filtering. The
                // receiving socket, not send()'s return value, proves isolation.
                let mut bytes = [0; 16];
                if matches!(phase, "blocked" | "gateway") {
                    assert!(matches!(status, 0 | 23), "{phase}: {case}: {status}");
                    let error = receiver.recv(&mut bytes).expect_err("sandbox UDP escaped");
                    assert!(matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ));
                } else {
                    assert_eq!(status, 0, "{phase}: {case}");
                    assert_eq!(receiver.recv(&mut bytes).unwrap(), 1);
                    assert_eq!(bytes[0], 1);
                }
            } else {
                assert_eq!(
                    status,
                    if phase == "blocked" || (phase == "gateway" && index != 0) {
                        23
                    } else {
                        0
                    },
                    "{phase}: {case}"
                );
            }
        }
        // This is the ordinary Host identity, not the dedicated account.
        for listener in &tcp {
            TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        }
        for listener in cases.iter().filter_map(|(_, udp)| udp.as_ref()) {
            let addr = listener.local_addr().unwrap();
            let sender = UdpSocket::bind((addr.ip(), 0)).unwrap();
            sender.send_to(b"host", addr).unwrap();
            let mut bytes = [0; 16];
            let count = listener.recv(&mut bytes).unwrap();
            assert_eq!(&bytes[..count], b"host");
        }
    }
    account.remove().unwrap();
    rules.0.remove().unwrap();
}

fn filesystem_boundaries(account: &Account, desktop: &Desktop) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let work = root.join("work");
    let protected = work.join(".git");
    let private = root.join("private");
    std::fs::create_dir_all(&protected).unwrap();
    std::fs::write(root.join("outside"), "outside").unwrap();
    std::fs::write(protected.join("config"), "protected").unwrap();
    std::fs::write(&private, "private").unwrap();
    let read = format!(
        "[void][IO.File]::ReadAllText('{}')",
        root.join("outside")
            .display()
            .to_string()
            .replace('\'', "''")
    );
    assert_eq!(
        account.run(&read, desktop).unwrap(),
        25,
        "fixture must start private"
    );
    let mut objects = Vec::new();
    let directory = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL | WRITE_DAC)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(root)
        .unwrap();
    acl::set(
        &directory,
        &account.sid,
        Scope::Exact,
        Some(Permission::Read),
    )
    .unwrap();
    assert_eq!(
        account.run(&read, desktop).unwrap(),
        25,
        "exact directory read must not grant child contents"
    );
    acl::set(&directory, &account.sid, Scope::Exact, None).unwrap();
    for (path, permission) in [
        (root, Permission::Read),
        (work.as_path(), Permission::Write),
        (protected.as_path(), Permission::DenyWrite),
        (private.as_path(), Permission::Deny),
    ] {
        let file = std::fs::OpenOptions::new()
            .access_mode(READ_CONTROL | WRITE_DAC)
            // Do not accidentally prove sharing-mode denial instead of ACL denial.
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .unwrap();
        acl::set(&file, &account.sid, Scope::Subtree, Some(permission)).unwrap();
        objects.push(file);
    }
    let mut other = Account::new().unwrap();
    let other_desktop = Desktop::new(&other.sid).unwrap();
    acl::set(
        &objects[0],
        &other.sid,
        Scope::Subtree,
        Some(Permission::Read),
    )
    .unwrap();
    let path = root.display().to_string().replace('\'', "''");
    for allowed in [
        format!("if([IO.File]::ReadAllText('{path}\\outside') -ne 'outside'){{exit 33}}"),
        format!(
            "if([IO.File]::ReadAllText('{path}\\work\\.git\\config') -ne 'protected'){{exit 34}}"
        ),
        format!("[IO.File]::WriteAllText('{path}\\work\\allowed', 'allowed')"),
    ] {
        assert_eq!(account.run(&allowed, desktop).unwrap(), 0);
    }
    for denied in [
        format!("[IO.File]::WriteAllText('{path}\\outside', 'escaped')"),
        format!("[IO.File]::WriteAllText('{path}\\work\\.git\\config', 'escaped')"),
        format!("[IO.Directory]::Move('{path}\\work\\.git', '{path}\\work\\renamed')"),
        format!("[IO.File]::ReadAllText('{path}\\private')"),
    ] {
        let script = format!(
            "try {{ {denied}; exit 31 }} catch {{ if(($_.Exception.GetBaseException().HResult -band 65535) -ne 5){{exit 32}} }}"
        );
        assert_eq!(account.run(&script, desktop).unwrap(), 0, "{denied}");
    }
    write_scopes(account, root);
    assert_eq!(
        std::fs::read_to_string(work.join("allowed")).unwrap(),
        "allowed"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("outside")).unwrap(),
        "outside"
    );
    assert_eq!(
        std::fs::read_to_string(protected.join("config")).unwrap(),
        "protected"
    );
    assert_eq!(std::fs::read_to_string(&private).unwrap(), "private");
    for file in objects.iter().rev() {
        acl::set(file, &account.sid, Scope::Subtree, None).unwrap();
    }
    assert_eq!(account.run(&read, desktop).unwrap(), 25);
    assert_eq!(
        other.run(&read, &other_desktop).unwrap(),
        0,
        "revocation must preserve a different identity's later grant"
    );
    acl::set(&objects[0], &other.sid, Scope::Subtree, None).unwrap();
    other.remove().unwrap();
    std::fs::write(root.join("outside"), "host still owns the file").unwrap();
}

fn write_scopes(account: &Account, root: &std::path::Path) {
    let base = account.token().unwrap();
    let a = root.join("work/a");
    let b = root.join("work/b");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    let first = WriteCapability::new(Uuid::new_v4());
    let second = WriteCapability::new(Uuid::new_v4());
    let mut granted = Vec::new();
    for (path, cap) in [(&a, &first), (&b, &second)] {
        let (target, file) = acl::Target::capture(path).unwrap();
        acl::set(&file, cap.sid(), Scope::Subtree, Some(Permission::Write)).unwrap();
        // Recovery retains identity, never a still-open handle or old DACL.
        granted.push(serde_json::to_vec(&target).unwrap());
    }
    {
        let _identity = Impersonation::new(base.as_handle());
        // The account alone can write both scopes, as it would after preparing
        // several workspaces. Only the per-execution token narrows this access.
        std::fs::write(a.join("file"), "a").unwrap();
        std::fs::write(b.join("file"), "b").unwrap();
    }
    for (cap, allowed, denied) in [(&first, &a, &b), (&second, &b, &a)] {
        let token = WriteToken::new(base.as_handle(), std::slice::from_ref(cap)).unwrap();
        let _identity = Impersonation::new(token.as_handle());
        assert_eq!(
            std::fs::read_to_string(root.join("outside")).unwrap(),
            "outside"
        );
        std::fs::write(allowed.join("file"), "updated").unwrap();
        // Newly created files must remain usable by the same restricted token.
        std::fs::write(allowed.join("created"), "new").unwrap();
        std::fs::write(allowed.join("created"), "again").unwrap();
        for path in [
            denied.join("file"),
            root.join("work/.git/config"),
            root.join("outside"),
        ] {
            let error = std::fs::write(&path, "escaped").unwrap_err();
            assert_eq!(error.raw_os_error(), Some(5), "{}: {error}", path.display());
        }
        assert_eq!(
            std::fs::read(root.join("private"))
                .unwrap_err()
                .raw_os_error(),
            Some(5)
        );
        // Owning a file as the shared account must not let another execution
        // rewrite its DACL and grant itself the missing write capability.
        assert_eq!(
            std::fs::OpenOptions::new()
                .access_mode(WRITE_DAC)
                .open(denied.join("file"))
                .unwrap_err()
                .raw_os_error(),
            Some(5)
        );
    }
    let moved = root.join("work/moved-a");
    std::fs::rename(&a, &moved).unwrap();
    std::fs::create_dir(&a).unwrap();
    let (_, replacement) = acl::Target::capture(&a).unwrap();
    acl::set(
        &replacement,
        first.sid(),
        Scope::Subtree,
        Some(Permission::Write),
    )
    .unwrap();
    std::fs::write(a.join("file"), "replacement").unwrap();
    for (record, cap) in granted.iter().zip([&first, &second]) {
        let target: acl::Target = serde_json::from_slice(record).unwrap();
        let file = target
            .reopen()
            .unwrap()
            .expect("original object still exists");
        acl::set(&file, cap.sid(), Scope::Subtree, None).unwrap();
    }
    {
        let token = WriteToken::new(base.as_handle(), std::slice::from_ref(&first)).unwrap();
        let _identity = Impersonation::new(token.as_handle());
        assert_eq!(
            std::fs::write(moved.join("file"), "escaped")
                .unwrap_err()
                .raw_os_error(),
            Some(5)
        );
        std::fs::write(a.join("file"), "replacement grant preserved").unwrap();
    }
    acl::set(&replacement, first.sid(), Scope::Subtree, None).unwrap();
}

struct Impersonation;
impl Impersonation {
    fn new(token: BorrowedHandle<'_>) -> Self {
        assert_ne!(
            unsafe { ImpersonateLoggedOnUser(token.as_raw_handle()) },
            0,
            "{}",
            io::Error::last_os_error()
        );
        Self
    }
}
impl Drop for Impersonation {
    fn drop(&mut self) {
        // Continuing fixture cleanup under the restricted identity is unsafe.
        if unsafe { RevertToSelf() } == 0 {
            std::process::abort();
        }
    }
}

struct Rules(NetworkRules);
impl Drop for Rules {
    fn drop(&mut self) {
        // Panic recovery only; normal cleanup above checks the result.
        if let Err(error) = self.0.remove() {
            eprintln!("sandbox test network cleanup failed: {error}");
        }
    }
}

struct Account {
    name: String,
    password: Password,
    sid: String,
    identity: AccountId,
}
impl Account {
    fn new() -> io::Result<Self> {
        // Primitive fixture only; production binds this marker to the caller.
        let identity = AccountId::new(Uuid::new_v4(), "S-1-5-18")?;
        let password = Password::generate();
        let encrypted = serde_json::to_vec(&password.protect()?)?;
        let restored: Credential = serde_json::from_slice(&encrypted)?;
        let restored = restored.unprotect()?;
        assert_eq!(password.as_wide(), restored.as_wide());
        let account = identity.ensure(restored.as_wide())?;
        let fixture = Self {
            name: account.name(),
            password: restored,
            sid: account.sid().into(),
            identity,
        };
        assert!(!account.is_enabled(), "new accounts must start disabled");
        let recovered = fixture.identity.ensure(fixture.password.as_wide())?;
        assert_eq!(recovered.sid(), fixture.sid);
        let mut forged = serde_json::to_value(&fixture.identity)?;
        forged["owner"] = "S-1-5-19".into();
        let forged: AccountId = serde_json::from_value(forged)?;
        assert!(
            matches!(forged.resolve(), Err(error) if error.kind() == io::ErrorKind::PermissionDenied)
        );
        recovered.set_enabled(true)?;
        Ok(fixture)
    }

    fn enabled(&self, enabled: bool) -> io::Result<()> {
        self.identity
            .resolve()?
            .ok_or_else(|| io::Error::other("test account missing"))?
            .set_enabled(enabled)
    }

    fn token(&self) -> io::Result<OwnedHandle> {
        let mut token = ptr::null_mut();
        if unsafe {
            LogonUserW(
                wide(&self.name).as_ptr(),
                wide(".").as_ptr(),
                self.password.as_wide().as_ptr(),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut token,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(token) })
    }

    fn run(&self, body: &str, desktop: &Desktop) -> io::Result<u32> {
        self.run_with_token(body, desktop, false)
    }

    fn run_restricted(&self, body: &str, desktop: &Desktop) -> io::Result<u32> {
        self.run_with_token(body, desktop, true)
    }

    fn run_with_token(&self, body: &str, desktop: &Desktop, restricted: bool) -> io::Result<u32> {
        let system = std::env::var("SystemRoot").unwrap();
        let exe = format!(r"{system}\System32\WindowsPowerShell\v1.0\powershell.exe");
        let script = format!(
            "$ErrorActionPreference='Stop'; try {{ {body}; exit 0 }} catch {{ $e=$_.Exception.GetBaseException(); if($e -is [System.Net.Sockets.SocketException] -and $e.SocketErrorCode -eq [System.Net.Sockets.SocketError]::AccessDenied){{exit 23}}; exit 25 }}"
        );
        let mut line = wide(&format!(
            "\"{exe}\" -NoLogo -NoProfile -NonInteractive -Command \"{script}\""
        ));
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: desktop.name.as_ptr().cast_mut(),
            ..Default::default()
        };
        let mut child = PROCESS_INFORMATION::default();
        let ok = if restricted {
            let base = self.token()?;
            let token =
                WriteToken::new(base.as_handle(), std::slice::from_ref(&desktop.capability))?;
            let mut environment = Vec::new();
            for (name, value) in [
                ("SystemRoot", system.as_str()),
                ("TEMP", desktop.scratch.path().to_str().unwrap()),
                ("TMP", desktop.scratch.path().to_str().unwrap()),
            ] {
                environment.extend(wide(&format!("{name}={value}")));
            }
            environment.push(0);
            // This admin-only fixture runs a bounded, trusted network probe.
            // Production uses AsUser in the low-privilege runner with atomic
            // Job assignment; WithToken has no extended startup attributes.
            unsafe {
                CreateProcessWithTokenW(
                    token.as_handle().as_raw_handle(),
                    0,
                    wide(&exe).as_ptr(),
                    line.as_mut_ptr(),
                    CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                    environment.as_ptr().cast(),
                    wide(&system).as_ptr(),
                    &startup,
                    &mut child,
                )
            }
        } else {
            unsafe {
                CreateProcessWithLogonW(
                    wide(&self.name).as_ptr(),
                    wide(".").as_ptr(),
                    self.password.as_wide().as_ptr(),
                    0,
                    wide(&exe).as_ptr(),
                    line.as_mut_ptr(),
                    CREATE_NO_WINDOW,
                    ptr::null(),
                    wide(&system).as_ptr(),
                    &startup,
                    &mut child,
                )
            }
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = unsafe { OwnedHandle::from_raw_handle(child.hProcess) };
        let _thread = unsafe { OwnedHandle::from_raw_handle(child.hThread) };
        if unsafe { WaitForSingleObject(process.as_raw_handle(), 15_000) } != WAIT_OBJECT_0 {
            unsafe {
                TerminateProcess(process.as_raw_handle(), 90);
                WaitForSingleObject(process.as_raw_handle(), 5_000);
            }
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "network acceptance child did not exit",
            ));
        }
        let mut exit = 0;
        if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(exit)
    }

    fn remove(&mut self) -> io::Result<()> {
        if let Some(account) = self.identity.resolve()? {
            account.remove()?;
        }
        Ok(())
    }
}
impl Drop for Account {
    fn drop(&mut self) {
        if let Err(error) = self.remove() {
            eprintln!(
                "sandbox test account cleanup failed for {}: {error}",
                self.name
            );
        }
    }
}

// SSH runs in a noninteractive window station. Give the test account its own
// station/desktop, never an ACE on the user's existing desktop or clipboard.
struct Desktop {
    name: Vec<u16>,
    station: HWINSTA,
    desktop: HDESK,
    capability: WriteCapability,
    scratch: tempfile::TempDir,
}
impl Desktop {
    fn new(sid: &str) -> io::Result<Self> {
        let capability = WriteCapability::new(Uuid::new_v4());
        let scratch = tempfile::tempdir()?;
        let file = std::fs::OpenOptions::new()
            .access_mode(READ_CONTROL | WRITE_DAC)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(scratch.path())?;
        for identity in [sid, capability.sid()] {
            acl::set(&file, identity, Scope::Subtree, Some(Permission::Write))?;
        }
        // The SID was read from NetUserGetInfo, not supplied as SDDL by a caller.
        let sddl = wide(&format!(
            "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;{sid})(A;;GA;;;{})",
            capability.sid()
        ));
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let station_name = format!("maka-test-{}", Uuid::new_v4().simple());
        let mut private = Self {
            name: wide(&format!("{station_name}\\default")),
            station: ptr::null_mut(),
            desktop: ptr::null_mut(),
            capability,
            scratch,
        };
        let result = (|| {
            let original = unsafe { GetProcessWindowStation() };
            if original.is_null() {
                return Err(io::Error::last_os_error());
            }
            private.station = unsafe {
                CreateWindowStationW(wide(&station_name).as_ptr(), 0, GENERIC_ALL, &security)
            };
            if private.station.is_null() {
                return Err(io::Error::last_os_error());
            }
            if unsafe { SetProcessWindowStation(private.station) } == 0 {
                return Err(io::Error::last_os_error());
            }
            // Only this single-test process changes its own station. Restore it
            // before returning, including when desktop creation fails.
            private.desktop = unsafe {
                CreateDesktopW(
                    wide("default").as_ptr(),
                    ptr::null(),
                    ptr::null(),
                    0,
                    GENERIC_ALL,
                    &security,
                )
            };
            let error = io::Error::last_os_error();
            if unsafe { SetProcessWindowStation(original) } == 0 {
                return Err(io::Error::last_os_error());
            }
            if private.desktop.is_null() {
                return Err(error);
            }
            Ok(())
        })();
        unsafe {
            LocalFree(descriptor);
        }
        result?;
        Ok(private)
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            if !self.desktop.is_null() {
                CloseDesktop(self.desktop);
            }
            if !self.station.is_null() {
                CloseWindowStation(self.station);
            }
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
