use std::{path::PathBuf, sync::Arc};

use nsh_core::{
    access::{Access, Capabilities, TrustedPaths},
    element::{Quotas, System},
};

use super::{
    js::{Share, ShareContent},
    *,
};

fn absolute_path(name: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!("C:\\data\\{name}"))
    } else {
        PathBuf::from(format!("/data/{name}"))
    }
}

#[test]
fn a_request_needs_something_to_share() {
    assert!(ShareRequest::new().title("Only a title").check().is_err());
    assert!(ShareRequest::new().text("").check().is_err());
    assert!(ShareRequest::new().text("Hello").check().is_ok());
    assert!(
        ShareRequest::new()
            .url("https://example.com/a")
            .check()
            .is_ok()
    );
    assert!(
        ShareRequest::new()
            .file(absolute_path("a.pdf"))
            .check()
            .is_ok()
    );
}

#[test]
fn urls_that_run_code_or_name_local_files_are_refused() {
    for url in [
        "javascript:alert(1)",
        "data:text/plain,hi",
        "file:///etc/hosts",
        "asset:/a.png",
        "relative/path",
        "https://example.com/a b",
    ] {
        assert!(ShareRequest::new().url(url).check().is_err(), "{url}");
    }
    for url in [
        "https://example.com",
        "mailto:a@example.com",
        "myapp://open/1",
    ] {
        assert!(ShareRequest::new().url(url).check().is_ok(), "{url}");
    }
    let long = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
    assert!(ShareRequest::new().url(long).check().is_err());
}

#[test]
fn files_are_absolute_and_bounded() {
    assert!(ShareRequest::new().file("a.pdf").check().is_err());
    let mut many = ShareRequest::new();
    for i in 0..=MAX_FILES {
        many = many.file(absolute_path(&format!("{i}.txt")));
    }
    assert!(many.check().is_err());
    let long = "x".repeat(MAX_TEXT_BYTES + 1);
    assert!(ShareRequest::new().text(long).check().is_err());
}

#[test]
fn one_string_carries_the_text_and_the_url() {
    let sheet = ShareSheet::new(ShareRequest::new().text("Look").url("https://example.com"));
    assert_eq!(
        sheet.combined_text().as_deref(),
        Some("Look\nhttps://example.com")
    );
    let only_url = ShareSheet::new(ShareRequest::new().url("https://example.com"));
    assert_eq!(
        only_url.combined_text().as_deref(),
        Some("https://example.com")
    );
    // Empty text and title are none.
    let blank = ShareSheet::new(ShareRequest::new().title("").text("").url("https://a.b"));
    assert_eq!(blank.title, None);
    assert_eq!(blank.text, None);
}

#[test]
fn files_of_one_kind_share_its_type() {
    assert_eq!(common_type("image/png", "image/png"), "image/png");
    assert_eq!(common_type("image/png", "image/jpeg"), "image/*");
    assert_eq!(common_type("image/png", "application/pdf"), "*/*");
    assert_eq!(common_type("image/*", "video/mp4"), "*/*");
}

#[test]
fn a_share_is_answered_once() {
    let (first, mut first_answer) = Reply::new(None);
    open().insert(None, first.clone());
    assert!(first.send(Ok(ShareOutcome::shared(Some("mail".into())))));
    assert!(first.is_answered());
    // A late answer settles nothing.
    assert!(!first.send(Ok(ShareOutcome::dismissed())));
    assert_eq!(
        first_answer.try_recv().unwrap(),
        Ok(ShareOutcome::shared(Some("mail".into())))
    );
    // The answered share is no longer open.
    assert!(!open().contains_key(&None));
}

#[test]
fn the_browsers_rejections_are_dismissals_or_unavailable() {
    assert_eq!(
        web::rejected("AbortError", "cancelled"),
        Ok(ShareOutcome::dismissed())
    );
    for name in ["NotAllowedError", "InvalidStateError"] {
        let error = web::rejected(name, "no").unwrap_err();
        assert_eq!(error.code.as_deref(), Some(codes::UNAVAILABLE), "{name}");
    }
    let error = web::rejected("DataError", "bad data").unwrap_err();
    assert_eq!(error.code, None);
    assert_eq!(error.message, "share: bad data");
}

/// An app granted `share` and to read its data directory `data`, as
/// `nsh.json` declares `"share": true` and `fs.read: ["${dataDir}"]`.
fn granted(data: &std::path::Path) -> System {
    let mut declared = Capabilities::default();
    declared.share = true;
    declared.fs.read = vec!["${dataDir}".into()];
    System::new(
        Arc::new(Access {
            declared,
            granted: None,
        }),
        Some(data.to_path_buf()),
        TrustedPaths::default(),
        Quotas::default(),
    )
}

/// The code `Share.show` rejects `files` with at once.
fn refused(files: &[&str], sys: System) -> Option<String> {
    match Share::show(ShareContent::files(files), sys) {
        Ok(_) => None,
        Err(error) => error.code().map(str::to_owned),
    }
}

/// A file an app shares is checked as `fs/promises` reads it: by its path
/// or by `${dataDir}/…` the sheet (and the fake, which records the sheet)
/// gets its real path; a file no grant covers is `ERR_ACCESS_DENIED`, a
/// folder `EISDIR`, a missing file `ENOENT`.
#[test]
fn files_are_granted_and_resolved_as_fs_promises_reads_them() {
    let base = std::env::temp_dir().join(format!("nsh-extra-share-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("data/trips")).unwrap();
    std::fs::create_dir_all(base.join("outside")).unwrap();
    std::fs::write(base.join("data/kyoto.txt"), "Saturday: Fushimi Inari").unwrap();
    std::fs::write(base.join("outside/secret.txt"), "secret").unwrap();
    // The real paths as `fs/promises` resolves them (`/tmp` is a link on
    // macOS; Windows paths come without the `\\?\` prefix).
    let data = nsh_core::access::canonicalize(&base.join("data")).unwrap();
    let outside = nsh_core::access::canonicalize(&base.join("outside")).unwrap();
    let kyoto = data.join("kyoto.txt");

    let request = ShareContent::files(&["${dataDir}/kyoto.txt", kyoto.to_str().unwrap()])
        .request(&granted(&data))
        .unwrap();
    assert_eq!(request.files, vec![kyoto.clone(), kyoto.clone()]);
    // What the platform (or the fake) is given.
    let real = kyoto.to_str().unwrap().to_owned();
    assert_eq!(ShareSheet::new(request).files, vec![real.clone(), real]);

    let secret = outside.join("secret.txt");
    assert_eq!(
        refused(&[secret.to_str().unwrap()], granted(&data)).as_deref(),
        Some(codes::ACCESS_DENIED)
    );
    assert_eq!(
        refused(&["${dataDir}/trips"], granted(&data)).as_deref(),
        Some("EISDIR")
    );
    assert_eq!(
        refused(&["${dataDir}/missing.txt"], granted(&data)).as_deref(),
        Some("ENOENT")
    );
    // Without `share` nothing is checked further.
    let mut declared = Capabilities::default();
    declared.fs.read = vec!["${dataDir}".into()];
    let ungranted = System::new(
        Arc::new(Access {
            declared,
            granted: None,
        }),
        Some(data.clone()),
        TrustedPaths::default(),
        Quotas::default(),
    );
    assert_eq!(
        refused(&["${dataDir}/kyoto.txt"], ungranted).as_deref(),
        Some(codes::ACCESS_DENIED)
    );
    std::fs::remove_dir_all(&base).unwrap();
}
