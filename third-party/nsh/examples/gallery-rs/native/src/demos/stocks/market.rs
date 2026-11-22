//! A simulated market (as the TSX gallery's `demos/stocks/market.ts`):
//! fictional companies whose prices walk every 50 ms. The clock runs 20×
//! real time (a 50 ms tick is one market second), so a one-minute candle
//! closes every three seconds.
//!
//! The market is plain data the watchlist owns and steps; what moved goes
//! to the views as signals ([`super::Live`]), at the cadence of each part:
//! the quotes (and with the focused stock's, its chart and its book) every
//! tick, the tape and the depth chart four times a second, the flow, the
//! ranges and the stats once a second.

use std::{collections::HashMap, rc::Rc};

use nsh_core::{
    element::{AdaptiveColor, JsObject},
    time::Instant,
};

use crate::ui::colors;

/// Milliseconds between ticks.
pub(crate) const TICK_MS: u64 = 50;
/// Ticks per real second.
const PER_SECOND: u64 = 1000 / TICK_MS;
/// Market seconds per tick.
const SECONDS_PER_TICK: f64 = 1.0;
/// 09:30, 16:00 and the market time the demo starts at, in seconds after
/// midnight.
pub(crate) const OPEN: f64 = 9.5 * 3600.0;
const CLOSE: f64 = 16.0 * 3600.0;
const START: f64 = 10.0 * 3600.0 + 12.0 * 60.0;
/// Minutes in a session.
pub(crate) const SESSION: f64 = (CLOSE - OPEN) / 60.0;
/// Levels on each side of the order book.
pub(crate) const LEVELS: usize = 10;
/// Trades kept for the tape.
pub(crate) const TAPE: usize = 40;
/// Trades the tape's canvas holds: the rows shown and four more that slide
/// out.
pub(crate) const TAPE_HELD: usize = 12;
/// A trade at least this big is a block (highlighted on the tape).
pub(crate) const BLOCK: f64 = 8000.0;
/// The composite's previous close.
pub(crate) const INDEX_BASE: f64 = 4120.55;
/// Issues in the composite (the listing and the rest, for breadth).
pub(crate) const ISSUES: usize = 160;
/// Days of history.
const DAYS: usize = 120;

/// What a company does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sector {
    Tech,
    Consumer,
    Industry,
    Energy,
    Health,
    Finance,
}

/// The sectors in the order breadth lists them, with their labels.
pub(crate) const SECTORS: [(Sector, &str); 6] = [
    (Sector::Tech, "Technology"),
    (Sector::Health, "Health"),
    (Sector::Finance, "Finance"),
    (Sector::Consumer, "Consumer"),
    (Sector::Industry, "Industrials"),
    (Sector::Energy, "Energy"),
];

impl Sector {
    /// Its label.
    pub(crate) fn label(self) -> &'static str {
        SECTORS.iter().find(|(s, _)| *s == self).map_or("", |s| s.1)
    }
}

/// An order size bucket of the trade flow: its label, a note, and its
/// inclusive upper bound in shares.
pub(crate) struct Bucket {
    pub(crate) label: &'static str,
    pub(crate) note: &'static str,
    max: f64,
}

/// The trade flow's buckets.
pub(crate) const BUCKETS: [Bucket; 4] = [
    Bucket {
        label: "Small",
        note: "≤ 500",
        max: 500.0,
    },
    Bucket {
        label: "Medium",
        note: "≤ 2K",
        max: 2000.0,
    },
    Bucket {
        label: "Large",
        note: "≤ 8K",
        max: BLOCK - 1.0,
    },
    Bucket {
        label: "Block",
        note: "8K +",
        max: f64::INFINITY,
    },
];

/// A stock's quote.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Quote {
    pub(crate) last: f64,
    pub(crate) open: f64,
    pub(crate) high: f64,
    pub(crate) low: f64,
    pub(crate) prev_close: f64,
    pub(crate) volume: f64,
    pub(crate) turnover: f64,
    /// Direction of the last change: 1 up, -1 down.
    pub(crate) dir: f64,
    /// Tick of the last change (-1: none yet).
    pub(crate) changed_at: i64,
}

