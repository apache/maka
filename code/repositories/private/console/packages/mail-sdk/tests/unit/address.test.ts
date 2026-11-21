import { describe, it, expect } from 'vitest';
import { parseAddressHeader, firstAddress } from '../../src/core/address.js';

describe('parseAddressHeader', () => {
    it('解析 "Name" <addr>', () => {
        expect(parseAddressHeader('"Alice" <alice@example.com>')).toEqual([{ name: 'Alice', address: 'alice@example.com' }]);
    });
    it('解析 Name <addr>(无引号显示名)', () => {
        expect(parseAddressHeader('Bob <bob@example.com>')[0]).toEqual({ name: 'Bob', address: 'bob@example.com' });
    });
    it('解析多地址', () => {
        const r = parseAddressHeader('"A" <a@x.com>, b@y.com');
        expect(r).toHaveLength(2);
        expect(r[1]).toEqual({ address: 'b@y.com' });
    });
    it('解析裸地址', () => {
        expect(parseAddressHeader('bare@example.com')).toEqual([{ address: 'bare@example.com' }]);
    });
    it('地址归一为小写', () => {
        expect(parseAddressHeader('<Mixed@Case.COM>')[0]?.address).toBe('mixed@case.com');
    });
    it('空/非法返回 []', () => {
        expect(parseAddressHeader('')).toEqual([]);
        expect(parseAddressHeader(null)).toEqual([]);
        expect(parseAddressHeader(undefined)).toEqual([]);
    });
});

describe('firstAddress', () => {
    it('取第一个', () => {
        expect(firstAddress('"X" <x@y.com>, z@w.com')?.address).toBe('x@y.com');
    });
    it('空返回 null', () => {
        expect(firstAddress('')).toBeNull();
    });
});
