import { isAbsolute, resolve } from 'node:path';

export const PROTOCOL_VERSION = 1;

const requestKeys = new Set([
  'version',
  'requestId',
  'executable',
  'arguments',
  'cwd',
  'readRoots',
  'writeRoots',
  'network',
  'environment',
]);

export function parseLaunchRequest(value) {
  requireRecord(value, 'request');
  rejectUnknownKeys(value, requestKeys, 'request');
  if (value.version !== PROTOCOL_VERSION) throw new Error('unsupported protocol version');
  requireNonEmptyString(value.requestId, 'requestId');
  const executable = requireCanonicalAbsolutePath(value.executable, 'executable');
  const cwd = requireCanonicalAbsolutePath(value.cwd, 'cwd');
  const readRoots = requirePathArray(value.readRoots, 'readRoots');
  const writeRoots = requirePathArray(value.writeRoots, 'writeRoots');
  if (!['restricted', 'enabled'].includes(value.network)) {
    throw new Error('network must be restricted or enabled');
  }
  if (!Array.isArray(value.arguments) || !value.arguments.every((item) => typeof item === 'string')) {
    throw new Error('arguments must be an array of strings');
  }
  requireRecord(value.environment, 'environment');
  for (const [key, item] of Object.entries(value.environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof item !== 'string') {
      throw new Error('environment must contain valid string entries');
    }
  }
  return { ...value, executable, cwd, readRoots, writeRoots };
}

function requirePathArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const paths = value.map((item, index) => requireCanonicalAbsolutePath(item, `${name}[${index}]`));
  if (new Set(paths.map((item) => item.toLowerCase())).size !== paths.length) {
    throw new Error(`${name} must not contain duplicate paths`);
  }
  return paths;
}

function requireCanonicalAbsolutePath(value, name) {
  requireNonEmptyString(value, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
  const canonical = resolve(value);
  if (value.toLowerCase() !== canonical.toLowerCase()) {
    throw new Error(`${name} must be lexically canonical`);
  }
  return canonical;
}

function requireRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be non-empty`);
}

function rejectUnknownKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown fields: ${unknown.join(', ')}`);
}
