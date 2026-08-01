import { describe, it, expect } from 'vitest';
import { MAX_RAW_BYTES as WORKER_MAX_RAW_BYTES } from './worker.js';
import { MAX_RAW_BYTES as LIB_MAX_RAW_BYTES } from '../lib/inboxConfig.js';

// Landmine-enforcing test (repo rule: "a documented landmine is a live hole
// until a failing test enforces the mitigation"). worker.js cannot import
// lib/inboxConfig.js (a separate Cloudflare deployable vs. a Vercel
// serverless bundle), so its MAX_RAW_BYTES is a hand-duplicated literal.
// README.md documents lib/inboxConfig.js as the source of truth, but a doc
// comment enforces nothing on its own -- if the two values ever drift with
// the lib value raised, the Worker's pre-gate would permanently bounce
// "Message too large" on mail the API would still accept: exactly the
// wrongful-bounce class the spec's no-bounce posture forbids. This test is
// the enforcement.
describe('MAX_RAW_BYTES parity (worker.js vs. lib/inboxConfig.js)', () => {
  it('stays in sync with the source of truth', () => {
    expect(WORKER_MAX_RAW_BYTES).toBe(LIB_MAX_RAW_BYTES);
  });
});
