import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import type { ConfigurationCredentialExportInput, OperationOutcome } from '../protocol/index.js';
import type { ConfigurationOperationHandlerMap } from './operation-dispatcher.js';

export class HostConfigurationCoordinator {
  readonly handlers: ConfigurationOperationHandlerMap = {
    'configuration.credentials.export': (input) => this.#exportCredentials(input),
  };

  constructor(
    private readonly policy: Pick<RuntimePolicyOperationCoordinator, 'exportCredentialMaterial'>,
  ) {}

  async #exportCredentials(
    input: ConfigurationCredentialExportInput,
  ): Promise<OperationOutcome<'configuration.credentials.export'>> {
    try {
      const credentials = (
        await Promise.all(
          input.locators.map(async (locator) => {
            const material = await this.policy.exportCredentialMaterial(locator);
            return material ? { locator: material.locator, secret: material.secret } : null;
          }),
        )
      ).filter((entry) => entry !== null);
      return { ok: true, result: { credentials } };
    } catch {
      return {
        ok: false,
        error: {
          code: 'internal_failure',
          message: 'Configuration credential export failed',
        },
      };
    }
  }
}
