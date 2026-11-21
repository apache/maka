/** GraphProvider 选项。 */

export interface GraphProviderOptions {
    /** Graph API 基址,默认 https://graph.microsoft.com/v1.0。 */
    readonly baseUrl?: string;
    /** client_credentials 模式下要访问的邮箱 UPN(必填);其他模式可留空用 'me'。 */
    readonly delegatedUser?: string;
    /** 显式指定要读取的邮箱(UPN 或 'me'),默认 delegatedUser ?? 'me'。 */
    readonly user?: string;
}
