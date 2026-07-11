// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { consentAwareStorage } from './supabase.js';

describe('consentAwareStorage', () => {
  beforeEach(() => localStorage.clear());

  it('does not persist when consent is absent or declined', () => {
    consentAwareStorage.setItem('sb-token', 'x');
    expect(localStorage.getItem('sb-token')).toBeNull();
    localStorage.setItem('masthead-cookieConsent', 'false');
    consentAwareStorage.setItem('sb-token', 'x');
    expect(localStorage.getItem('sb-token')).toBeNull();
  });

  it('persists once consent is granted — even if granted after module load', () => {
    localStorage.setItem('masthead-cookieConsent', 'true');
    consentAwareStorage.setItem('sb-token', 'x');
    expect(localStorage.getItem('sb-token')).toBe('x');
  });

  it('always reads and removes', () => {
    localStorage.setItem('sb-token', 'y');
    expect(consentAwareStorage.getItem('sb-token')).toBe('y');
    consentAwareStorage.removeItem('sb-token');
    expect(localStorage.getItem('sb-token')).toBeNull();
  });
});
