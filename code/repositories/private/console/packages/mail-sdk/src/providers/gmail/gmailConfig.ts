/** GmailProvider 选项。 */

export interface GmailProviderOptions {
    /** 要读取的 userId,默认 'me'(OAuth 用户)或 delegatedUser(service_account)。 */
    readonly user?: string;
}
