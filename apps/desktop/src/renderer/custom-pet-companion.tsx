import { useCallback, useEffect, useRef, useState } from 'react';
import { useMountedRef } from '@maka/ui';
import {
  loadSelectedPetCompanion,
  petFrameSourceRect,
  samplePetAnimation,
  shouldReducePetMotion,
  type SelectedPetCompanion,
} from './custom-pet-companion-model.js';

const EMPTY_COMPANION: SelectedPetCompanion = { kind: 'none' };

function readPetMotionPreference(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return true;
  const root = document.documentElement;
  return shouldReducePetMotion({
    reducedMotionAttribute: root.dataset.makaReducedMotion === 'true',
    e2eFixtureAttribute: root.dataset.makaE2eFixture === 'true',
    systemPreference:
      typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
}

function usePetMotionPreference(): boolean {
  const [reduced, setReduced] = useState(readPetMotionPreference);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(readPetMotionPreference());
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-maka-reduced-motion', 'data-maka-e2e-fixture'],
    });
    media.addEventListener('change', sync);
    sync();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, []);

  return reduced;
}

function PetSpriteCanvas(props: {
  companion: Extract<SelectedPetCompanion, { readonly kind: 'ready' }>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = usePetMotionPreference();
  const { manifest, mimeType, bytes } = props.companion;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const sheet = manifest.spriteSheet;
    const animation = manifest.animations.idle;
    canvas.width = sheet.frameWidth;
    canvas.height = sheet.frameHeight;
    context.imageSmoothingEnabled = true;

    // Copy into an owned ArrayBuffer. IPC may expose an ArrayBufferLike-backed
    // view, while Blob requires a transferable browser-owned part.
    const ownedBytes = new Uint8Array(bytes.length);
    ownedBytes.set(bytes);
    const objectUrl = URL.createObjectURL(new Blob([ownedBytes.buffer], { type: mimeType }));
    const image = new Image();
    let disposed = false;
    let animationFrame = 0;

    const draw = (frame: number) => {
      const source = petFrameSourceRect(frame, sheet);
      context.clearRect(0, 0, sheet.frameWidth, sheet.frameHeight);
      context.drawImage(
        image,
        source.x,
        source.y,
        source.width,
        source.height,
        0,
        0,
        sheet.frameWidth,
        sheet.frameHeight,
      );
    };

    image.onload = () => {
      if (disposed) return;
      draw(animation.frames[0]);
      if (reducedMotion) return;

      let startedAt: number | undefined;
      let previousSequenceIndex = 0;
      const tick = (timestamp: number) => {
        if (disposed) return;
        startedAt ??= timestamp;
        const sample = samplePetAnimation(animation, timestamp - startedAt);
        if (sample.sequenceIndex !== previousSequenceIndex) {
          previousSequenceIndex = sample.sequenceIndex;
          draw(sample.frame);
        }
        if (!sample.complete) animationFrame = window.requestAnimationFrame(tick);
      };
      animationFrame = window.requestAnimationFrame(tick);
    };
    image.src = objectUrl;

    return () => {
      disposed = true;
      image.onload = null;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      URL.revokeObjectURL(objectUrl);
    };
  }, [bytes, manifest, mimeType, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      className="maka-custom-pet-companion__canvas"
      data-pet-id={manifest.id}
      data-pet-state="idle"
    />
  );
}

/** Decorative selected-pet layer. Runtime state projection follows separately. */
export function CustomPetCompanion() {
  const mountedRef = useMountedRef();
  const loadTicketRef = useRef(0);
  const [companion, setCompanion] = useState<SelectedPetCompanion>(EMPTY_COMPANION);

  const refresh = useCallback(async () => {
    const ticket = ++loadTicketRef.current;
    try {
      const next = await loadSelectedPetCompanion(window.maka.pets);
      if (mountedRef.current && ticket === loadTicketRef.current) setCompanion(next);
    } catch {
      // A pet is optional decoration. Bridge or asset failures remove it rather
      // than destabilizing the application shell or surfacing startup noise.
      if (mountedRef.current && ticket === loadTicketRef.current) {
        setCompanion(EMPTY_COMPANION);
      }
    }
  }, [mountedRef]);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.maka.pets.subscribeChanges((event) => {
      // Selection/removal invalidates what is currently painted immediately;
      // an install alone cannot affect the active pack and need not reload it.
      if (event.reason === 'installed') return;
      setCompanion(EMPTY_COMPANION);
      void refresh();
    });
    return () => {
      loadTicketRef.current += 1;
      unsubscribe();
    };
  }, [refresh]);

  if (companion.kind !== 'ready') return null;
  return (
    <div className="maka-custom-pet-companion" aria-hidden="true">
      <PetSpriteCanvas companion={companion} />
    </div>
  );
}
