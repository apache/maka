/** mailparser 类型声明(只声明本项目用到的子集)。 */
declare module 'mailparser' {
    interface AddressValue {
        address?: string;
        name?: string;
    }
    interface Attachment {
        contentId?: string;
        filename?: string;
        contentType?: string;
        size?: number;
    }
    export interface ParsedMail {
        subject?: string;
        from?: { value?: AddressValue[] };
        to?: { value?: AddressValue[] };
        cc?: { value?: AddressValue[] };
        text?: string;
        html?: string | false;
        date?: Date;
        attachments?: Attachment[];
    }
    export function simpleParser(source: Buffer | string | NodeJS.ReadableStream): Promise<ParsedMail>;
}
