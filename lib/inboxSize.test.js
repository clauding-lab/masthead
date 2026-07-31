import { describe, it, expect } from 'vitest';
import { messageBytes } from './inboxSize.js';

describe('messageBytes', () => {
  it('counts UTF-8 octets, not JS chars', () => {
    expect(messageBytes('abc', '')).toBe(3);
    expect(messageBytes('é', '')).toBe(2);        // U+00E9
    expect(messageBytes('中', '')).toBe(3);        // CJK
    expect(messageBytes('—', '')).toBe(3);        // em-dash
    expect(messageBytes(' ', '')).toBe(2);   // NBSP
    expect(messageBytes('😀', '')).toBe(4);       // astral plane (JS length 2)
  });
  it('sums both parts and treats null/undefined as empty', () => {
    expect(messageBytes('ab', 'cd')).toBe(4);
    expect(messageBytes(null, undefined)).toBe(0);
  });
});
