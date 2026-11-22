import { batch, type Signal, signal } from "nsh";
import { colors } from "../../ui";

/** A simulated market: fictional companies whose prices walk every 50 ms.
 * The clock runs 20× real time (a 50 ms tick is one market second), so a
 * one-minute candle closes every three seconds. */

/** Milliseconds between ticks. */
export const TICK_MS = 50;
/** Ticks per real second. */
const PER_SECOND = 1000 / TICK_MS;
/** Market seconds per tick. */
const SECONDS_PER_TICK = 1;
/** 09:30, 16:00 and the market time the demo starts at, in seconds after midnight. */
export const OPEN = 9.5 * 3600;
export const CLOSE = 16 * 3600;
const START = 10 * 3600 + 12 * 60;
/** Minutes in a session. */
export const SESSION = (CLOSE - OPEN) / 60;
/** Levels on each side of the order book. */
export const LEVELS = 10;
/** Trades kept for the tape. */
const TAPE = 40;
/** A trade at least this big is a block (highlighted on the tape). */
export const BLOCK = 8000;
/** The composite's previous close. */
export const INDEX_BASE = 4120.55;
/** Issues in the composite (the listing and the rest, for breadth). */
export const ISSUES = 160;

export type Sector = "tech" | "consumer" | "industry" | "energy" | "health" | "finance";
export const sectors: { id: Sector; label: string }[] = [
  { id: "tech", label: "Technology" },
  { id: "health", label: "Health" },
  { id: "finance", label: "Finance" },
  { id: "consumer", label: "Consumer" },
  { id: "industry", label: "Industrials" },
  { id: "energy", label: "Energy" },
];

/** Order size buckets of the trade flow (shares, inclusive upper bounds). */
export const buckets = [
  { label: "Small", note: "≤ 500", max: 500 },
  { label: "Medium", note: "≤ 2K", max: 2000 },
  { label: "Large", note: "≤ 8K", max: BLOCK - 1 },
  { label: "Block", note: "8K +", max: Infinity },
] as const;

export interface Quote {
  last: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  turnover: number;
  /** Direction of the last change: 1 up, -1 down. */
  dir: number;
  /** Tick of the last change (for the price flash). */
  changedAt: number;
}

export interface Candle {
  /** Start, in market seconds after midnight (days: days before today). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** The day's average price (turnover / volume) at the candle's close. */
  a: number;
}

export interface Level {
  price: number;
  size: number;
}

export interface Book {
  bids: Level[];
  asks: Level[];
}

export interface Trade {
  id: number;
  t: number;
  price: number;
  size: number;
  /** 1: bought at the ask, -1: sold at the bid. */
  side: number;
}

/** Volume bought and sold by order size (`buckets`), of the focused stock. */
export interface Flow {
  buy: number[];
  sell: number[];
}

export interface Breadth {
  up: number;
  down: number;
  flat: number;
  /** Every issue's change in percent, highest first. */
  changes: number[];
}

export interface Stock {
  code: string;
  name: string;
  sector: Sector;
  /** Price step. */
  tick: number;
  quote: Signal<Quote>;
  /** Today's one-minute candles; mutated in place, set on every change. */
  minutes: Signal<Candle[]>;
  /** The days before today, oldest first. */
  days: Candle[];
  /** Per-trade volatility, relative to the price. */
  sigma: number;
  /** Where the price drifts back to. */
  anchor: number;
}

