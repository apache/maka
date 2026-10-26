//! `host/trading`: the host's paper-trading desk, which the tickets reach
//! with `nativeModule("host/trading")` and the host's own widgets read and
//! change directly. No order leaves this process; prices are samples.
//!
//! The desk (the selected symbol, the orders, the positions) lives here,
//! once, in a `watch` channel: the host's sidebar and toolbar follow it
//! (`watch`), every ticket subscribes to it (`Trading.subscribe`), and
//! whoever changes it (the host's watchlist, a ticket's watchlist, a
//! ticket's order) changes it for all of them.

use std::sync::{LazyLock, OnceLock};

use nsh_core::prelude::*;
use tokio::sync::{mpsc, oneshot, watch};

/// The symbols the desk trades, with their sample prices.
pub const SYMBOLS: [(&str, f64); 3] = [("AAPL", 227.52), ("MSFT", 428.76), ("NVDA", 138.85)];

/// How many orders the desk keeps.
const KEPT: usize = 6;

/// An order's side.
#[derive(Clone, Copy, Debug, PartialEq, PropEnum)]
pub enum Side {
    /// Buys shares.
    Buy,
    /// Sells shares.
    Sell,
}

/// An order the desk accepted.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct Order {
    /// Its number, counting from 1.
    pub id: u32,
    /// Buy or sell.
    pub side: Side,
    /// What it trades.
    pub symbol: String,
    /// How many shares.
    pub quantity: u32,
    /// The sample price per share.
    pub price: f64,
    /// Whether it may fill outside regular hours.
    pub extended: bool,
}

/// The shares held in one symbol (negative: short).
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct Position {
    /// The symbol.
    pub symbol: String,
    /// Shares held.
    pub shares: i64,
}

/// What the host and every ticket show.
#[derive(Clone, Debug, PartialEq, JsObject)]
pub struct Desk {
    /// The selected symbol.
    pub symbol: String,
    /// Its sample price.
    pub price: f64,
    /// The latest orders, newest first.
    pub orders: Vec<Order>,
    /// The shares held, in [`SYMBOLS`]' order, without empty ones.
    pub positions: Vec<Position>,
}

static DESK: LazyLock<watch::Sender<Desk>> = LazyLock::new(|| {
    watch::Sender::new(Desk {
        symbol: SYMBOLS[0].0.to_owned(),
        price: SYMBOLS[0].1,
        orders: Vec::new(),
        positions: Vec::new(),
    })
});

/// The desk now and on every change (the host's widgets).
pub fn watch() -> watch::Receiver<Desk> {
    DESK.subscribe()
}

/// The desk now.
pub fn desk() -> Desk {
    DESK.borrow().clone()
}

/// A ticket's question for the host's user (`Trading.confirm`), which the
/// host asks in a dialog of its own and answers through `answer`.
pub struct Confirm {
    /// What to ask.
    pub message: String,
    /// The answer: `true` to go ahead.
    pub answer: oneshot::Sender<bool>,
}

static CONFIRMS: OnceLock<mpsc::UnboundedSender<Confirm>> = OnceLock::new();

/// The questions the tickets ask (`Trading.confirm`), for the host that
/// asks them; one host takes them.
pub fn confirms() -> Option<mpsc::UnboundedReceiver<Confirm>> {
    let (sender, receiver) = mpsc::unbounded_channel();
    CONFIRMS.set(sender).ok().map(|()| receiver)
}

/// The sample price of `symbol`.
pub fn quote(symbol: &str) -> Result<f64, String> {
    let symbol = symbol.trim().to_uppercase();
    SYMBOLS
        .iter()
        .find(|(s, _)| *s == symbol)
        .map(|&(_, price)| price)
        .ok_or_else(|| "Choose AAPL, MSFT or NVDA.".to_owned())
}

/// Selects `symbol` for everyone.
pub fn select(symbol: &str) -> Result<(), String> {
    let price = quote(symbol)?;
    let symbol = symbol.trim().to_uppercase();
    DESK.send_if_modified(|desk| {
        let changed = desk.symbol != symbol;
        desk.symbol = symbol;
        desk.price = price;
        changed
    });
    Ok(())
}

