//! The app's storage in a file (`nsh/storage` on the native platforms):
//! its entries as one JSON object, rewritten whole (to a temporary file,
//! then renamed over it) on a thread of its own after changes, so a crash
//! leaves the old file or the new one. One instance per file in the
//! process ([`FileStorage::open`]), which keeps the entries in memory: an
//! app reloaded before its writes reached the disk reads them all the same.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    thread::JoinHandle,
};

use crossbeam_channel::{Receiver, Sender};
use nsh_core::storage::{StorageBackend, StorageChange};

/// An app's storage kept in `storage.json` of a directory: the app's data
/// directory ([`crate::EngineConfig::data_dir`]), or one the embedding app
/// chooses.
pub struct FileStorage {
    path: PathBuf,
    /// The entries as changed so far, once read.
    entries: Mutex<Option<BTreeMap<String, String>>>,
    /// The file could not be read: changes stay in memory, never replacing
    /// what it holds.
    in_memory: std::sync::atomic::AtomicBool,
    writer: Mutex<Option<(Sender<StorageChange>, JoinHandle<()>)>>,
}

impl FileStorage {
    /// The storage in `dir/storage.json`: the one already open in this
    /// process, or a new one (the directory is made on the first write).
    pub fn open(dir: impl Into<PathBuf>) -> Arc<Self> {
        // By path, so that finding one upgrades no other: a reference taken
        // even briefly would move the other's last drop, which waits for
        // its writes, to this thread, after its owner thought it done.
        static OPEN: Mutex<Vec<(PathBuf, Weak<FileStorage>)>> = Mutex::new(Vec::new());
        let path = dir.into().join("storage.json");
        let mut open = OPEN.lock().unwrap_or_else(|e| e.into_inner());
        open.retain(|(_, s)| s.strong_count() > 0);
        if let Some(storage) = open
            .iter()
            .find(|(p, _)| *p == path)
            .and_then(|(_, s)| s.upgrade())
        {
            return storage;
        }
        let storage = Arc::new(Self {
            path,
            entries: Mutex::new(None),
            in_memory: std::sync::atomic::AtomicBool::new(false),
            writer: Mutex::new(None),
        });
        open.push((storage.path.clone(), Arc::downgrade(&storage)));
        storage
    }

    /// The file it keeps the entries in.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// The system's directory for apps' data, where each app keeps its own
/// under its id unless it names one (what the platforms give as
/// [`crate::EngineConfig::support_dir`]): Application Support on Apple platforms, `%APPDATA%` on
/// Windows, `$XDG_DATA_HOME` (`~/.local/share`) elsewhere. `None` on
/// Android, whose files directory only the platform knows, and without a
/// home directory.
#[doc(hidden)]
pub fn support_dir() -> Option<PathBuf> {
    support_dir_in(std::env::consts::OS, |name| {
        std::env::var_os(name).map(PathBuf::from)
    })
}

/// [`support_dir`] on `os` (`std::env::consts::OS`) with the environment
/// `env`.
fn support_dir_in(os: &str, env: impl Fn(&str) -> Option<PathBuf>) -> Option<PathBuf> {
    let env = |name| env(name).filter(|v| !v.as_os_str().is_empty());
    match os {
        "android" => None,
        "macos" | "ios" => env("HOME").map(|home| home.join("Library/Application Support")),
        "windows" => env("APPDATA"),
        _ => env("XDG_DATA_HOME").or_else(|| env("HOME").map(|home| home.join(".local/share"))),
    }
}

/// The data directory `nsh.json` `"dataDir"` names (`template`), which the
/// desktop runners give the engine ([`crate::EngineConfig::data_dir`]): an
/// absolute path, or `${homeDir}` followed by one under this user's home
/// directory (`$HOME`; `%USERPROFILE%` on Windows). `None` for anything
/// else (a relative path, `..`, another `${...}`) and for `${homeDir}`
/// without a home: the app then keeps its data where it would without
/// `"dataDir"`, rather than somewhere relative to where it started.
pub fn resolve_data_dir(template: &str) -> Option<PathBuf> {
    let home = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(home)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    resolve_data_dir_in(template, home.as_deref())
}

/// [`resolve_data_dir`] with the home directory `home`.
fn resolve_data_dir_in(template: &str, home: Option<&Path>) -> Option<PathBuf> {
    const HOME: &str = "${homeDir}";
    let path = match template.strip_prefix(HOME) {
        Some("") => home?.to_path_buf(),
        Some(rest) => {
            let rest = rest.strip_prefix(['/', '\\'])?;
            home?.join(rest)
        }
        None => PathBuf::from(template),
    };
    let rest = template.strip_prefix(HOME).unwrap_or(template);
    if rest.contains("${") || !path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path)
}

