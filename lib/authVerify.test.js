// lib/authVerify.test.js
import { describe, it, expect } from 'vitest';
import { requireUser, AuthError } from './authVerify.js';

const reqWith = (auth) => ({ headers: auth ? { authorization: auth } : {} });

describe('requireUser (fail-closed — spec §4.1)', () => {
  it('returns userId for a valid token', async () => {
    const getUser = async (token) => {
      expect(token).toBe('good-token');
      return { data: { user: { id: 'user-1' } }, error: null };
    };
    await expect(requireUser(reqWith('Bearer good-token'), { getUser })).resolves.toEqual({ userId: 'user-1' });
  });

  it.each([
    ['missing header', undefined],
    ['non-bearer header', 'Basic abc'],
    ['empty bearer', 'Bearer '],
  ])('throws AuthError on %s', async (_label, header) => {
    const getUser = async () => ({ data: { user: { id: 'u' } }, error: null });
    await expect(requireUser(reqWith(header), { getUser })).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError when Supabase reports an invalid token', async () => {
    const getUser = async () => ({ data: { user: null }, error: { message: 'invalid JWT' } });
    await expect(requireUser(reqWith('Bearer bad'), { getUser })).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError when the verifier itself throws (fail-closed, never fail-open)', async () => {
    const getUser = async () => { throw new Error('network down'); };
    await expect(requireUser(reqWith('Bearer any'), { getUser })).rejects.toBeInstanceOf(AuthError);
  });

  it('throws AuthError on a user object without an id', async () => {
    const getUser = async () => ({ data: { user: {} }, error: null });
    await expect(requireUser(reqWith('Bearer any'), { getUser })).rejects.toBeInstanceOf(AuthError);
  });
});
