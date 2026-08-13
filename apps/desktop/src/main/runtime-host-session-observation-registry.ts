import type {
  RuntimeHostSessionObserver,
  RuntimeHostSessionObserverTarget,
} from "./runtime-host-session-observer.js";

type SessionObservationSource = Pick<
  RuntimeHostSessionObserver,
  "observe" | "unobserve"
>;

type ObservationTargetBinding = (
  target: RuntimeHostSessionObserverTarget,
) => RuntimeHostSessionObserverTarget;

interface ObservationReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface SessionObservationRegistration {
  readonly sessionId: string;
  readonly target: RuntimeHostSessionObserverTarget;
  readonly destroyedListener: () => void;
  readonly ready: ObservationReadiness;
  lifecycle: "pending" | "active";
}

function observationReadiness(): ObservationReadiness {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Keeps renderer observation intent alive while the Host connection is replaced.
 */
export class RuntimeHostSessionObservationRegistry {
  readonly #registrations = new Map<
    string,
    SessionObservationRegistration
  >();
  readonly #onError: (error: unknown) => void;
  #source: SessionObservationSource | undefined;
  #bindTarget: ObservationTargetBinding = (target) => target;
  #closed = false;

  constructor(onError: (error: unknown) => void = () => undefined) {
    this.#onError = onError;
  }

  async attach(
    source: SessionObservationSource,
    bindTarget: ObservationTargetBinding = (target) => target,
  ): Promise<string[]> {
    this.#assertOpen();
    if (this.#source && this.#source !== source) {
      throw new Error("Runtime Host Session observations are already attached");
    }
    this.#source = source;
    this.#bindTarget = bindTarget;
    const restored = await Promise.all(
      [...this.#registrations].map(async ([observerId, registration]) => {
        try {
          await source.observe(
            registration.sessionId,
            observerId,
            bindTarget(registration.target),
          );
          if (
            this.#source !== source ||
            this.#registrations.get(observerId) !== registration
          ) {
            return undefined;
          }
          registration.lifecycle = "active";
          registration.ready.resolve();
          return registration.sessionId;
        } catch (error) {
          if (
            this.#source === source &&
            this.#registrations.get(observerId) === registration
          ) {
            if (registration.lifecycle === "pending") {
              this.#deleteRegistration(observerId, registration);
            }
            this.#onError(error);
          }
          return undefined;
        }
      }),
    );
    return [...new Set(restored.filter((sessionId): sessionId is string => !!sessionId))];
  }

  detach(source: SessionObservationSource): void {
    if (this.#source === source) {
      this.#source = undefined;
      this.#bindTarget = (target) => target;
    }
  }

  async observe(
    sessionId: string,
    observerId: string,
    target: RuntimeHostSessionObserverTarget,
  ): Promise<void> {
    this.#assertOpen();
    const previous = this.#registrations.get(observerId);
    if (previous) {
      if (previous.sessionId !== sessionId || previous.target.id !== target.id) {
        throw new Error("Runtime Host Session observer identity was reused");
      }
      return previous.ready.promise;
    }

    const destroyedListener = () => {
      void this.#remove(observerId).catch(this.#onError);
    };
    const ready = observationReadiness();
    void ready.promise.catch(() => undefined);
    const registration: SessionObservationRegistration = {
      sessionId,
      target,
      destroyedListener,
      ready,
      lifecycle: "pending",
    };
    this.#registrations.set(observerId, registration);
    target.once("destroyed", destroyedListener);

    const source = this.#source;
    if (!source) return registration.ready.promise;
    try {
      await source.observe(sessionId, observerId, this.#bindTarget(target));
      if (
        this.#source === source &&
        this.#registrations.get(observerId) === registration
      ) {
        registration.lifecycle = "active";
        registration.ready.resolve();
      }
    } catch (error) {
      if (
        this.#source === source &&
        this.#registrations.get(observerId) === registration
      ) {
        this.#deleteRegistration(observerId, registration);
        throw error;
      }
      return registration.ready.promise;
    }
    return registration.ready.promise;
  }

  async unobserve(observerId: string): Promise<void> {
    await this.#remove(observerId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const source = this.#source;
    this.#source = undefined;
    this.#bindTarget = (target) => target;
    const registrations = [...this.#registrations];
    this.#registrations.clear();
    for (const [, registration] of registrations) {
      registration.target.off("destroyed", registration.destroyedListener);
      registration.ready.reject(
        new Error("Session observation ended before it became ready"),
      );
    }
    if (source) {
      await Promise.allSettled(
        registrations.map(([observerId]) => source.unobserve(observerId)),
      );
    }
  }

  async #remove(observerId: string): Promise<void> {
    const registration = this.#registrations.get(observerId);
    if (!registration) return;
    this.#deleteRegistration(observerId, registration);
    await this.#source?.unobserve(observerId);
  }

  #deleteRegistration(
    observerId: string,
    registration: SessionObservationRegistration,
  ): void {
    if (this.#registrations.get(observerId) !== registration) return;
    this.#registrations.delete(observerId);
    registration.target.off("destroyed", registration.destroyedListener);
    registration.ready.reject(
      new Error("Session observation ended before it became ready"),
    );
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Runtime Host Session observation registry is closed");
    }
  }
}