impl Quote {
    /// Change against the previous close, in percent.
    pub(crate) fn percent(&self) -> f64 {
        (self.last - self.prev_close) / self.prev_close * 100.0
    }
}

/// A candle.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Candle {
    /// Start, in market seconds after midnight (days: days before today).
    pub(crate) t: f64,
    pub(crate) o: f64,
    pub(crate) h: f64,
    pub(crate) l: f64,
    pub(crate) c: f64,
    pub(crate) v: f64,
    /// The day's average price (turnover / volume) at the candle's close.
    pub(crate) a: f64,
}

/// A level of the order book.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Level {
    pub(crate) price: f64,
    pub(crate) size: f64,
}

/// A trade.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Trade {
    pub(crate) id: u64,
    pub(crate) t: f64,
    pub(crate) price: f64,
    pub(crate) size: f64,
    /// 1: bought at the ask, -1: sold at the bid.
    pub(crate) side: f64,
}

/// The order book.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Book {
    pub(crate) bids: Vec<Level>,
    pub(crate) asks: Vec<Level>,
}

/// Volume bought and sold by order size ([`BUCKETS`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Flow {
    pub(crate) buy: [f64; 4],
    pub(crate) sell: [f64; 4],
}

/// Advancers and decliners across the composite's issues.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Breadth {
    pub(crate) up: u32,
    pub(crate) down: u32,
    pub(crate) flat: u32,
}

/// The time a tick takes (ms, averaged over a second) and the quotes
/// changed per second.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Stats {
    pub(crate) ms: f64,
    pub(crate) updates: u32,
}

/// A range over the last `n` days, today included.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Range {
    pub(crate) n: u32,
    pub(crate) lo: f64,
    pub(crate) hi: f64,
}

/// The day spans the ranges show.
pub(crate) const HORIZONS: [u32; 4] = [5, 20, 60, 120];

/// A stock.
#[derive(Debug, Clone)]
pub(crate) struct Stock {
    pub(crate) code: &'static str,
    pub(crate) name: &'static str,
    pub(crate) sector: Sector,
    /// Price step.
    pub(crate) tick: f64,
    pub(crate) quote: Quote,
    /// Today's one-minute candles.
    pub(crate) minutes: Vec<Candle>,
    /// The days before today, oldest first.
    pub(crate) days: Rc<[Candle]>,
    /// Today's sparkline: a smooth moving average ending at the last trade.
    pub(crate) spark: Vec<f64>,
    /// Per-trade volatility, relative to the price.
    sigma: f64,
    /// Where the price drifts back to.
    anchor: f64,
}

/// Points a sparkline draws: few enough for a calm, readable curve.
const SPARK_POINTS: usize = 24;
/// Minutes each sparkline point averages over.
const SPARK_SMOOTH: usize = 4;

impl Stock {
    /// Each point: the mean close of the minutes before it; the newest
    /// point is the last trade.
    fn smooth(&mut self) {
        let minutes = &self.minutes;
        let n = SPARK_POINTS.min(minutes.len());
        self.spark.clear();
        for k in 0..n {
            let end =
                ((k as f64 / (n.max(2) - 1) as f64) * (minutes.len() - 1) as f64).round() as usize;
            let start = (end + 1).saturating_sub(SPARK_SMOOTH);
            let sum: f64 = minutes[start..=end].iter().map(|m| m.c).sum();
            self.spark.push(sum / (end - start + 1) as f64);
        }
        if let Some(last) = self.spark.last_mut() {
            *last = self.quote.last;
        }
    }

    /// Decimals of its prices.
    pub(crate) fn decimals(&self) -> u32 {
        decimals(self.tick)
    }
}

/// Decimals of prices with step `tick`.
pub(crate) fn decimals(tick: f64) -> u32 {
    if tick < 0.01 { 3 } else { 2 }
}

