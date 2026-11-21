/**
 * Graph OAuth2 token 获取。按 OAuthCredential.flow 选择 @azure/identity 凭证类。
 * 支持 client_credentials(服务端,需 delegatedUser)与 device_code(交互式)。
 * authorization_code 需浏览器交互,本 SDK 不内置,建议外部预换 accessToken 后直传。
 */
import { ClientSecretCredential, DeviceCodeCredential } from '@azure/identity';
import type { OAuthCredential } from '../../types/credential.js';
import { AuthError } from '../../core/errors.js';

export async function getGraphAccessToken(cred: OAuthCredential): Promise<string> {
    if (cred.accessToken) return cred.accessToken;
    const scopes: string[] = [...(cred.scopes ?? ['https://graph.microsoft.com/.default'])];

    switch (cred.flow) {
        case 'client_credentials': {
            if (!cred.tenantId || !cred.clientSecret) {
                throw new AuthError('graph client_credentials 需要 tenantId + clientSecret');
            }
            const az = new ClientSecretCredential(cred.tenantId, cred.clientId, cred.clientSecret);
            const result = await az.getToken(scopes);
            if (!result) throw new AuthError('graph client_credentials: 获取 token 失败');
            return result.token;
        }
        case 'device_code': {
            if (!cred.tenantId) throw new AuthError('graph device_code 需要 tenantId');
            const az = new DeviceCodeCredential({
                tenantId: cred.tenantId,
                clientId: cred.clientId,
                deviceCodeCallback: (info: { verificationUri?: string; userCode?: string }) => {
                    console.error(`[graph] 设备码登录,请打开 ${info.verificationUri} 输入 ${info.userCode}`);
                },
            } as never);
            const result = await az.getToken(scopes);
            if (!result) throw new AuthError('graph device_code: 获取 token 失败');
            return result.token;
        }
        case 'authorization_code':
            throw new AuthError(
                'graph authorization_code 需浏览器交互,本 SDK 不内置;请外部换得 accessToken 后直传 credential.accessToken',
            );
        default:
            throw new AuthError(`graph 不支持 flow=${cred.flow}`);
    }
}
