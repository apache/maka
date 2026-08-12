import {
  LOCAL_RUNTIME_HOST_PROFILE,
  createClientRuntimeHostProfileCatalog,
  type RuntimeHostProfileCatalog,
} from '@maka/runtime-host/client';
import { resolveMakaClientDataRoot } from '@maka/storage';

const DEFAULT_CREDENTIAL_ENV = 'MAKA_RUNTIME_HOST_ACCESS_CREDENTIAL';

export type RuntimeHostProfileCommand =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'set';
      readonly id: string;
      readonly name: string;
      readonly tlsUrl: string;
      readonly expectedRootId: string;
      readonly credentialEnv?: string;
    }
  | { readonly kind: 'remove'; readonly id: string };

export interface RuntimeHostProfileCommandDeps {
  readonly catalog: RuntimeHostProfileCatalog;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (value: string) => void;
}

export async function runRuntimeHostProfileCommand(
  command: RuntimeHostProfileCommand,
  overrides: Partial<RuntimeHostProfileCommandDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps(), ...overrides };
  if (command.kind === 'list') {
    const document = await deps.catalog.read();
    deps.write(`${JSON.stringify([LOCAL_RUNTIME_HOST_PROFILE, ...document.profiles], null, 2)}\n`);
    return 0;
  }
  if (command.kind === 'remove') {
    await deps.catalog.remove(command.id);
    return 0;
  }

  const credentialEnv = command.credentialEnv ?? DEFAULT_CREDENTIAL_ENV;
  const suppliedCredential = deps.env[credentialEnv];
  const document = await deps.catalog.save(
    {
      id: command.id,
      name: command.name,
      kind: 'remote',
      transport: { kind: 'tls', url: command.tlsUrl },
      rootId: command.expectedRootId,
    },
    suppliedCredential,
  );
  const profile = document.profiles.find((candidate) => candidate.id === command.id);
  if (!profile) throw new Error('Runtime Host profile update did not persist');
  deps.write(`${JSON.stringify(profile, null, 2)}\n`);
  return 0;
}

function defaultDeps(): RuntimeHostProfileCommandDeps {
  const root = resolveMakaClientDataRoot();
  return {
    catalog: createClientRuntimeHostProfileCatalog(root),
    env: process.env,
    write: (value) => process.stdout.write(value),
  };
}
