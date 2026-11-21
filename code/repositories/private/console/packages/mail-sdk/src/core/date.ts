/**
 * 日期归一(纯函数):把各种日期格式统一成 ISO 8601 UTC 字符串。
 * 输入来源:RFC822 Date 头(IMAP)、epoch 毫秒(Gmail internalDate)、ISO(Graph receivedDateTime)。
 * 非法输入返回空串(调用方按需处理)。
 */

export function normalizeDate(input: string | number | Date | undefined | null): string {
    if (input === undefined || input === null || input === '') return '';

    let d: Date;
    if (typeof input === 'number') {
        // Gmail internalDate 是毫秒;秒级时间戳(10 位)乘 1000
        d = new Date(input > 1e12 ? input : input * 1000);
    } else if (input instanceof Date) {
        d = input;
    } else {
        d = new Date(input);
    }

    const ts = d.getTime();
    return Number.isNaN(ts) ? '' : d.toISOString();
}
