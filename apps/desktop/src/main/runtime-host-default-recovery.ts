import { LOCAL_RUNTIME_HOST_PROFILE } from '@maka/runtime-host/client';

export type RuntimeHostDefaultRecoveryDecision =
  | 'retry'
  | 'use_local'
  | 'keep_offline';

export interface RuntimeHostDefaultFailure {
  readonly profileId: string;
  readonly profileName: string;
  readonly error: Error;
}

/** Coordinates the one recovery choice that belongs to the default Host. */
export function createRuntimeHostDefaultRecovery(input: {
  readonly defaultProfileId: () => string;
  readonly prompt: (
    failure: RuntimeHostDefaultFailure,
  ) => Promise<RuntimeHostDefaultRecoveryDecision>;
  readonly retry: (profileId: string) => Promise<Error | undefined>;
  readonly useLocal: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}): {
  offer(failure: RuntimeHostDefaultFailure): void;
} {
  let pending: Promise<void> | undefined;

  const recover = async (initialFailure: RuntimeHostDefaultFailure): Promise<void> => {
    let failure = initialFailure;
    while (input.defaultProfileId() === failure.profileId) {
      const decision = await input.prompt(failure);
      if (input.defaultProfileId() !== failure.profileId) return;
      if (decision === 'keep_offline') return;
      if (decision === 'use_local') {
        await input.useLocal();
        return;
      }
      const retryFailure = await input.retry(failure.profileId);
      if (!retryFailure) return;
      failure = { ...failure, error: retryFailure };
    }
  };

  return {
    offer(failure) {
      if (
        failure.profileId === LOCAL_RUNTIME_HOST_PROFILE.id ||
        input.defaultProfileId() !== failure.profileId ||
        pending
      ) return;
      pending = recover(failure)
        .catch(input.onError)
        .finally(() => {
          pending = undefined;
        });
    },
  };
}
