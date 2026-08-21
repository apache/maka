#!/usr/bin/env node
import { runExecutionCandidateEntry } from './candidate-entry.js';

await runExecutionCandidateEntry(process.argv.slice(2));