/// Checks an order and adds it to the desk.
pub fn place(symbol: &str, quantity: u32, side: Side, extended: bool) -> Result<Order, String> {
    let price = quote(symbol)?;
    if !(1..=1000).contains(&quantity) {
        return Err("Quantity must be between 1 and 1,000 shares.".into());
    }
    let symbol = symbol.trim().to_uppercase();
    let mut order = None;
    DESK.send_modify(|desk| {
        let placed = Order {
            id: desk.orders.first().map_or(1, |o| o.id + 1),
            side,
            symbol: symbol.clone(),
            quantity,
            price,
            extended,
        };
        desk.orders.insert(0, placed.clone());
        desk.orders.truncate(KEPT);
        let delta = match side {
            Side::Buy => i64::from(quantity),
            Side::Sell => -i64::from(quantity),
        };
        let mut shares: Vec<(&str, i64)> = SYMBOLS.iter().map(|&(s, _)| (s, 0)).collect();
        for p in &desk.positions {
            if let Some(held) = shares.iter_mut().find(|(s, _)| *s == p.symbol) {
                held.1 = p.shares;
            }
        }
        if let Some(held) = shares.iter_mut().find(|(s, _)| *s == symbol) {
            held.1 += delta;
        }
        desk.positions = shares
            .into_iter()
            .filter(|&(_, n)| n != 0)
            .map(|(s, shares)| Position {
                symbol: s.to_owned(),
                shares,
            })
            .collect();
        order = Some(placed);
    });
    Ok(order.expect("the desk was modified"))
}

/// The desk's functions, as the tickets see them.
#[module]
pub struct Trading;

#[module]
impl Trading {
    /// The sample price of `symbol`; throws for symbols the desk does not
    /// trade.
    pub fn quote(symbol: String) -> Result<f64, String> {
        quote(&symbol)
    }

    /// Selects `symbol` in the host and in every ticket.
    pub fn select(symbol: String) -> Result<(), String> {
        select(&symbol)
    }

    /// Checks an order in Rust and adds it to the desk, which every ticket
    /// and the host then show; throws when it is not valid.
    pub fn place_order(
        symbol: String,
        quantity: u32,
        side: Side,
        extended: bool,
    ) -> Result<Order, String> {
        place(&symbol, quantity, side, extended)
    }

    /// Asks the host's user `message` in a dialog of the host (GPUI Kit's)
    /// and resolves with the answer: `true` to go ahead. Where no host
    /// asks (a surface on its own, `--alone`), the answer is yes.
    pub async fn confirm(message: String) -> bool {
        let Some(confirms) = CONFIRMS.get() else {
            return true;
        };
        let (answer, answered) = oneshot::channel();
        if confirms.send(Confirm { message, answer }).is_err() {
            return true;
        }
        // Dropped unanswered (the window closed): no.
        answered.await.unwrap_or(false)
    }

    /// Calls `on_change` with the desk now and after every change, for as
    /// long as the app runs.
    pub async fn subscribe(on_change: Callback<Desk>) {
        let mut desk = DESK.subscribe();
        loop {
            on_change.post(desk.borrow_and_update().clone());
            if desk.changed().await.is_err() {
                return;
            }
        }
    }
}

/// The set the host gives its surfaces (`set_ui_sets`).
pub fn registry() -> Registry {
    let mut registry = Registry::ui_set("host/trading");
    registry.module::<Trading>();
    registry
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_are_checked_and_move_the_positions() {
        assert!(quote("TSLA").is_err());
        assert!(place("AAPL", 0, Side::Buy, false).is_err());
        assert!(place("AAPL", 1001, Side::Buy, false).is_err());
        let first = place(" aapl ", 10, Side::Buy, true).unwrap();
        assert_eq!((first.symbol.as_str(), first.price), ("AAPL", 227.52));
        let second = place("AAPL", 4, Side::Sell, false).unwrap();
        assert_eq!(second.id, first.id + 1);
        let desk = desk();
        assert_eq!(desk.orders[0], second);
        assert_eq!(
            desk.positions,
            [Position {
                symbol: "AAPL".into(),
                shares: 6
            }]
        );
        select("nvda").unwrap();
        assert_eq!(
            (super::desk().symbol.as_str(), super::desk().price),
            ("NVDA", 138.85)
        );
    }
}