/// The system's directory for caches: Caches on Apple platforms,
/// `%LOCALAPPDATA%` on Windows, `$XDG_CACHE_HOME` (`~/.cache`) elsewhere.
/// `None` on Android, whose cache directory only the platform knows, and
/// without a home directory: what [`crate::CacheLocation::System`] is
/// unless the platform resolves it itself.
pub(crate) fn cache_dir() -> Option<PathBuf> {
    cache_dir_in(std::env::consts::OS, |name| {
        std::env::var_os(name).map(PathBuf::from)
    })
}

/// [`cache_dir`] on `os` (`std::env::consts::OS`) with the environment `env`.
fn cache_dir_in(os: &str, env: impl Fn(&str) -> Option<PathBuf>) -> Option<PathBuf> {
    let env = |name| env(name).filter(|v| !v.as_os_str().is_empty());
    match os {
        "android" => None,
        "macos" | "ios" => env("HOME").map(|home| home.join("Library/Caches")),
        "windows" => env("LOCALAPPDATA"),
        _ => env("XDG_CACHE_HOME").or_else(|| env("HOME").map(|home| home.join(".cache"))),
    }
}

#[cfg(test)]
use crate::app_dir_name;

fn read(path: &Path) -> Result<BTreeMap<String, String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// [`read`], setting a file that is no storage aside (`storage.json.corrupt`)
/// rather than letting the next write replace what it held. The error says
/// whether the file may be written: not when it is still there, unread.
fn read_or_set_aside(path: &Path) -> Result<BTreeMap<String, String>, (String, bool)> {
    read(path).map_err(|e| {
        // Only a file that reads but does not parse is set aside: one that
        // cannot be read now may hold the app's data.
        if std::fs::read(path).is_err() {
            return (format!("{e}; it is kept in memory"), false);
        }
        let aside = path.with_extension("json.corrupt");
        match std::fs::rename(path, &aside) {
            Ok(()) => (
                format!("{e}; it was set aside as {}", aside.display()),
                true,
            ),
            Err(rename) => (
                format!("{e}; it could not be set aside ({rename}), so it is kept in memory"),
                false,
            ),
        }
    })
}

fn write(path: &Path, entries: &BTreeMap<String, String>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temporary = path.with_extension("json.tmp");
    let file = std::fs::File::create(&temporary)?;
    let mut out = std::io::BufWriter::new(file);
    serde_json::to_writer(&mut out, entries)?;
    let file = out.into_inner().map_err(|e| e.into_error())?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)
}

fn apply(entries: &mut BTreeMap<String, String>, change: StorageChange) {
    match change {
        StorageChange::Set(key, value) => {
            entries.insert(key, value);
        }
        StorageChange::Remove(key) => {
            entries.remove(&key);
        }
        StorageChange::Clear => entries.clear(),
    }
}

/// Applies the changes as they come, writing the file once per burst.
fn run_writer(path: PathBuf, changes: Receiver<StorageChange>) {
    let mut entries = read(&path).unwrap_or_default();
    while let Ok(change) = changes.recv() {
        apply(&mut entries, change);
        changes
            .try_iter()
            .for_each(|change| apply(&mut entries, change));
        if let Err(e) = write(&path, &entries) {
            log::error!(target: "js", "the app's storage could not be written to {}: {e}", path.display());
        }
    }
}

