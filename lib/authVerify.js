// Shared JWT verification for authenticated API routes (spec §4.1).
// FAIL-CLOSED: any failure of the verification step itself — network error,
// timeout, malformed token, thrown exception — is an AuthError (→ 401 at the
// route). This deliberately does NOT inherit lib/rateLimit.js's fail-open
// posture: that pattern is for abuse-mitigation availability, not identity.
import { getAdminClient } from './supabaseAdmin.js';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

function defaultGetUser(token) {
  return getAdminClient().auth.getUser(token);
}

export async function requireUser(req, { getUser = defaultGetUser } = {}) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  if (!header.startsWith('Bearer ')) throw new AuthError('Missing bearer token');
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw new AuthError('Empty bearer token');
  try {
    const { data, error } = await getUser(token);
    if (error || !data?.user?.id) throw new AuthError('Invalid token');
    return { userId: data.user.id };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError('Verification failed');
  }
}
