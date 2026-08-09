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
      const material = await this.policy.exportCredentialMaterial(input.locator);
      const credential = material
        ? {
            locator: material.locator,
            secretBase64: Buffer.from(material.secret, 'utf8').toString('base64'),
          }
        : null;
      return { ok: true, result: { credential } };
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
