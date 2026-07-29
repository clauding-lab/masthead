// lib/hostHint.test.js
import { describe, it, expect } from 'vitest';
import { registrableDomain } from './hostHint.js';

describe('registrableDomain (spec §3.1 — tokens can hide in subdomain labels)', () => {
  it('reduces a plain hostname to itself', () => {
    expect(registrableDomain('https://theverge.com/rss/full.xml')).toBe('theverge.com');
  });
  it('drops subdomain labels (token-bearing subdomains never reach the client)', () => {
    expect(registrableDomain('https://a8f3k2j9x7q1.feeds.example.com/rss')).toBe('example.com');
  });
  it('handles multi-part public suffixes', () => {
    expect(registrableDomain('https://secret123.newsletter.co.uk/feed')).toBe('newsletter.co.uk');
  });
  it('throws on an unparseable URL', () => {
    expect(() => registrableDomain('not a url')).toThrow();
  });
});
