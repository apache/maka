// The site's sounds, three of the gallery's (cuelume's cues, MIT: `public/sounds/LICENSE`):
// `select` for a choice (a tab, a theme, a filter), `success` for a copy, `tap` for the
// home page's press. Quiet, and only on what the reader does. Web Audio, decoded once
// at the first press anywhere on the page, so the first is on time.
import { BASE } from './site';

/** The site's sounds. */
export type SoundName = 'select' | 'success' | 'tap';

let context: AudioContext | undefined;
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>();

function load(name: SoundName): Promise<AudioBuffer | null> {
  try {
    context ??= new AudioContext();
  } catch {
    return Promise.resolve(null);
  }
  const audio = context;
  let buffer = buffers.get(name);
  if (!buffer) {
    buffer = fetch(`${BASE}sounds/${name}.wav`)
      .then((r) => r.arrayBuffer())
      .then((bytes) => audio.decodeAudioData(bytes))
      .catch(() => null);
    buffers.set(name, buffer);
  }
  return buffer;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (['select', 'success', 'tap'] as const).forEach((name) => void load(name)), {
    once: true,
    capture: true,
  });
}

/** Plays `name` at `volume` (0.6; 0.3 for a subtle one). */
export function playSound(name: SoundName, volume = 0.6) {
  void load(name).then((buffer) => {
    if (!buffer || !context) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.start();
  });
}

/** Plays `select`: a choice made. */
export function playSelect() {
  playSound('select');
}
