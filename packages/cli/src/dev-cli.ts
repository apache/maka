#!/usr/bin/env node

import { launchMakaCli } from './cli-core.js';

launchMakaCli({
  dataProfileName: 'Maka Dev',
  cliCommand: 'npm run cli:dev --',
  capabilityProviderIdentityScope: 'client-data-root',
});