/// The fictional listing: code, name, sector, previous close, volatility.
const LISTING: [(&str, &str, Sector, f64, f64); 22] = [
    ("ORBX", "Orbex Freight", Sector::Industry, 48.2, 0.0009),
    ("KLPW", "Kelpwise Foods", Sector::Consumer, 21.35, 0.0007),
    ("VLTG", "Voltgrid Energy", Sector::Energy, 112.6, 0.0011),
    ("LUMO", "Lumora Optics", Sector::Tech, 236.4, 0.0014),
    ("BRXH", "Brixhill Homes", Sector::Consumer, 67.9, 0.0008),
    ("QBFG", "Qubit Forge", Sector::Tech, 18.42, 0.0022),
    ("FRNH", "Fernhollow Pharma", Sector::Health, 91.05, 0.0012),
    ("HLRB", "Halo Robotics", Sector::Tech, 154.8, 0.0016),
    ("MNTP", "Mintpath Payments", Sector::Finance, 73.15, 0.0013),
    ("CRGM", "Cragmoor Mining", Sector::Energy, 33.6, 0.0015),
    ("TDWS", "Tidewell Shipping", Sector::Industry, 26.9, 0.001),
    ("NVSM", "Novasem Devices", Sector::Tech, 412.3, 0.0018),
    ("PLMR", "Palmara Resorts", Sector::Consumer, 58.75, 0.0009),
    ("STRK", "Starkline Rail", Sector::Industry, 84.4, 0.0007),
    ("GLDW", "Goldwing Air", Sector::Industry, 15.62, 0.0017),
    ("BKSY", "Bookshy Media", Sector::Consumer, 39.1, 0.0012),
    ("CLDP", "Cloudpine Software", Sector::Tech, 288.0, 0.0015),
    ("RVNB", "Ravenbrook Bank", Sector::Finance, 46.85, 0.0006),
    ("SPRT", "Sprout Grocers", Sector::Consumer, 12.04, 0.0011),
    ("ZNTH", "Zenith Biolabs", Sector::Health, 64.3, 0.0025),
    ("HRBR", "Harborline Water", Sector::Energy, 29.75, 0.0005),
    ("FLKS", "Flakestone Snacks", Sector::Consumer, 8.66, 0.0014),
];

/// A seeded generator (mulberry32, as the TSX demo's), so every run starts
/// the same day.
#[derive(Debug, Clone)]
struct Random(u32);

impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// A standard normal sample (Box–Muller).
    fn gauss(&mut self) -> f64 {
        let a = self.next();
        let b = self.next();
        (-2.0 * if a == 0.0 { 1e-9 } else { a }.ln()).sqrt()
            * (2.0 * std::f64::consts::PI * b).cos()
    }

    /// Lots of 100 shares, mostly small with a long tail.
    fn lot(&mut self) -> f64 {
        let r = self.next();
        100.0 * (-if r == 0.0 { 1e-9 } else { r }.ln() * 6.0).ceil()
    }
}

fn round(price: f64, tick: f64) -> f64 {
    tick.max((price / tick).round() * tick)
}

/// Builds a stock with 120 days of history and today's minutes up to the
/// start time.
fn make_stock(
    index: usize,
    (code, name, sector, prev_close, sigma): (&'static str, &'static str, Sector, f64, f64),
) -> Stock {
    let mut rand = Random((index as u32).wrapping_mul(7919).wrapping_add(17));
    let tick = if prev_close < 10.0 { 0.005 } else { 0.01 };
    let mut days = Vec::with_capacity(DAYS);
    let mut close = prev_close;
    for d in (1..=DAYS).rev() {
        let o = close * (1.0 - rand.gauss() * sigma * 6.0);
        let c = close;
        let h = o.max(c) * (1.0 + rand.next() * sigma * 14.0);
        let l = o.min(c) * (1.0 - rand.next() * sigma * 14.0);
        let v = 2e6 + rand.next() * 6e6;
        days.push(Candle {
            t: d as f64,
            o: round(o, tick),
            h: round(h, tick),
            l: round(l, tick),
            c: round(c, tick),
            v,
            a: c,
        });
        close = o;
    }
    days.reverse();
    // Today, minute by minute up to the start.
    let mut minutes = Vec::new();
    let mut price = round(prev_close * (1.0 + rand.gauss() * sigma * 4.0), tick);
    let open = price;
    let (mut high, mut low, mut volume, mut turnover) = (price, price, 0.0, 0.0);
    let mut t = OPEN;
    while t < START {
        let o = price;
        let (mut h, mut l, mut v) = (o, o, 0.0);
        for _ in 0..15 {
            price = round(
                price + rand.gauss() * sigma * 2.0 * price - 0.002 * (price - prev_close),
                tick,
            );
            h = h.max(price);
            l = l.min(price);
            let size = rand.lot();
            v += size;
            volume += size;
            turnover += size * price;
        }
        minutes.push(Candle {
            t,
            o,
            h,
            l,
            c: price,
            v,
            a: turnover / volume,
        });
        high = high.max(h);
        low = low.min(l);
        t += 60.0;
    }
    let mut stock = Stock {
        code,
        name,
        sector,
        tick,
        quote: Quote {
            last: price,
            open,
            high,
            low,
            prev_close,
            volume,
            turnover,
            dir: 0.0,
            changed_at: -1,
        },
        minutes,
        days: days.into(),
        spark: Vec::new(),
        sigma,
        anchor: prev_close,
    };
    stock.smooth();
    stock
}

