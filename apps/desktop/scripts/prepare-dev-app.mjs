#!/usr/bin/env node
import { developmentAppPath, prepareDevelopmentApp } from './dev-app-runtime.mjs';

await prepareDevelopmentApp();
console.log(`[dev-app] ready: ${developmentAppPath}`);
