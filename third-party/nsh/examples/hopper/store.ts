import { computed, signal } from "nsh";

// Hopper Lab: hop tests of a small reusable lander. All data is made up.

/** A deterministic generator, so the sample history is the same every launch. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const rand = random(11);
/** A normally distributed sample (Box–Muller). */
const normal = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-6))) * Math.cos(2 * Math.PI * rand());

const minute = 60_000;
const start = Date.now();

/** How a hop ended. */
export type Outcome = "nominal" | "hard" | "abort";

export interface Hop {
  id: number;
  outcome: Outcome;
  /** What was tested or what went wrong. */
  note: string;
  /** Highest point reached (m). */
  apogee: number;
  /** When it landed (ms since the epoch). */
  at: number;
}

/** Where a hop touched down, relative to the pad's center (m). */
export interface Touchdown {
  x: number;
  y: number;
}

const notes = ["hover 12 s", "hover 15 s", "translate 8 m", "apogee 120 m", "gimbal sweep", "night profile"];
const failures: Record<number, [Outcome, string]> = {
  6: ["abort", "throttle low"],
  17: ["hard", "leg sensor"],
  23: ["abort", "tilt 7°"],
  31: ["hard", "gimbal sat."],
};

export const hops = signal<Hop[]>(
  Array.from({ length: 40 }, (_, i) => {
    const id = i + 1;
    const [outcome, note] = failures[id] ?? ["nominal", notes[Math.floor(rand() * notes.length)]];
    return {
      id,
      outcome,
      note,
      apogee: outcome === "abort" ? 20 + rand() * 30 : 70 + rand() * 80,
      at: start - (40 - id) * 7 * minute - Math.floor(rand() * 3 * minute),
    };
  }),
);

export const touchdowns = signal<Touchdown[]>(
  Array.from({ length: 90 }, () => ({ x: 0.15 + normal() * 0.6, y: -0.1 + normal() * 0.45 })).concat([
    { x: 2.9, y: 1.4 },
    { x: -2.6, y: -2.1 },
  ]),
);

/** The current time, ticking every 30 s so "7m ago" stays true. */
export const now = signal(Date.now());
setInterval(() => now.set(Date.now()), 30_000);

