#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

const commands = {
  prepare: { module: 'prepare.mjs' },
  'real-ax': {
    module: 'real-ax-launcher.mjs',
    options: {
      '--scenario': 'MAKA_CU_AX_MODEL_SCENARIO',
      '--provider': 'MAKA_CU_MODEL_PROVIDER',
    },
  },
  'real-model': {
    module: 'real-model.mjs',
    options: {
      '--scenario': 'MAKA_CU_E2E_SCENARIO',
      '--provider': 'MAKA_CU_PROVIDER',
    },
  },
  'restart-soak': { module: 'process-restart-launcher.mjs' },
  'function-model': { module: 'function-model.mjs' },
  'anthropic-model': { module: 'anthropic-model.mjs' },
  'runtime-model': { module: 'runtime-model.mjs' },
  'cursor-accuracy': { module: 'cursor-accuracy-real.mjs' },
  'provider-matrix': { module: 'provider-matrix.mjs' },
  'trace-analyse': { module: 'trace-analyse.mjs' },
};

const [commandName, ...commandArgs] = process.argv.slice(2);
if (!commandName || commandName === 'help' || commandName === '--help' || commandName === '-h') {
  process.stdout.write(
    `Usage: node scripts/computer-use.mjs <command> [options]\n\nCommands:\n${Object.keys(commands)
      .map((name) => `  ${name}`)
      .join('\n')}\n`,
  );
  process.exit(0);
}

const command = commands[commandName];
if (!command) {
  process.stderr.write(`Unknown Computer Use command: ${commandName}\n`);
  process.exit(1);
}

const forwardedArgs = [];
for (let index = 0; index < commandArgs.length; index += 1) {
  const argument = commandArgs[index];
  const [optionName, inlineValue] = argument.split('=', 2);
  const environmentName = command.options?.[optionName];
  if (!environmentName) {
    forwardedArgs.push(argument);
    continue;
  }
  const value = inlineValue ?? commandArgs[++index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  process.env[environmentName] = value;
}

process.argv = [
  process.argv[0],
  fileURLToPath(new URL(`./computer-use/${command.module}`, import.meta.url)),
  ...forwardedArgs,
];
await import(`./computer-use/${command.module}`);