/// The market.
pub(crate) struct Market {
    pub(crate) stocks: Vec<Stock>,
    rand: Random,
    /// Market time, in seconds after midnight.
    pub(crate) clock: f64,
    /// Ticks so far.
    pub(crate) ticks: u64,
    /// The composite now.
    pub(crate) composite: f64,
    /// Advancers and decliners (every second).
    pub(crate) breadth: Breadth,
    /// Each sector's mean change in percent, as [`SECTORS`] (every second).
    pub(crate) sectors: [f64; 6],
    /// The stock whose book, tape and flow are kept, which trades every
    /// tick.
    pub(crate) focused: Option<usize>,
    /// The focused stock's book.
    pub(crate) book: Book,
    /// The book as of the last quarter second (the depth chart's).
    pub(crate) depth: Book,
    /// The focused stock's trades, newest first.
    pub(crate) trades: Vec<Trade>,
    /// The newest trades as of the last quarter second (the tape's).
    pub(crate) tape: Vec<Trade>,
    /// The trade flow as of the last second.
    pub(crate) flow: Flow,
    /// The focused stock's ranges as of the last second, and its quote
    /// then.
    pub(crate) ranges: (Vec<Range>, Quote),
    /// The time per tick and the quotes per second (every second).
    pub(crate) stats: Stats,
    others: Vec<f64>,
    flowing: Flow,
    /// Resting size by price step of the focused stock, and the size each
    /// step drifts back to: the book changes smoothly.
    resting: HashMap<i64, f64>,
    targets: HashMap<i64, f64>,
    trade_id: u64,
    spent: f64,
    updates: u32,
    last_mean: f64,
}

impl Market {
    /// The listing at the start time.
    pub(crate) fn new() -> Self {
        let stocks: Vec<Stock> = LISTING
            .iter()
            .enumerate()
            .map(|(i, row)| make_stock(i, *row))
            .collect();
        let seed = nsh_core::time::unix_ms() as u64 as u32;
        let mut market = Self {
            stocks,
            rand: Random(seed),
            clock: START,
            ticks: 0,
            composite: 0.0,
            breadth: Breadth::default(),
            sectors: [0.0; 6],
            focused: None,
            book: Book::default(),
            depth: Book::default(),
            trades: Vec::new(),
            tape: Vec::new(),
            flow: Flow::default(),
            ranges: (Vec::new(), Quote::default()),
            stats: Stats::default(),
            others: Vec::new(),
            flowing: Flow::default(),
            resting: HashMap::new(),
            targets: HashMap::new(),
            trade_id: 0,
            spent: 0.0,
            updates: 0,
            last_mean: 0.0,
        };
        let mean = market.mean_change();
        market.composite = INDEX_BASE * (1.0 + mean);
        market.last_mean = mean;
        // The issues outside the listing follow the market with their own
        // noise.
        market.others = (0..ISSUES - market.stocks.len())
            .map(|_| {
                let r = market.rand.next();
                mean * 100.0 * (0.4 + r) + market.rand.gauss() * 0.7
            })
            .collect();
        market.measure();
        market
    }