/** The fictional listing: code, name, sector, previous close, volatility. */
const listing: [string, string, Sector, number, number][] = [
  ["ORBX", "Orbex Freight", "industry", 48.2, 0.0009],
  ["KLPW", "Kelpwise Foods", "consumer", 21.35, 0.0007],
  ["VLTG", "Voltgrid Energy", "energy", 112.6, 0.0011],
  ["LUMO", "Lumora Optics", "tech", 236.4, 0.0014],
  ["BRXH", "Brixhill Homes", "consumer", 67.9, 0.0008],
  ["QBFG", "Qubit Forge", "tech", 18.42, 0.0022],
  ["FRNH", "Fernhollow Pharma", "health", 91.05, 0.0012],
  ["HLRB", "Halo Robotics", "tech", 154.8, 0.0016],
  ["MNTP", "Mintpath Payments", "finance", 73.15, 0.0013],
  ["CRGM", "Cragmoor Mining", "energy", 33.6, 0.0015],
  ["TDWS", "Tidewell Shipping", "industry", 26.9, 0.001],
  ["NVSM", "Novasem Devices", "tech", 412.3, 0.0018],
  ["PLMR", "Palmara Resorts", "consumer", 58.75, 0.0009],
  ["STRK", "Starkline Rail", "industry", 84.4, 0.0007],
  ["GLDW", "Goldwing Air", "industry", 15.62, 0.0017],
  ["BKSY", "Bookshy Media", "consumer", 39.1, 0.0012],
  ["CLDP", "Cloudpine Software", "tech", 288.0, 0.0015],
  ["RVNB", "Ravenbrook Bank", "finance", 46.85, 0.0006],
  ["SPRT", "Sprout Grocers", "consumer", 12.04, 0.0011],
  ["ZNTH", "Zenith Biolabs", "health", 64.3, 0.0025],
  ["HRBR", "Harborline Water", "energy", 29.75, 0.0005],
  ["FLKS", "Flakestone Snacks", "consumer", 8.66, 0.0014],
];

