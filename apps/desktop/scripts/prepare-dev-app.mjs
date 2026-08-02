#!/usr/bin/env node
import { developmentAppPath, prepareDevelopmentApp } from './dev-app-runtime.mjs';

prepareDevelopmentApp();
console.log(`[dev-app] ready: ${developmentAppPath}`);
