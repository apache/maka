/** 统一错误体系。所有适配器抛这些类型,调用方按 name 判别决策。 */

export class MailSdkError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = 'MailSdkError';
    }
}

export class AuthError extends MailSdkError {
    constructor(message: string, cause?: unknown) {
        super(message, cause);
        this.name = 'AuthError';
    }
}

export class NetworkError extends MailSdkError {
    constructor(message: string, cause?: unknown) {
        super(message, cause);
        this.name = 'NetworkError';
    }
}

export class NotFoundError extends MailSdkError {
    constructor(message: string, cause?: unknown) {
        super(message, cause);
        this.name = 'NotFoundError';
    }
}

export class UnsupportedError extends MailSdkError {
    constructor(message: string, cause?: unknown) {
        super(message, cause);
        this.name = 'UnsupportedError';
    }
}

export class RateLimitError extends MailSdkError {
    constructor(message: string, cause?: unknown) {
        super(message, cause);
        this.name = 'RateLimitError';
    }
}
