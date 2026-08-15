use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE,
};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::protocol::LaunchRequest;

const LEDGER_VERSION: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    version: u8,
    request_id: String,
    app_container_sid: String,
    roots: Vec<LedgerRoot>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LedgerRoot {
    path: String,
    recursive: bool,
    backup_path: String,
}

pub fn with_acl_grants<T>(
    request: &LaunchRequest,
    app_container_sid: &str,
    launch: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if request.read_roots.is_empty() && request.write_roots.is_empty() {
        return launch();
    }
    let ledger_root = std::env::temp_dir().join("maka-sandbox-acl-ledgers");
    fs::create_dir_all(&ledger_root)
        .map_err(|error| format!("create ACL ledger directory failed: {error}"))?;
    let lock_path = ledger_root.join(".active.lock");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut lock_file = loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(file) => break file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_owner_is_stale(&lock_path)? {
                    match fs::remove_file(&lock_path) {
                        Ok(()) => continue,
                        Err(remove_error)
                            if remove_error.kind() == std::io::ErrorKind::NotFound =>
                        {
                            continue;
                        }
                        Err(remove_error) => {
                            return Err(format!(
                                "remove stale ACL ledger lock failed: {remove_error}"
                            ));
                        }
                    }
                }
                if Instant::now() >= deadline {
                    return Err(format!("acquire ACL ledger lock timed out: {error}"));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("acquire ACL ledger lock failed: {error}")),
        }
    };
    writeln!(lock_file, "{}", std::process::id())
        .and_then(|()| lock_file.sync_all())
        .map_err(|error| format!("persist ACL ledger lock owner failed: {error}"))?;
    let _lock = LedgerLock { path: lock_path };
    recover_stale(&ledger_root)?;

    let roots = collect_roots(request, &ledger_root, &request.request_id)?;
    let ledger = Ledger {
        version: LEDGER_VERSION,
        request_id: request.request_id.clone(),
        app_container_sid: app_container_sid.to_owned(),
        roots,
    };
    let ledger_name = format!("{:x}.json", Sha256::digest(request.request_id.as_bytes()));
    let ledger_path = ledger_root.join(ledger_name);
    write_ledger(&ledger_path, &ledger)?;

    let grant_result = grant_roots(request, app_container_sid, &ledger.roots);
    let launch_result = match grant_result {
        Ok(()) => launch(),
        Err(error) => Err(error),
    };
    let restore_result = remove_grants(&ledger);
    if restore_result.is_ok() {
        fs::remove_file(&ledger_path)
            .map_err(|error| format!("remove completed ACL ledger failed: {error}"))?;
    }
    match (launch_result, restore_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(restore)) => Err(restore),
        (Err(error), Err(restore)) => Err(format!("{error}; ACL restore also failed: {restore}")),
    }
}

impl Drop for LedgerLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct LedgerLock {
    path: PathBuf,
}

fn lock_owner_is_stale(path: &Path) -> Result<bool, String> {
    let owner = match fs::read_to_string(path) {
        Ok(value) => value.trim().parse::<u32>().ok(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("read ACL ledger lock failed: {error}")),
    };
    let Some(owner) = owner else {
        return Ok(false);
    };
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, owner) };
    if process.is_null() {
        return Ok(unsafe { GetLastError() } == ERROR_INVALID_PARAMETER);
    }
    let mut exit_code = 0;
    let queried = unsafe { GetExitCodeProcess(process, &mut exit_code) };
    unsafe { CloseHandle(process) };
    if queried == 0 {
        return Ok(false);
    }
    Ok(exit_code != STILL_ACTIVE as u32)
}

fn collect_roots(
    request: &LaunchRequest,
    ledger_root: &Path,
    request_id: &str,
) -> Result<Vec<LedgerRoot>, String> {
    let mut roots = Vec::new();
    for path in request.read_roots.iter().chain(&request.write_roots) {
        if roots
            .iter()
            .any(|entry: &LedgerRoot| entry.path.eq_ignore_ascii_case(path))
        {
            continue;
        }
        let metadata = reject_reparse_tree(Path::new(path))?;
        let backup_path = ledger_root.join(format!(
            "{:x}.acl",
            Sha256::digest(format!("{request_id}:{}", path).as_bytes())
        ));
        save_acl(path, &backup_path, metadata.is_dir())?;
        roots.push(LedgerRoot {
            path: path.clone(),
            recursive: metadata.is_dir(),
            backup_path: backup_path.to_string_lossy().into_owned(),
        });
    }
    Ok(roots)
}

