#!/usr/bin/env node

const fs = require('node:fs');

const safeCodePattern = /^[A-Z0-9_]{1,64}$/;

function findErrorCode(error) {
  const seen = new Set();
  let current = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    for (const value of [current.code, current.errno]) {
      if (typeof value === 'string' && safeCodePattern.test(value)) {
        return value;
      }
    }
    current = current.cause;
  }

  return undefined;
}

function contextAwareFetch(fetchImplementation, emit) {
  return async (...args) => {
    try {
      const response = await Reflect.apply(fetchImplementation, globalThis, args);
      if (!response.ok) {
        emit({ kind: 'http', status: response.status });
      }
      return response;
    } catch (error) {
      const code = findErrorCode(error);
      emit(code ? { kind: 'fetch', code } : { kind: 'fetch' });
      throw error;
    }
  };
}

function writeContext(context) {
  try {
    fs.writeSync(3, `${JSON.stringify(context)}\n`);
  } catch {
    // Context is best-effort. The installer must retain its original failure when fd 3 is unavailable.
  }
}

if (require.main === module) {
  const installer = process.argv[2];
  if (!installer) {
    throw new Error('Electron installer path is required');
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('This Electron installer requires the built-in Fetch API');
  }

  globalThis.fetch = contextAwareFetch(globalThis.fetch, writeContext);
  require(installer);
}

module.exports = { contextAwareFetch, findErrorCode };