/** A seeded generator (mulberry32), so every run starts the same day. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample (Box–Muller). */
function gauss(rand: () => number) {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

const round = (price: number, tick: number) => Math.max(tick, Math.round(price / tick) * tick);

/** Lots of 100 shares, mostly small with a long tail. */
const lotSize = (rand: () => number) => 100 * Math.ceil(-Math.log(rand() || 1e-9) * 6);

/** Builds a stock with 120 days of history and today's minutes up to the
 * start time. */
function makeStock(index: number, [code, name, sector, prevClose, sigma]: (typeof listing)[number]): Stock {
  const rand = random(index * 7919 + 17);
  const tick = prevClose < 10 ? 0.005 : 0.01;
  const days: Candle[] = [];
  let close = prevClose;
  for (let d = 120; d >= 1; d--) {
    const o = close * (1 - gauss(rand) * sigma * 6);
    const c = close;
    const h = Math.max(o, c) * (1 + rand() * sigma * 14);
    const l = Math.min(o, c) * (1 - rand() * sigma * 14);
    days.unshift({ t: d, o: round(o, tick), h: round(h, tick), l: round(l, tick), c: round(c, tick), v: 2e6 + rand() * 6e6, a: c });
    close = o;
  }
  // Today, minute by minute up to the start.
  const minutes: Candle[] = [];
  let price = round(prevClose * (1 + gauss(rand) * sigma * 4), tick);
  const open = price;
  let high = price, low = price, volume = 0, turnover = 0;
  for (let t = OPEN; t < START; t += 60) {
    const o = price;
    let h = o, l = o, v = 0;
    for (let s = 0; s < 60; s += 4) {
      price = round(price + gauss(rand) * sigma * 2 * price - 0.002 * (price - prevClose), tick);
      h = Math.max(h, price);
      l = Math.min(l, price);
      const size = lotSize(rand);
      v += size;
      volume += size;
      turnover += size * price;
    }
    minutes.push({ t, o, h, l, c: price, v, a: turnover / volume });
    high = Math.max(high, h);
    low = Math.min(low, l);
  }
  return {
    code,
    name,
    sector,
    tick,
    sigma,
    anchor: prevClose,
    days,
    quote: signal<Quote>({ last: price, open, high, low, prevClose, volume, turnover, dir: 0, changedAt: -1 }),
    minutes: signal(minutes, { equals: false }),
  };
}

export interface Market {
  stocks: Stock[];
  /** Market time, in seconds after midnight. */
  clock: Signal<number>;
  /** Ticks so far. */
  ticks: Signal<number>;
  /** Counts real seconds while running: the cadence of slow summaries. */
  pulse: Signal<number>;
  running: Signal<boolean>;
  /** The composite now, and one value per minute of today (mutated in place). */
  composite: Signal<number>;
  index: Signal<number[]>;
  /** Advancers and decliners across the composite's issues (every second). */
  breadth: Signal<Breadth>;
  /** The focused stock's book, tape and trade flow (empty without one). */
  book: Signal<Book>;
  trades: Signal<Trade[]>;
  flow: Signal<Flow>;
  /** JS time per tick (ms, averaged over a second) and quotes changed per second. */
  stats: Signal<{ ms: number; updates: number }>;
  start(): void;
  stop(): void;
  /** Keeps the book, the tape and the flow of `stock`, and makes it trade on every tick. */
  focus(stock: Stock | null): void;
}

export function createMarket(): Market {
  const stocks = listing.map((row, i) => makeStock(i, row));
  const rand = random(Date.now() | 0);
  const clock = signal(START);
  const ticks = signal(0);
  const pulse = signal(0);
  const running = signal(false);
  const book = signal<Book>({ bids: [], asks: [] }, { equals: false });
  const trades = signal<Trade[]>([]);
  const flow = signal<Flow>({ buy: [0, 0, 0, 0], sell: [0, 0, 0, 0] }, { equals: false });
  const stats = signal({ ms: 0, updates: 0 });

  // The composite: the listing's mean change, per minute so far.
  const meanChange = () => {
    let sum = 0;
    for (const s of stocks) {
      const q = s.quote();
      sum += (q.last - q.prevClose) / q.prevClose;
    }
    return sum / stocks.length;
  };
  const history: number[] = [];
  const count = stocks[0].minutes().length;
  for (let m = 0; m < count; m++) {
    let sum = 0;
    for (const s of stocks) sum += (s.minutes()[m].c - s.quote().prevClose) / s.quote().prevClose;
    history.push(INDEX_BASE * (1 + sum / stocks.length));
  }
  const composite = signal(INDEX_BASE * (1 + meanChange()));
  const index = signal(history, { equals: false });
  // The issues outside the listing follow the market with their own noise.
  const others = Array.from({ length: ISSUES - stocks.length }, () => meanChange() * 100 * (0.4 + rand()) + gauss(rand) * 0.7);
  const changes = new Array<number>(ISSUES);
  const measureBreadth = (): Breadth => {
    let up = 0, down = 0;
    stocks.forEach((s, i) => {
      const q = s.quote();
      changes[i] = ((q.last - q.prevClose) / q.prevClose) * 100;
    });
    others.forEach((c, i) => (changes[stocks.length + i] = c));
    changes.sort((a, b) => b - a);
    for (const c of changes) {
      if (c > 0.02) up++;
      else if (c < -0.02) down++;
    }
    return { up, down, flat: ISSUES - up - down, changes };
  };
  const breadth = signal(measureBreadth(), { equals: false });

  let focused: Stock | null = null;
  // Resting size by price step (price / tick) of the focused stock, and
  // the size each step drifts back to: the book changes smoothly.
  let depth = new Map<number, number>();
  let targets = new Map<number, number>();
  let tradeId = 0;
  let timer = 0;
  let spent = 0, updates = 0;
  let lastMean = meanChange();

  const restingSize = (step: number) => {
    let size = depth.get(step);
    if (size === undefined) {
      size = lotSize(rand) * (3 + Math.floor(rand() * 6));
      depth.set(step, size);
      targets.set(step, size);
    }
    return size;
  };

  /** Moves the resting sizes around `at` a little toward their targets;
   * now and then a target changes (an order arrives or leaves). */
  const drift = (at: number) => {
    for (let step = at - LEVELS - 1; step <= at + LEVELS + 1; step++) {
      const size = restingSize(step);
      let target = targets.get(step)!;
      if (rand() < 0.004) {
        target = lotSize(rand) * (3 + Math.floor(rand() * 6));
        targets.set(step, target);
      }
      depth.set(step, Math.max(100, size + (target - size) * 0.06 + gauss(rand) * target * 0.012));
    }
  };

  /** Rebuilds the book's levels around the best bid and ask. */
  const layBook = (stock: Stock, bid: number, ask: number) => {
    const b = book();
    const bidStep = Math.round(bid / stock.tick), askStep = Math.round(ask / stock.tick);
    for (let i = 0; i < LEVELS; i++) {
      const bl = b.bids[i] ?? (b.bids[i] = { price: 0, size: 0 });
      bl.price = (bidStep - i) * stock.tick;
      bl.size = Math.round(restingSize(bidStep - i) / 100) * 100;
      const al = b.asks[i] ?? (b.asks[i] = { price: 0, size: 0 });
      al.price = (askStep + i) * stock.tick;
      al.size = Math.round(restingSize(askStep + i) / 100) * 100;
    }
    book.set(b);
  };

  const bucketOf = (size: number) => {
    let k = 0;
    while (size > buckets[k].max) k++;
    return k;
  };

  const step = () => {
    const began = performance.now();
    const n = ticks() + 1;
    const now = clock() + SECONDS_PER_TICK;
    const tape: Trade[] = [];
    const f = flow();
    batch(() => {
      ticks.set(n);
      clock.set(now);
      let mean = 0;
      for (const stock of stocks) {
        const isFocused = stock === focused;
        const q = stock.quote();
        if (!isFocused && rand() > 0.3) {
          mean += (q.last - q.prevClose) / q.prevClose;
          continue;
        }
        let { last, high, low, volume, turnover } = q;
        const count = isFocused ? 1 + Math.floor(rand() * 3) : 1;
        let side = 1;
        for (let k = 0; k < count; k++) {
          const move = gauss(rand) * stock.sigma * last - 0.003 * (last - stock.anchor);
          const next = round(last + move, stock.tick);
          side = next > last ? 1 : next < last ? -1 : rand() < 0.5 ? 1 : -1;
          last = next;
          let size = lotSize(rand);
          // Now and then an institution trades the focused stock in size.
          if (isFocused && rand() < 0.035) size *= 8 + Math.floor(rand() * 16);
          volume += size;
          turnover += size * last;
          high = Math.max(high, last);
          low = Math.min(low, last);
          if (isFocused) {
            tape.push({ id: ++tradeId, t: now, price: last, size, side });
            (side > 0 ? f.buy : f.sell)[bucketOf(size)] += size;
            const at = Math.round(last / stock.tick);
            // A trade takes some of the level; it refills toward its target.
            depth.set(at, Math.max(100, restingSize(at) - size * 0.3));
          }
        }
        // The anchor wanders too, so the day has a trend.
        stock.anchor += gauss(rand) * stock.sigma * 0.2 * stock.anchor;
        const dir = last > q.last ? 1 : last < q.last ? -1 : q.dir;
        stock.quote.set({ ...q, last, high, low, volume, turnover, dir, changedAt: last !== q.last ? n : q.changedAt });
        mean += (last - q.prevClose) / q.prevClose;
        updates++;

        // Today's minute candle.
        const minutes = stock.minutes();
        const start = now - ((now - OPEN) % 60);
        const current = minutes[minutes.length - 1];
        const traded = volume - q.volume;
        const a = turnover / volume;
        if (current && current.t === start) {
          current.h = Math.max(current.h, last);
          current.l = Math.min(current.l, last);
          current.c = last;
          current.v += traded;
          current.a = a;
        } else {
          minutes.push({ t: start, o: q.last, h: Math.max(q.last, last), l: Math.min(q.last, last), c: last, v: traded, a });
        }
        stock.minutes.set(minutes);

        if (isFocused) {
          // The resting orders drift; the book follows the last trade.
          drift(Math.round(last / stock.tick));
          layBook(stock, side > 0 ? last - stock.tick : last, side > 0 ? last : last + stock.tick);
        }
      }
      mean /= stocks.length;

      // The composite: a new point each market minute, the last one moves.
      const level = INDEX_BASE * (1 + mean);
      composite.set(level);
      const points = index();
      const minute = Math.floor((now - OPEN) / 60);
      const added = minute >= points.length;
      if (added) points.push(level);
      else points[points.length - 1] = level;
      // The chart redraws five times a second, not on every tick.
      if (added || n % 4 === 0) index.set(points);

      if (tape.length) trades.set([...tape.reverse(), ...trades()].slice(0, TAPE));

      if (n % PER_SECOND === 0) {
        const moved = (mean - lastMean) * 100;
        lastMean = mean;
        for (let i = 0; i < others.length; i++) {
          others[i] += moved * (0.5 + (i % 7) / 7) + gauss(rand) * 0.035 - 0.004 * others[i];
        }
        breadth.set(measureBreadth());
        if (focused) flow.set(f);
        pulse.set(pulse() + 1);
      }
    });
    spent += performance.now() - began;
    if (n % PER_SECOND === 0) {
      stats.set({ ms: spent / PER_SECOND, updates });
      spent = 0;
      updates = 0;
    }
  };

  return {
    stocks,
    clock,
    ticks,
    pulse,
    running,
    composite,
    index,
    breadth,
    book,
    trades,
    flow,
    stats,
    start() {
      if (timer) return;
      timer = setInterval(step, TICK_MS);
      running.set(true);
    },
    stop() {
      clearInterval(timer);
      timer = 0;
      running.set(false);
    },
    focus(stock) {
      focused = stock;
      depth = new Map();
      targets = new Map();
      trades.set([]);
      if (stock) {
        const q = stock.quote();
        layBook(stock, q.last - stock.tick, q.last);
        // The morning so far, split by order size with a slight buy lean.
        const shares = [0.34, 0.31, 0.21, 0.14];
        flow.set({
          buy: shares.map((s) => Math.round(q.volume * s * (0.48 + rand() * 0.1))),
          sell: shares.map((s) => Math.round(q.volume * s * (0.44 + rand() * 0.1))),
        });
      } else {
        book.set({ bids: [], asks: [] });
      }
    },
  };
}

/** `HH:MM:SS` of a market time. */
export function time(seconds: number, withSeconds = true) {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const s = Math.floor(seconds);
  const hm = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
  return withSeconds ? `${hm}:${pad(s % 60)}` : hm;
}

/** A price with the stock's decimals. */
export const price = (value: number, stock: Stock) => value.toFixed(stock.tick < 0.01 ? 3 : 2);

/** `1,234,567.89` (QuickJS has no `Intl`). */
export function grouped(value: number, decimals = 2) {
  const [whole, fraction] = Math.abs(value).toFixed(decimals).split(".");
  let out = "";
  for (let i = 0; i < whole.length; i++) {
    if (i && (whole.length - i) % 3 === 0) out += ",";
    out += whole[i];
  }
  return `${value < 0 ? "-" : ""}${out}${fraction ? `.${fraction}` : ""}`;
}

/** 1.23M, 45.6K. */
export function compact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** `+1.23` / `-1.23`: an explicit sign. */
export const signed = (value: number, decimals = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}`;

/** Change against the previous close, in percent. */
export const percent = (q: Quote) => ((q.last - q.prevClose) / q.prevClose) * 100;

/** Rising, falling and flat colors. */
export const toneOf = (value: number) => (value > 0 ? colors.up : value < 0 ? colors.down : colors.muted);
