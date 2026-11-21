/**
 * 凭据联合类型 + zod schema。
 * 三类:PasswordCredential(IMAP)/ OAuthCredential(Graph+Gmail)/ AnonymousCredential(temp-mail)。
 */
import { z } from 'zod';

export interface PasswordCredential {
    readonly type: 'password';
    readonly user: string;
    readonly password: string;
}

export interface OAuthCredential {
    readonly type: 'oauth';
    readonly flow: 'client_credentials' | 'authorization_code' | 'device_code' | 'service_account' | 'installed';
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly tenantId?: string;
    readonly refreshToken?: string;
    readonly accessToken?: string;
    readonly scopes?: readonly string[];
    readonly serviceAccountEmail?: string;
    readonly privateKey?: string;
    readonly delegatedUser?: string;
}

export interface AnonymousCredential {
    readonly type: 'anonymous';
    readonly addressPrefix?: string;
    readonly token?: string;
    readonly accountId?: string;
}

export type Credential = PasswordCredential | OAuthCredential | AnonymousCredential;

export const PasswordCredentialSchema = z.object({
    type: z.literal('password'),
    user: z.string().min(1),
    password: z.string().min(1),
});

export const OAuthCredentialSchema = z.object({
    type: z.literal('oauth'),
    flow: z.enum(['client_credentials', 'authorization_code', 'device_code', 'service_account', 'installed']),
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
    tenantId: z.string().optional(),
    refreshToken: z.string().optional(),
    accessToken: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    serviceAccountEmail: z.string().optional(),
    privateKey: z.string().optional(),
    delegatedUser: z.string().optional(),
});

export const AnonymousCredentialSchema = z.object({
    type: z.literal('anonymous'),
    addressPrefix: z.string().optional(),
    token: z.string().optional(),
    accountId: z.string().optional(),
});

export const CredentialSchema = z.discriminatedUnion('type', [
    PasswordCredentialSchema,
    OAuthCredentialSchema,
    AnonymousCredentialSchema,
]);
