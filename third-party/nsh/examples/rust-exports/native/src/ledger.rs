//! A module: functions of the three kinds, `Ledger.format(..)`,
//! `Ledger.copy(..)`, `Ledger.fetchRate()`.

use std::time::Duration;

use nsh_core::prelude::*;

/// Money helpers.
#[module]
pub struct Ledger;

// `#[module]` on the struct and on this block: the struct's doc comment
// is the module's in TS.
#[module]
impl Ledger {
    /// `amount` as money: `$1,234.50`, `-$3.00`.
    // No `cx`, not `async`: it runs inside the TS call and returns the
    // string itself.
    pub fn format(amount: f64) -> String {
        money(amount)
    }

    /// Puts `text` on the clipboard; resolves with the number of
    /// characters copied.
    ///
    /// # Rust
    ///
    /// Taking `cx` makes it an op, run in order with the UI changes TS made
    /// before the call (the platform's services are on `cx`). Returning a
    /// value makes it a Promise of the value; returning `()` it would be a
    /// plain call (`void`), and returning `Result<(), E>` a
    /// `Promise<void>`. What follows a heading stays in Rust's docs, out of
    /// TS's.
    pub fn copy(text: String, cx: &mut ModuleCx) -> u32 {
        let count = text.chars().count() as u32;
        cx.set_clipboard(text);
        count
    }

    /// Today's interest rate, from a (pretend) round trip of 300 ms.
    // An `async fn` runs as a task of the core, with its services
    // (`timer`, `fetch`, dialogs): a Promise.
    pub async fn fetch_rate() -> f64 {
        timer(Duration::from_millis(300)).await;
        0.05
    }
}

/// `amount` as money, rounded to cents, with thousands separators.
pub(crate) fn money(amount: f64) -> String {
    let cents = (amount.abs() * 100.0).round() as u64;
    let digits = (cents / 100).to_string();
    let mut whole = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            whole.push(',');
        }
        whole.push(digit);
    }
    let sign = if amount < 0.0 && cents > 0 { "-" } else { "" };
    format!("{sign}${whole}.{:02}", cents % 100)
}