/** "now", "7m ago", "2h ago". */
export function ago(at: number, t: number): string {
  const m = Math.floor((t - at) / minute);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** The touchdowns' radial dispersion (m, root mean square). */
export const dispersion = computed(() => {
  const all = touchdowns();
  return Math.sqrt(all.reduce((a, p) => a + p.x * p.x + p.y * p.y, 0) / all.length);
});

// The flight plan being tuned.

export const segments = ["Ascent", "Hover", "Translate", "Descend"] as const;
export type Segment = (typeof segments)[number];

/** Below this throttle the lander cannot hover (%). */
export const hoverThrottle = 62;
/** The test range's ceiling (m). */
export const ceiling = 150;

const defaults = {
  segment: "Hover" as Segment,
  throttle: 74,
  gimbal: 6,
  hoverTime: 12,
  target: { x: "0", y: "0", z: "120" },
  terrainNav: true,
  legsAt30: true,
  autoAbort: false,
};

export const plan = {
  segment: signal<Segment>(defaults.segment),
  throttle: signal(defaults.throttle),
  gimbal: signal(defaults.gimbal),
  hoverTime: signal(defaults.hoverTime),
  target: signal({ ...defaults.target }),
  terrainNav: signal(defaults.terrainNav),
  legsAt30: signal(defaults.legsAt30),
  autoAbort: signal(defaults.autoAbort),
};

export function resetPlan() {
  plan.segment.set(defaults.segment);
  plan.throttle.set(defaults.throttle);
  plan.gimbal.set(defaults.gimbal);
  plan.hoverTime.set(defaults.hoverTime);
  plan.target.set({ ...defaults.target });
  plan.terrainNav.set(defaults.terrainNav);
  plan.legsAt30.set(defaults.legsAt30);
}

export const flying = signal(false);

/**
 * Flies the plan in the simulator: throttle below hover or an apogee over
 * the ceiling aborts, a gimbal limit under 4° lands hard. The hop joins the
 * log and its touchdown the dispersion plot.
 */
export async function flyHop(): Promise<Hop> {
  flying.set(true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  const throttle = plan.throttle(), gimbal = plan.gimbal(), t = plan.target();
  const apogee = Number(t.z) || 0;
  let outcome: Outcome = "nominal";
  let note = `hover ${plan.hoverTime()} s`;
  if (throttle < hoverThrottle) [outcome, note] = ["abort", "throttle low"];
  else if (apogee > ceiling) [outcome, note] = ["abort", "over ceiling"];
  else if (gimbal < 4) [outcome, note] = ["hard", "gimbal sat."];
  const all = hops();
  const hop: Hop = {
    id: all[all.length - 1].id + 1,
    outcome,
    note,
    apogee: outcome === "abort" ? 25 : Math.min(apogee, ceiling),
    at: Date.now(),
  };
  hops.set([...all, hop]);
  if (outcome !== "abort") {
    const drift = plan.terrainNav() ? 0.4 : 1.1;
    touchdowns.set([
      ...touchdowns(),
      { x: (Number(t.x) || 0) * 0.1 + normal() * drift, y: (Number(t.y) || 0) * 0.1 + normal() * drift },
    ]);
  }
  now.set(Date.now());
  flying.set(false);
  return hop;
}

// The throttle profile.

/** How a phase eases in from the previous one; "custom" is a dragged curve. */
export type EasingName = "linear" | "easeIn" | "easeOut" | "easeInOut" | "spring" | "custom";
export type Bezier = [number, number, number, number];

export const easings: { name: EasingName; label: string; bezier: Bezier }[] = [
  { name: "linear", label: "Linear", bezier: [0, 0, 1, 1] },
  { name: "easeIn", label: "Ease in", bezier: [0.42, 0, 1, 1] },
  { name: "easeOut", label: "Ease out", bezier: [0, 0, 0.58, 1] },
  { name: "easeInOut", label: "Ease in-out", bezier: [0.42, 0, 0.58, 1] },
  { name: "spring", label: "Spring", bezier: [0.3, 1.25, 0.6, 1] },
];

const preset = (name: EasingName): Bezier => [...(easings.find((e) => e.name === name) ?? easings[0]).bezier];
export const easingLabel = (name: EasingName) => easings.find((e) => e.name === name)?.label ?? "Custom";

export interface Phase {
  id: number;
  name: string;
  /** Seconds after ignition. */
  at: number;
  easing: EasingName;
  bezier: Bezier;
}

export const phases = signal<Phase[]>(
  (
    [
      [1, "Ignition", 0, "linear"],
      [2, "Climb", 1.8, "easeOut"],
      [3, "Hover", 6, "easeInOut"],
      [4, "Descend", 16, "easeIn"],
      [5, "Touchdown", 22, "spring"],
    ] as const
  ).map(([id, name, at, easing]) => ({ id, name, at, easing, bezier: preset(easing) })),
);

export const selectedPhase = signal(3);

export function setEasing(id: number, easing: EasingName) {
  phases.set(phases().map((p) => (p.id === id ? { ...p, easing, bezier: preset(easing) } : p)));
}

/** Sets a phase's curve from dragged handles (x within 0…1, as in CSS). */
export function setBezier(id: number, b: Bezier) {
  const r = (v: number) => Math.round(v * 100) / 100;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const next: Bezier = [r(clamp(b[0])), r(b[1]), r(clamp(b[2])), r(b[3])];
  phases.set(phases().map((p) => (p.id === id ? { ...p, easing: "custom", bezier: next } : p)));
}

const extra = ["Flare", "Safe", "Vent"];

/** Adds a phase 2 s after the last one. */
export function addPhase() {
  const all = phases();
  const last = all[all.length - 1];
  const id = Math.max(...all.map((p) => p.id)) + 1;
  phases.set([
    ...all,
    { id, name: extra[(all.length - 5) % extra.length] ?? `Phase ${id}`, at: last.at + 2, easing: "easeOut", bezier: preset("easeOut") },
  ]);
  selectedPhase.set(id);
}

// Mass properties.

export const vehicle = {
  dry: 412,
  propellantMax: 260,
  nitrogen: 12,
  maxTakeoff: 720,
  /** Height of the dry CG above the feet (m). */
  dryCg: 2.1,
  /** The tank's bottom and top above the feet (m). */
  tank: [1.4, 3.6] as const,
  height: 5.2,
};

/** How full the propellant tank is (0…1). */
export const load = signal(0.85);

export const wetMass = computed(() => Math.round(vehicle.dry + vehicle.nitrogen + vehicle.propellantMax * load()));

/** The CG's height above the feet (m): the dry CG and the propellant's
 * (half way up its level) weighted by mass. */
export const cgHeight = computed(() => {
  const prop = vehicle.propellantMax * load();
  const [bottom, top] = vehicle.tank;
  const propCg = bottom + ((top - bottom) * load()) / 2;
  return (vehicle.dry * vehicle.dryCg + prop * propCg + vehicle.nitrogen * 3.9) / (vehicle.dry + prop + vehicle.nitrogen);
});

// Attitude telemetry and RCS.

export const HOP_LENGTH = 24;
/** The tilt limit of the flight software (°). */
export const tiltLimit = 5;

/** Tilt (°) at t s: a damped wobble after liftoff, a gust at 9 s. */
export function tiltAt(t: number): number {
  const wobble = 3.4 * Math.sin(2.3 * t) * Math.exp(-0.11 * t);
  const gust = 4.6 * Math.exp(-((t - 9.2) ** 2) / 0.5);
  return wobble + gust + 0.35 * Math.sin(7.1 * t);
}

/** Gimbal commands, one per half second: deflection 0…1. */
export const gimbalCommands = Array.from({ length: 48 }, (_, i) => {
  const t = (i / 48) * HOP_LENGTH;
  return Math.min(1, Math.abs(tiltAt(t)) / 6 + rand() * 0.12);
});

export const quads = [
  { id: "Q1", name: "Fore port", used: 18.4, delta: 0, angle: -135 },
  { id: "Q2", name: "Fore starboard", used: 17.9, delta: 0, angle: -45 },
  { id: "Q3", name: "Aft starboard", used: 12.6, delta: -28, angle: 45 },
  { id: "Q4", name: "Aft port", used: 18.1, delta: 0, angle: 135 },
];

export const nitrogenTank = { pressure: 214, capacity: 300, hopsLeft: 3 };
