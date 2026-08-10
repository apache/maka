import type {
  RuntimeHostSessionObserver,
  RuntimeHostSessionObserverTarget,
} from "./runtime-host-session-observer.js";

type SessionObservationSource = Pick<
  RuntimeHostSessionObserver,
  "observe" | "unobserve"
>;

interface SessionObservationRegistration {
  readonly sessionId: string;
  readonly target: RuntimeHostSessionObserverTarget;
  readonly destroyedListener: () => void;
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
  #closed = false;

  constructor(onError: (error: unknown) => void = () => undefined) {
    this.#onError = onError;
  }

  async attach(source: SessionObservationSource): Promise<string[]> {
    this.#assertOpen();
    if (this.#source && this.#source !== source) {
      throw new Error("Runtime Host Session observations are already attached");
    }
    this.#source = source;
    const restored = await Promise.all(
      [...this.#registrations].map(async ([observerId, registration]) => {
        try {
          await source.observe(
            registration.sessionId,
            observerId,
            registration.target,
          );
          return registration.sessionId;
        } catch (error) {
          if (this.#source === source) this.#onError(error);
          return undefined;
        }
      }),
    );
    return [...new Set(restored.filter((sessionId): sessionId is string => !!sessionId))];
  }

  detach(source: SessionObservationSource): void {
    if (this.#source === source) this.#source = undefined;
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
      return;
    }

    const destroyedListener = () => {
      void this.#remove(observerId).catch(this.#onError);
    };
    const registration = { sessionId, target, destroyedListener };
    this.#registrations.set(observerId, registration);
    target.once("destroyed", destroyedListener);

    const source = this.#source;
    if (!source) return;
    try {
      await source.observe(sessionId, observerId, target);
    } catch (error) {
      if (
        this.#source === source &&
        this.#registrations.get(observerId) === registration
      ) {
        this.#deleteRegistration(observerId, registration);
      }
      throw error;
    }
  }

  async unobserve(observerId: string): Promise<void> {
    await this.#remove(observerId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const source = this.#source;
    this.#source = undefined;
    const registrations = [...this.#registrations];
    this.#registrations.clear();
    for (const [, registration] of registrations) {
      registration.target.off("destroyed", registration.destroyedListener);
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
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Runtime Host Session observation registry is closed");
    }
  }
}
