//! The TypeScript declarations `nsh` writes for the crate's set
//! (`.nsh/types/rust-exports/native.d.ts`), as TSX reads them.

/// The declarations of the crate's set.
fn declarations() -> String {
    nsh_core::element::declarations(&rust_exports_native::registry(), &[])
}

#[test]
fn callbacks_and_events_name_their_arguments() {
    let ts = declarations();
    for line in [
        // `#[args(balance)]` on the parameter.
        "  onChange(listener: (balance: number) => void): void;",
        // An event's data without `#[args]`: `value`.
        "  onChange?: (value: number) => void;",
    ] {
        assert!(ts.contains(line), "missing {line:?} in\n{ts}");
    }
}

#[test]
fn each_export_is_documented_by_the_item_that_names_it() {
    let ts = declarations();
    for line in [
        // The `#[component] fn`'s doc comment, not the props struct's.
        "/** How much of a budget is spent;",
        // The `#[module]` struct's, the `#[class]` struct's.
        "/** Money helpers. */\nexport interface LedgerModule {",
        "/** An account kept in Rust: TS holds the object, the balance lives here. */\nexport declare class Account {",
    ] {
        assert!(ts.contains(line), "missing {line:?} in\n{ts}");
    }
    assert!(
        !ts.contains("The props of"),
        "the props struct's doc is Rust's:\n{ts}"
    );
    assert_eq!(
        rust_exports_native::registry().undocumented(),
        Vec::<String>::new()
    );
}

#[test]
fn rust_notes_under_a_heading_stay_out_of_ts() {
    let ts = declarations();
    assert!(
        ts.contains(
            "  /** Puts `text` on the clipboard; resolves with the number of characters copied. */\n  copy(text: string): Promise<number>;"
        ),
        "{ts}"
    );
    assert!(!ts.contains("cx"), "the `# Rust` section is Rust's:\n{ts}");
}