    fn mean_change(&self) -> f64 {
        let sum: f64 = self
            .stocks
            .iter()
            .map(|s| (s.quote.last - s.quote.prev_close) / s.quote.prev_close)
            .sum();
        sum / self.stocks.len() as f64
    }

    /// Breadth and the sectors' moves.
    fn measure(&mut self) {
        let (mut up, mut down) = (0, 0);
        let changes = self
            .stocks
            .iter()
            .map(|s| s.quote.percent())
            .chain(self.others.iter().copied());
        for c in changes {
            if c > 0.02 {
                up += 1;
            } else if c < -0.02 {
                down += 1;
            }
        }
        self.breadth = Breadth {
            up,
            down,
            flat: ISSUES as u32 - up - down,
        };
        for (i, (sector, _)) in SECTORS.iter().enumerate() {
            let members: Vec<f64> = self
                .stocks
                .iter()
                .filter(|s| s.sector == *sector)
                .map(|s| s.quote.percent())
                .collect();
            self.sectors[i] = members.iter().sum::<f64>() / members.len() as f64;
        }
    }

    fn resting_size(&mut self, step: i64) -> f64 {
        if let Some(size) = self.resting.get(&step) {
            return *size;
        }
        let size = self.rand.lot() * (3.0 + (self.rand.next() * 6.0).floor());
        self.resting.insert(step, size);
        self.targets.insert(step, size);
        size
    }

    /// Moves the resting sizes around `at` a little toward their targets;
    /// now and then a target changes (an order arrives or leaves).
    fn drift(&mut self, at: i64) {
        for step in at - LEVELS as i64 - 1..=at + LEVELS as i64 + 1 {
            let size = self.resting_size(step);
            let mut target = self.targets[&step];
            if self.rand.next() < 0.004 {
                target = self.rand.lot() * (3.0 + (self.rand.next() * 6.0).floor());
                self.targets.insert(step, target);
            }
            let next = size + (target - size) * 0.06 + self.rand.gauss() * target * 0.012;
            self.resting.insert(step, next.max(100.0));
        }
    }

    /// Rebuilds the book's levels around the best bid and ask.
    fn lay_book(&mut self, tick: f64, bid: f64, ask: f64) {
        let (bid_step, ask_step) = ((bid / tick).round() as i64, (ask / tick).round() as i64);
        let mut book = std::mem::take(&mut self.book);
        book.bids.resize(LEVELS, Level::default());
        book.asks.resize(LEVELS, Level::default());
        for i in 0..LEVELS {
            let step = bid_step - i as i64;
            book.bids[i] = Level {
                price: step as f64 * tick,
                size: (self.resting_size(step) / 100.0).round() * 100.0,
            };
            let step = ask_step + i as i64;
            book.asks[i] = Level {
                price: step as f64 * tick,
                size: (self.resting_size(step) / 100.0).round() * 100.0,
            };
        }
        self.book = book;
    }

    /// The ranges of the focused stock now.
    fn measure_ranges(&mut self) {
        let Some(i) = self.focused else { return };
        let stock = &self.stocks[i];
        let q = stock.quote;
        let rows = HORIZONS
            .iter()
            .map(|&n| {
                let from = stock.days.len().saturating_sub(n as usize);
                let (lo, hi) = stock.days[from..]
                    .iter()
                    .fold((q.low, q.high), |(lo, hi), d| (lo.min(d.l), hi.max(d.h)));
                Range { n, lo, hi }
            })
            .collect();
        self.ranges = (rows, q);
    }

