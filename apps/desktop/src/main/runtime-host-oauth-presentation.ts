import type { OAuthPresentationBackend } from '@maka/runtime-host/client';

const PRESENTATION_TIMEOUT_MS = 30_000;

export interface OAuthExternalPresentation {
  readonly method: 'open_external' | 'request_authorization_code';
  readonly stateHint: string;
}

export interface OAuthPresentationExpectation {
  readonly presented: Promise<OAuthExternalPresentation>;
  cancel(reason?: unknown): void;
}

/** Bridges a Host-owned OAuth attempt to Desktop-owned system-browser presentation. */
export class RuntimeHostOAuthPresentation implements OAuthPresentationBackend {
  #pending: PendingPresentation | undefined;

  constructor(private readonly openSystemBrowser: (url: string) => Promise<void>) {}

  expect(attemptId: string): OAuthPresentationExpectation {
    this.#pending?.reject(new Error('Another OAuth presentation replaced this attempt'));
    let resolvePresented!: (presentation: OAuthExternalPresentation) => void;
    let rejectPresented!: (reason?: unknown) => void;
    let presentedSettled = false;
    let resolveAuthorizationCode: ((value: string) => void) | undefined;
    let rejectAuthorizationCode: ((reason?: unknown) => void) | undefined;
    const presented = new Promise<OAuthExternalPresentation>((accept, decline) => {
      resolvePresented = accept;
      rejectPresented = decline;
    });
    const timer = setTimeout(() => {
      if (this.#pending?.attemptId !== attemptId) return;
      this.#pending = undefined;
      rejectPresented(new Error('Runtime Host did not present OAuth authorization'));
    }, PRESENTATION_TIMEOUT_MS);
    const pending: PendingPresentation = {
      attemptId,
      resolve: (presentation) => {
        clearTimeout(timer);
        presentedSettled = true;
        if (presentation.method === 'open_external' && this.#pending === pending) {
          this.#pending = undefined;
        }
        resolvePresented(presentation);
      },
      reject: (reason) => {
        clearTimeout(timer);
        if (this.#pending === pending) this.#pending = undefined;
        if (!presentedSettled) rejectPresented(reason);
        rejectAuthorizationCode?.(reason);
      },
      authorizationCode: (signal) =>
        new Promise<string>((resolveCode, rejectCode) => {
          resolveAuthorizationCode = resolveCode;
          rejectAuthorizationCode = rejectCode;
          signal.addEventListener(
            'abort',
            () => pending.reject(signal.reason),
            { once: true },
          );
        }),
      submitAuthorizationCode: (value) => {
        if (this.#pending === pending) this.#pending = undefined;
        resolveAuthorizationCode?.(value);
      },
    };
    this.#pending = pending;
    return {
      presented,
      cancel: (reason = new Error('OAuth presentation cancelled')) => {
        if (this.#pending === pending) pending.reject(reason);
      },
    };
  }

  async openExternal(
    url: string,
    stateHint: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const pending = this.#pending;
    if (!pending || !stateHint) {
      throw new Error('Desktop has no matching OAuth presentation request');
    }
    try {
      await this.openSystemBrowser(url);
      signal.throwIfAborted();
      pending.resolve({ method: 'open_external', stateHint });
    } catch (error) {
      pending.reject(error);
      throw error;
    }
  }

  async requestAuthorizationCode(
    url: string,
    stateHint: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const pending = this.#pending;
    if (!pending) throw new Error('Desktop has no matching OAuth presentation request');
    await this.openSystemBrowser(url);
    signal.throwIfAborted();
    pending.resolve({ method: 'request_authorization_code', stateHint });
    return pending.authorizationCode(signal);
  }

  submitAuthorizationCode(attemptId: string, authorizationCode: string): boolean {
    const pending = this.#pending;
    if (!pending || pending.attemptId !== attemptId) return false;
    pending.submitAuthorizationCode(authorizationCode);
    return true;
  }

  cancel(attemptId: string, reason: unknown = new Error('OAuth presentation cancelled')): void {
    if (this.#pending?.attemptId === attemptId) this.#pending.reject(reason);
  }
}

interface PendingPresentation {
  readonly attemptId: string;
  resolve(presentation: OAuthExternalPresentation): void;
  reject(reason?: unknown): void;
  authorizationCode(signal: AbortSignal): Promise<string>;
  submitAuthorizationCode(value: string): void;
}
