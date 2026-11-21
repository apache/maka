/**
 * Gmail OAuth2 认证客户端构造。按 OAuthCredential.flow 选择 googleapis 的 auth 类。
 * 支持 installed(桌面 OAuth + refresh_token)与 service_account(域内 JWT)。
 * 个人 Gmail 不支持 service_account;service_account 仅 Workspace 域内可用。
 */
import { google } from 'googleapis';
import type { OAuthCredential } from '../../types/credential.js';
import { AuthError } from '../../core/errors.js';

export function getGmailAuth(cred: OAuthCredential): any {
    switch (cred.flow) {
        case 'installed': {
            if (!cred.clientSecret || !cred.refreshToken) {
                throw new AuthError('gmail installed 需要 clientSecret + refreshToken');
            }
            const oauth2 = new google.auth.OAuth2(cred.clientId, cred.clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
            oauth2.setCredentials({ refresh_token: cred.refreshToken });
            return oauth2;
        }
        case 'service_account': {
            if (!cred.serviceAccountEmail || !cred.privateKey || !cred.delegatedUser) {
                throw new AuthError('gmail service_account 需要 serviceAccountEmail + privateKey + delegatedUser');
            }
            return new google.auth.JWT({
                email: cred.serviceAccountEmail,
                key: cred.privateKey,
                scopes: ['https://mail.google.com/'],
                subject: cred.delegatedUser,
            });
        }
        default:
            throw new AuthError(`gmail 不支持 flow=${cred.flow}`);
    }
}