fn reject_reparse_tree(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect ACL root {} failed: {error}", path.display()))?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "ACL root contains a reparse point: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path)
            .map_err(|error| format!("scan ACL root {} failed: {error}", path.display()))?
        {
            let entry = entry.map_err(|error| format!("scan ACL root failed: {error}"))?;
            reject_reparse_tree(&entry.path())?;
        }
    }
    Ok(metadata)
}

fn write_ledger(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let bytes = serde_json::to_vec(ledger).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("create ACL ledger failed: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("persist ACL ledger failed: {error}"))
}

fn recover_stale(root: &Path) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("read ACL ledgers failed: {error}"))? {
        let path = entry
            .map_err(|error| format!("read ACL ledger entry failed: {error}"))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let source = fs::read(&path)
            .map_err(|error| format!("read stale ACL ledger {} failed: {error}", path.display()))?;
        let ledger: Ledger = serde_json::from_slice(&source)
            .map_err(|error| format!("invalid stale ACL ledger {}: {error}", path.display()))?;
        if ledger.version != LEDGER_VERSION {
            return Err(format!(
                "unsupported ACL ledger version in {}",
                path.display()
            ));
        }
        remove_grants(&ledger)?;
        fs::remove_file(&path).map_err(|error| {
            format!("remove stale ACL ledger {} failed: {error}", path.display())
        })?;
    }
    Ok(())
}

fn grant_roots(
    request: &LaunchRequest,
    sid: &str,
    ledger_roots: &[LedgerRoot],
) -> Result<(), String> {
    for root in &request.read_roots {
        let recursive = ledger_roots
            .iter()
            .find(|entry| entry.path.eq_ignore_ascii_case(root))
            .map(|entry| entry.recursive)
            .unwrap_or(false)
            && !request
                .exact_read_roots
                .iter()
                .any(|path| path.eq_ignore_ascii_case(root));
        grant(root, sid, "RX", recursive)?;
    }
    for root in &request.write_roots {
        let recursive = ledger_roots
            .iter()
            .find(|entry| entry.path.eq_ignore_ascii_case(root))
            .map(|entry| entry.recursive)
            .unwrap_or(false)
            && !request
                .exact_write_roots
                .iter()
                .any(|path| path.eq_ignore_ascii_case(root));
        grant(root, sid, "M", recursive)?;
    }
    Ok(())
}

fn grant(path: &str, sid: &str, access: &str, recursive: bool) -> Result<(), String> {
    let permission = if recursive {
        format!("*{sid}:(OI)(CI){access}")
    } else {
        format!("*{sid}:{access}")
    };
    let mut args = vec![path, "/grant", &permission, "/L", "/Q"];
    if recursive {
        args.push("/T");
    }
    run_icacls(&args, "grant")
}

fn remove_grants(ledger: &Ledger) -> Result<(), String> {
    for root in &ledger.roots {
        if !Path::new(&root.path).exists() {
            continue;
        }
        restore_acl(&root.path, Path::new(&root.backup_path))?;
        let _ = fs::remove_file(&root.backup_path);
    }
    Ok(())
}

fn save_acl(path: &str, backup: &Path, recursive: bool) -> Result<(), String> {
    let mut args = vec![
        path,
        "/save",
        backup
            .to_str()
            .ok_or_else(|| "invalid ACL backup path".to_owned())?,
        "/L",
        "/Q",
    ];
    if recursive {
        args.push("/T");
    }
    run_icacls(&args, "save")
}

fn restore_acl(path: &str, backup: &Path) -> Result<(), String> {
    let backup = backup
        .to_str()
        .ok_or_else(|| "invalid ACL backup path".to_owned())?;
    run_icacls(&[path, "/restore", backup, "/L", "/Q"], "restore")
}

fn run_icacls(args: &[&str], operation: &str) -> Result<(), String> {
    let executable = system_icacls()?;
    let output = Command::new(&executable)
        .args(args)
        .output()
        .map_err(|error| format!("start {} failed: {error}", executable.display()))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "icacls {operation} failed with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn system_icacls() -> Result<PathBuf, String> {
    let system_root = std::env::var_os("SystemRoot")
        .ok_or_else(|| "SystemRoot is unavailable to the broker".to_owned())?;
    let path = PathBuf::from(system_root)
        .join("System32")
        .join("icacls.exe");
    if !path.is_file() {
        return Err(format!("system icacls is unavailable: {}", path.display()));
    }
    Ok(path)
}
