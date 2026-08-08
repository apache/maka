import { runMakaTextCli } from '../run-command.js';
import { createRunCommandFake } from './run-command-fake.js';

// Subprocess entry for the retained process-contract tests: real stdin
// piping, a fail-closed sandbox boundary, and SIGINT delivery. Ordinary
// command semantics run in process through the same fake via
// createRunCommandFake — keep this wrapper limited to what a real child
// process is genuinely needed for.
const fake = createRunCommandFake({
  ...(process.env.MAKA_RUN_FIXTURE_SCENARIO
    ? { scenario: process.env.MAKA_RUN_FIXTURE_SCENARIO }
    : {}),
  onReady: () => process.stderr.write('fixture-ready\n'),
});

runMakaTextCli(process.argv.slice(2), fake).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
