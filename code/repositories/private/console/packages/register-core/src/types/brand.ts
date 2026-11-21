/**
 * 品牌类型(brand types):在编译期区分语义不同的字符串,防止把 Email 误当 Phone 传入。
 * 运行时零开销(只是 string),纯类型层保护。
 */
export type Email = string & { readonly __brand: 'Email' };
export type PhoneNumber = string & { readonly __brand: 'PhoneNumber' };
export type OtpCode = string & { readonly __brand: 'OtpCode' };
export type RunId = string & { readonly __brand: 'RunId' };

/** 构造器:从普通字符串标记为品牌类型(仅做类型断言,不校验内容)。 */
export const asEmail = (s: string): Email => s as Email;
export const asPhone = (s: string): PhoneNumber => s as PhoneNumber;
export const asOtp = (s: string): OtpCode => s as OtpCode;
export const asRunId = (s: string): RunId => s as RunId;
