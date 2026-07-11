import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveCorsOrigin, clientIp } from './httpGuards.js';

describe('resolveCorsOrigin', () => {
  const OLD = process.env.ALLOWED_ORIGINS;
  beforeEach(() => { process.env.ALLOWED_ORIGINS = 'https://masthead.example.com'; });
  afterEach(() => { process.env.ALLOWED_ORIGINS = OLD; });

  it('echoes an allowed origin', () => {
    expect(resolveCorsOrigin('https://masthead.example.com')).toBe('https://masthead.example.com');
  });
  it('allows localhost dev origins', () => {
    expect(resolveCorsOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });
  it('falls back to the first configured origin for unknown origins', () => {
    expect(resolveCorsOrigin('https://evil.example.com')).toBe('https://masthead.example.com');
  });
});

describe('clientIp', () => {
  it('takes the first x-forwarded-for entry', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } })).toBe('1.2.3.4');
  });
  it('falls back to socket address, then unknown', () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } })).toBe('9.9.9.9');
    expect(clientIp({ headers: {} })).toBe('unknown');
  });
});