impl StorageBackend for FileStorage {
    fn load(&self) -> Result<BTreeMap<String, String>, String> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entries) = &*entries {
            return Ok(entries.clone());
        }
        match read_or_set_aside(&self.path) {
            Ok(read) => {
                *entries = Some(read.clone());
                Ok(read)
            }
            Err((e, writable)) => {
                *entries = Some(BTreeMap::new());
                if !writable {
                    self.in_memory
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                }
                Err(e)
            }
        }
    }

    /// Hands `change` to the writer thread: the file is written after this
    /// returns, so an error writing it is only logged, and the change stays
    /// in memory, written with the next.
    fn write(&self, change: StorageChange) -> Result<(), String> {
        if let Some(entries) = &mut *self.entries.lock().unwrap_or_else(|e| e.into_inner()) {
            apply(entries, change.clone());
        }
        if self.in_memory.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(());
        }
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let (changes, _) = writer.get_or_insert_with(|| {
            let (tx, rx) = crossbeam_channel::unbounded();
            let path = self.path.clone();
            let thread = std::thread::Builder::new()
                .name("nsh-storage".into())
                .spawn(move || run_writer(path, rx))
                .expect("the storage thread starts");
            (tx, thread)
        });
        // The writer only stops when this is dropped.
        let _ = changes.send(change);
        Ok(())
    }
}

