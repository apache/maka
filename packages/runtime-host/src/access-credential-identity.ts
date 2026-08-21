import { createHash } from 'node:crypto';

const CREDENTIAL_FINGERPRINT_HEX_LENGTH = 32;

export function runtimeHostAccessCredentialHash(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

export function runtimeHostAccessCredentialFingerprintFromHash(hash: string): string {
  return hash.slice(0, CREDENTIAL_FINGERPRINT_HEX_LENGTH);
}

export function runtimeHostAccessCredentialFingerprint(credential: string): string {
  return runtimeHostAccessCredentialFingerprintFromHash(
    runtimeHostAccessCredentialHash(credential).toString('hex'),
  );
}