    /// Keeps the book, the tape and the flow of stock `stock` (or none),
    /// and makes it trade on every tick.
    pub(crate) fn focus(&mut self, stock: Option<usize>) {
        self.focused = stock;
        self.resting.clear();
        self.targets.clear();
        self.trades.clear();
        self.tape.clear();
        match stock {
            Some(i) => {
                let (q, tick) = (self.stocks[i].quote, self.stocks[i].tick);
                self.lay_book(tick, q.last - tick, q.last);
                self.depth = self.book.clone();
                // The morning so far, split by order size with a slight buy
                // lean.
                let shares = [0.34, 0.31, 0.21, 0.14];
                let mut flow = Flow::default();
                for (k, s) in shares.iter().enumerate() {
                    flow.buy[k] = (q.volume * s * (0.48 + self.rand.next() * 0.1)).round();
                }
                for (k, s) in shares.iter().enumerate() {
                    flow.sell[k] = (q.volume * s * (0.44 + self.rand.next() * 0.1)).round();
                }
                self.flowing = flow.clone();
                self.flow = flow;
                self.measure_ranges();
            }
            None => {
                self.book = Book::default();
                self.depth = Book::default();
            }
        }
    }

    /// One tick: every stock may trade (the focused one always does), the
    /// clock moves a market second.
    pub(crate) fn step(&mut self) {
        let began = Instant::now();
        let n = self.ticks + 1;
        let now = self.clock + SECONDS_PER_TICK;
        self.ticks = n;
        self.clock = now;
        let mut tape = Vec::new();
        let mut mean = 0.0;
        for index in 0..self.stocks.len() {
            let focused = self.focused == Some(index);
            let q = self.stocks[index].quote;
            if !focused && self.rand.next() > 0.3 {
                mean += (q.last - q.prev_close) / q.prev_close;
                continue;
            }
            let (sigma, tick) = (self.stocks[index].sigma, self.stocks[index].tick);
            let (mut last, mut high, mut low, mut volume, mut turnover) =
                (q.last, q.high, q.low, q.volume, q.turnover);
            let count = if focused {
                1 + (self.rand.next() * 3.0).floor() as usize
            } else {
                1
            };
            for _ in 0..count {
                let anchor = self.stocks[index].anchor;
                let step = self.rand.gauss() * sigma * last - 0.003 * (last - anchor);
                let next = round(last + step, tick);
                let side = if next > last {
                    1.0
                } else if next < last {
                    -1.0
                } else if self.rand.next() < 0.5 {
                    1.0
                } else {
                    -1.0
                };
                last = next;
                let mut size = self.rand.lot();
                // Now and then an institution trades the focused stock in
                // size.
                if focused && self.rand.next() < 0.035 {
                    size *= 8.0 + (self.rand.next() * 16.0).floor();
                }
                volume += size;
                turnover += size * last;
                high = high.max(last);
                low = low.min(last);
                if focused {
                    self.trade_id += 1;
                    tape.push(Trade {
                        id: self.trade_id,
                        t: now,
                        price: last,
                        size,
                        side,
                    });
                    let bucket = BUCKETS.iter().position(|b| size <= b.max).unwrap_or(3);
                    if side > 0.0 {
                        self.flowing.buy[bucket] += size;
                    } else {
                        self.flowing.sell[bucket] += size;
                    }
                    let at = (last / tick).round() as i64;
                    // A trade takes some of the level; it refills toward its
                    // target.
                    let left = (self.resting_size(at) - size * 0.3).max(100.0);
                    self.resting.insert(at, left);
                }
            }
            // The anchor wanders too, so the day has a trend.
            let wander = self.rand.gauss() * sigma * 0.2;
            let stock = &mut self.stocks[index];
            stock.anchor += wander * stock.anchor;
            let dir = if last > q.last {
                1.0
            } else if last < q.last {
                -1.0
            } else {
                q.dir
            };
            stock.quote = Quote {
                last,
                high,
                low,
                volume,
                turnover,
                dir,
                changed_at: if last != q.last {
                    n as i64
                } else {
                    q.changed_at
                },
                ..q
            };
            mean += (last - q.prev_close) / q.prev_close;
            self.updates += 1;

            // Today's minute candle.
            let start = now - (now - OPEN) % 60.0;
            let traded = volume - q.volume;
            let a = turnover / volume;
            match stock.minutes.last_mut() {
                Some(current) if current.t == start => {
                    current.h = current.h.max(last);
                    current.l = current.l.min(last);
                    current.c = last;
                    current.v += traded;
                    current.a = a;
                }
                _ => stock.minutes.push(Candle {
                    t: start,
                    o: q.last,
                    h: q.last.max(last),
                    l: q.last.min(last),
                    c: last,
                    v: traded,
                    a,
                }),
            }
            stock.smooth();

            if focused {
                // The resting orders drift; the book follows the last trade.
                self.drift((last / tick).round() as i64);
                let up = side_of(&tape) > 0.0;
                let (bid, ask) = if up {
                    (last - tick, last)
                } else {
                    (last, last + tick)
                };
                self.lay_book(tick, bid, ask);
            }
        }
        mean /= self.stocks.len() as f64;
        self.composite = INDEX_BASE * (1.0 + mean);

        if !tape.is_empty() {
            tape.reverse();
            tape.extend(self.trades.iter().copied());
            tape.truncate(TAPE);
            self.trades = tape;
        }
        // The tape and the depth chart redraw four times a second.
        if self.focused.is_some() && n.is_multiple_of(5) {
            self.tape = self.trades.iter().take(TAPE_HELD).copied().collect();
            self.depth = self.book.clone();
        }
        if n.is_multiple_of(PER_SECOND) {
            let moved = (mean - self.last_mean) * 100.0;
            self.last_mean = mean;
            for i in 0..self.others.len() {
                let noise = self.rand.gauss();
                let other = &mut self.others[i];
                *other += moved * (0.5 + (i % 7) as f64 / 7.0) + noise * 0.035 - 0.004 * *other;
            }
            self.measure();
            if self.focused.is_some() {
                self.flow = self.flowing.clone();
                self.measure_ranges();
            }
        }
        self.spent += began.elapsed().as_secs_f64() * 1000.0;
        if n.is_multiple_of(PER_SECOND) {
            self.stats = Stats {
                ms: self.spent / PER_SECOND as f64,
                updates: self.updates,
            };
            self.spent = 0.0;
            self.updates = 0;
        }
    }

