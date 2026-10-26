//! A class: `new Account("Savings", 100)`, its methods, a property, a
//! static, an `async` member, a callback subscription and `dispose()`.

use std::time::Duration;

use nsh_core::prelude::*;

use crate::ledger::money;

/// An account kept in Rust: TS holds the object, the balance lives here.
#[class]
pub struct Account {
    name: String,
    balance: f64,
    entries: u32,
    /// Kept for as long as the account lives; `#[class]` reports them to
    /// QuickJS's collector, so a listener capturing the object is freed
    /// with it.
    listeners: Vec<Callback<f64>>,
}

#[class]
impl Account {
    /// A new account named `name`, opening with `opening` (0 when left
    /// out).
    // `new` is the constructor; a trailing `Option` is optional in TS.
    pub fn new(name: String, opening: Option<f64>) -> Self {
        Account {
            name,
            balance: opening.unwrap_or(0.0),
            entries: 0,
            listeners: Vec::new(),
        }
    }

    /// An account from `"Name: 12.5"`; throws on anything else.
    // No `self`: a static, `Account.parse(..)`. An `Err` throws.
    pub fn parse(text: String) -> Result<Account, String> {
        let (name, amount) = text
            .split_once(':')
            .ok_or_else(|| format!("expected \"Name: amount\", got {text:?}"))?;
        let amount = amount
            .trim()
            .parse()
            .map_err(|_| format!("not an amount: {:?}", amount.trim()))?;
        Ok(Account::new(name.trim().to_owned(), Some(amount)))
    }

    /// The balance.
    // A getter without a setter: read-only in TS.
    #[getter]
    pub fn balance(&self) -> f64 {
        self.balance
    }

    /// The account's name.
    #[getter]
    pub fn name(&self) -> String {
        self.name.clone()
    }

    /// Renames the account (`account.name = "…"`).
    #[setter]
    pub fn set_name(&mut self, name: String) {
        self.name = name;
    }

    /// One line about the account: its name, balance and entries.
    // `&self`: borrows the instance for the call.
    pub fn statement(&self) -> String {
        let entries = if self.entries == 1 {
            "entry"
        } else {
            "entries"
        };
        format!(
            "{}: {} after {} {entries}",
            self.name,
            money(self.balance),
            self.entries
        )
    }

    /// Adds `amount` (more than 0); the new balance.
    // `&mut self`: changes the instance, inside the TS call.
    pub fn deposit(&mut self, amount: f64) -> Result<f64, String> {
        if amount.is_nan() || amount <= 0.0 {
            return Err(format!("a deposit is more than 0, got {amount}"));
        }
        self.book(amount);
        Ok(self.balance)
    }

    /// Moves `amount` to `to`; this account's new balance.
    // Another instance as an argument, borrowed for the call.
    pub fn transfer(&mut self, to: &mut Account, amount: f64) -> Result<f64, String> {
        if amount.is_nan() || amount <= 0.0 || amount > self.balance {
            return Err(format!(
                "cannot move {} out of {}",
                money(amount),
                money(self.balance)
            ));
        }
        self.book(-amount);
        to.book(amount);
        Ok(self.balance)
    }

    /// Calls `listener` with the new balance after every change.
    // A `Callback` is the TS function; kept here, it is called with `post`
    // from wherever the balance changes (see `book`).
    // `#[args(..)]` names the callback's arguments in TS:
    // `(balance: number) => void`.
    pub fn on_change(&mut self, #[args(balance)] listener: Callback<f64>) {
        self.listeners.push(listener);
    }

    /// Adds a month's interest at `rate`, settled by a (pretend) bank
    /// after 200 ms; resolves with the new balance.
    // An `async` member runs as a task of the core: a Promise. `this`
    // keeps the instance until the task ends; `with` / `with_mut` borrow
    // it between awaits.
    pub async fn accrue(this: Instance<Self>, rate: f64) -> f64 {
        timer(Duration::from_millis(200)).await;
        this.with_mut(|account| {
            let interest = (account.balance * rate * 100.0).round() / 100.0;
            account.book(interest);
            account.balance
        })
    }

    /// Books `amount` and tells the listeners. `post` queues each call for
    /// JS's next turn, so it works from `accrue`'s task too, where JS is not
    /// running (`call` runs a callback at once, only inside a TS call).
    // No `pub`: a helper of the block, Rust's only (TS has no `book`).
    fn book(&mut self, amount: f64) {
        self.balance = ((self.balance + amount) * 100.0).round() / 100.0;
        self.entries += 1;
        for listener in &self.listeners {
            listener.post(self.balance);
        }
    }
}
