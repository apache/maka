// The gallery's sounds: cuelume's cues (examples/gallery/sounds, MIT), one for
// each kind of moment, played where a change deserves to be heard as well as
// seen. Apps load their own files (`loadSounds`: assets ship from the app's
// directory); until they are loaded, and where the platform has no sound,
// `play` is silent, and so it is while the user has turned sounds off
// (`soundsOn`, kept in `Storage` across launches).
import { signal, Sound, Storage } from "nsh";

/** The sounds, by the job each does. */
export type SoundName = "tap" | "select" | "toggle" | "open" | "close" | "success" | "warning" | "error" | "ready" | "attention";

/** Each sound and what it is for, in the order the gallery lists them. */
export const SOUNDS: readonly { name: SoundName; purpose: string }[] = [
  { name: "tap", purpose: "A direct action: a message sent" },
  { name: "select", purpose: "A choice among options: a segment, a radio, a demo" },
  { name: "toggle", purpose: "A state switched: a switch, a checkbox" },
  { name: "open", purpose: "A sheet or a dialog coming in" },
  { name: "close", purpose: "It going, or a destructive confirm" },
  { name: "success", purpose: "Work finished well: saved, uploaded, copied" },
  { name: "warning", purpose: "Done, but worth a look" },
  { name: "error", purpose: "A failure or a refusal" },
  { name: "ready", purpose: "A result arrived: a reply finished" },
  { name: "attention", purpose: "A notice that asks for the user" },
];

const loaded: Partial<Record<SoundName, Sound>> = {};

const STORED = "sounds";

/** Whether sounds play: on unless the user turned them off. */
export const soundsOn = signal(true);
void Storage.getItem(STORED).then(
  (value) => value === "off" && soundsOn.set(false),
  () => {},
);

/** Turns sounds on or off, and remembers it. */
export function setSoundsOn(on: boolean) {
  soundsOn.set(on);
  void Storage.setItem(STORED, on ? "on" : "off").catch(() => {});
}

/**
 * Loads the app's files of the sounds (`import tap from "./sounds/tap.wav"`).
 * Call it at the top of a module: sounds loaded under a component go with it.
 */
export function loadSounds(urls: Partial<Record<SoundName, string>>) {
  void Sound.available().then((available) => {
    if (!available) return;
    for (const name of Object.keys(urls) as SoundName[]) {
      Sound.load(urls[name]!).then(
        (sound) => (loaded[name] = sound),
        () => {},
      );
    }
  });
}

/**
 * Plays `name`, at 0.6 unless `volume` says otherwise (0.3 for a subtle
 * one): sounds accompany the UI, they never lead it. `rate` below 1 lowers
 * the pitch (a switch turning off).
 */
export function play(name: SoundName, options?: { volume?: number; rate?: number }) {
  if (!soundsOn()) return;
  loaded[name]?.play({ volume: options?.volume ?? 0.6, rate: options?.rate ?? 1 });
}