    /// Whether this tick starts a second (the slow summaries changed).
    pub(crate) fn on_second(&self) -> bool {
        self.ticks.is_multiple_of(PER_SECOND)
    }
}

/// The side of the last trade of this tick's (in trade order).
fn side_of(tape: &[Trade]) -> f64 {
    tape.last().map_or(1.0, |t| t.side)
}

/// `HH:MM:SS` (or `HH:MM`) of a market time.
pub(crate) fn time(seconds: f64, with_seconds: bool) -> String {
    let s = seconds.floor() as i64;
    let hm = format!("{:02}:{:02}", s / 3600, (s % 3600) / 60);
    if with_seconds {
        format!("{hm}:{:02}", s % 60)
    } else {
        hm
    }
}

/// A price with `decimals` decimals.
pub(crate) fn price(value: f64, decimals: u32) -> String {
    format!("{value:.*}", decimals as usize)
}

/// `1,234,567.89`.
pub(crate) fn grouped(value: f64, decimals: usize) -> String {
    let fixed = format!("{:.*}", decimals, value.abs());
    let (whole, fraction) = fixed.split_once('.').unwrap_or((&fixed, ""));
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    let sign = if value < 0.0 { "-" } else { "" };
    if fraction.is_empty() {
        format!("{sign}{out}")
    } else {
        format!("{sign}{out}.{fraction}")
    }
}

/// 1.23M, 45.6K.
pub(crate) fn compact(n: f64) -> String {
    let a = n.abs();
    if a >= 1e9 {
        format!("{:.2}B", n / 1e9)
    } else if a >= 1e6 {
        format!("{:.2}M", n / 1e6)
    } else if a >= 1e4 {
        format!("{:.1}K", n / 1e3)
    } else {
        format!("{}", n.round())
    }
}

/// `+1.23` / `-1.23`: an explicit sign.
pub(crate) fn signed(value: f64, decimals: usize) -> String {
    let sign = if value >= 0.0 { "+" } else { "" };
    format!("{sign}{value:.decimals$}")
}

/// Rising, falling and flat colors.
pub(crate) fn tone_of(value: f64) -> AdaptiveColor {
    if value > 0.0 {
        colors::UP
    } else if value < 0.0 {
        colors::DOWN
    } else {
        colors::MUTED
    }
}