impl Drop for FileStorage {
    /// Waits for the last changes to be written.
    fn drop(&mut self) {
        let writer = self
            .writer
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some((changes, thread)) = writer {
            drop(changes);
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty directory of its own under the test's temporary directory.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nsh-file-storage-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn keeps_entries_across_instances() {
        let dir = scratch("instances");
        let storage = FileStorage::open(&dir);
        assert!(storage.load().unwrap().is_empty());
        storage
            .write(StorageChange::Set("a".into(), "1".into()))
            .unwrap();
        storage
            .write(StorageChange::Set("b".into(), "2".into()))
            .unwrap();
        // A reload while the first is open shares its entries, written or not.
        let reloaded = FileStorage::open(&dir);
        assert!(Arc::ptr_eq(&storage, &reloaded));
        storage.write(StorageChange::Remove("a".into())).unwrap();
        assert_eq!(reloaded.load().unwrap().len(), 1);
        drop((storage, reloaded));
        let again = FileStorage::open(&dir);
        assert_eq!(
            again.load().unwrap(),
            BTreeMap::from([("b".to_owned(), "2".to_owned())])
        );
        again.write(StorageChange::Clear).unwrap();
        drop(again);
        assert!(FileStorage::open(&dir).load().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_apps_data_dir_is_absolute_or_under_the_home_directory() {
        let home = std::env::temp_dir().join("home");
        let resolve = |template| resolve_data_dir_in(template, Some(&home));
        assert_eq!(resolve("${homeDir}/.myapp"), Some(home.join(".myapp")));
        assert_eq!(
            resolve("${homeDir}/.myapp/ui"),
            Some(home.join(".myapp/ui"))
        );
        assert_eq!(resolve("${homeDir}"), Some(home.clone()));
        let absolute = std::env::temp_dir().join("myapp");
        assert_eq!(
            resolve_data_dir_in(absolute.to_str().unwrap(), None),
            Some(absolute.clone())
        );
        // Refused: relative, other placeholders, `..`, a home that is not there.
        assert_eq!(resolve(".myapp"), None);
        assert_eq!(resolve("${homeDir}.myapp"), None);
        assert_eq!(resolve("${appId}/data"), None);
        assert_eq!(resolve("${homeDir}/${appId}"), None);
        assert_eq!(resolve("${homeDir}/../elsewhere"), None);
        assert_eq!(resolve_data_dir_in("${homeDir}/.myapp", None), None);
    }

    #[test]
    fn data_directories_follow_each_platform() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, v)| PathBuf::from(v))
            }
        };
        let home = env(&[
            ("HOME", "/home/a"),
            ("APPDATA", r"C:\Users\a\AppData\Roaming"),
        ]);
        assert_eq!(
            support_dir_in("linux", home),
            Some(PathBuf::from("/home/a/.local/share"))
        );
        assert_eq!(
            support_dir_in(
                "linux",
                env(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/a")])
            ),
            Some(PathBuf::from("/data"))
        );
        // An empty variable counts as unset.
        assert_eq!(
            support_dir_in("linux", env(&[("XDG_DATA_HOME", ""), ("HOME", "/home/a")])),
            Some(PathBuf::from("/home/a/.local/share"))
        );
        let support = Some(PathBuf::from("/home/a/Library/Application Support"));
        assert_eq!(support_dir_in("macos", home), support);
        assert_eq!(support_dir_in("ios", home), support);
        assert_eq!(
            support_dir_in("windows", home),
            Some(PathBuf::from(r"C:\Users\a\AppData\Roaming"))
        );
        // Android's files directory is the platform's to give.
        assert_eq!(support_dir_in("android", home), None);
        assert_eq!(support_dir_in("linux", env(&[])), None);
    }

    #[test]
    fn cache_directories_follow_each_platform() {
        let vars = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, v)| PathBuf::from(v))
            }
        };
        let home = vars(&[
            ("HOME", "/home/a"),
            ("LOCALAPPDATA", r"C:\Users\a\AppData\Local"),
        ]);
        assert_eq!(
            cache_dir_in("linux", home),
            Some(PathBuf::from("/home/a/.cache"))
        );
        assert_eq!(
            cache_dir_in(
                "linux",
                vars(&[("XDG_CACHE_HOME", "/c"), ("HOME", "/home/a")])
            ),
            Some(PathBuf::from("/c"))
        );
        assert_eq!(
            cache_dir_in("macos", home),
            Some(PathBuf::from("/home/a/Library/Caches"))
        );
        assert_eq!(
            cache_dir_in("windows", home),
            Some(PathBuf::from(r"C:\Users\a\AppData\Local"))
        );
        assert_eq!(cache_dir_in("android", home), None);
    }

    #[test]
    fn apps_get_directories_of_their_own() {
        assert_eq!(app_dir_name(Some("com.example.app")), "com.example.app");
        assert_eq!(app_dir_name(Some("..app")), "..app");
        assert_eq!(app_dir_name(None), "default");
        // An id that is no directory name cannot reach another directory.
        for id in ["", ".", "..", "../etc", "a/b", r"a\b", "a\0b"] {
            assert_eq!(app_dir_name(Some(id)), "default", "{id:?}");
        }
    }

    #[test]
    fn a_damaged_file_is_set_aside_not_replaced() {
        let dir = scratch("damaged");
        let file = dir.join("storage.json");
        std::fs::write(&file, b"{ not json").unwrap();
        let storage = FileStorage::open(&dir);
        let error = storage.load().unwrap_err();
        assert!(error.contains("set aside"), "{error}");
        let aside = dir.join("storage.json.corrupt");
        assert_eq!(std::fs::read(&aside).unwrap(), b"{ not json");
        // The app goes on with new entries, and the old file is still there.
        storage
            .write(StorageChange::Set("a".into(), "1".into()))
            .unwrap();
        drop(storage);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"a":"1"}"#);
        assert_eq!(std::fs::read(&aside).unwrap(), b"{ not json");
        // Values that are not strings are no storage either.
        let typed = scratch("typed");
        std::fs::write(typed.join("storage.json"), br#"{"n": 1}"#).unwrap();
        assert!(FileStorage::open(&typed).load().is_err());
        assert!(typed.join("storage.json.corrupt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn an_unreadable_file_is_never_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("unreadable");
        let file = dir.join("storage.json");
        std::fs::write(&file, br#"{"kept":"yes"}"#).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o200)).unwrap();
        if std::fs::read(&file).is_ok() {
            // Root reads it anyway: nothing to check.
            return;
        }
        let storage = FileStorage::open(&dir);
        assert!(storage.load().is_err());
        storage
            .write(StorageChange::Set("a".into(), "1".into()))
            .unwrap();
        drop(storage);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"kept":"yes"}"#);
    }

    #[test]
    fn a_failed_write_leaves_the_entries_in_memory() {
        // A file where the directory should be: nothing can be written.
        let dir = scratch("unwritable");
        let blocked = dir.join("file");
        std::fs::write(&blocked, b"").unwrap();
        let storage = FileStorage::open(blocked.join("app"));
        // Windows reads the path under a file as an absent file rather than
        // an error; either way nothing can be written there.
        #[cfg(not(windows))]
        assert!(storage.load().unwrap_err().contains("kept in memory"));
        #[cfg(windows)]
        let _ = storage.load();
        #[cfg(not(windows))]
        storage
            .write(StorageChange::Set("a".into(), "1".into()))
            .unwrap();
        #[cfg(windows)]
        let _ = storage.write(StorageChange::Set("a".into(), "1".into()));
        assert_eq!(
            storage.load().unwrap().get("a").map(String::as_str),
            Some("1")
        );
        drop(storage);
        assert!(!blocked.join("app").exists());
    }
}
