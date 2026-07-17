import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (/\.(js|jsx|mjs)$/.test(entry)) files.push(p);
  }
  return files;
}

// Spec §6: a documented landmine is a live hole until a failing test enforces it.
describe('service-role import boundary', () => {
  it('no src/** file imports supabaseAdmin or articlesWrite, or names the service-role key', () => {
    for (const f of walk('src')) {
      const content = readFileSync(f, 'utf8');
      expect(content, f).not.toMatch(/supabaseAdmin|articlesWrite|SERVICE_ROLE/);
    }
  });
  it('supabaseAdmin has a browser tripwire and never reads a VITE_ name', () => {
    const content = readFileSync('lib/supabaseAdmin.js', 'utf8');
    expect(content).toMatch(/typeof window !== 'undefined'/);
    expect(content).not.toMatch(/VITE_/);
  });
  it('the read-path modules never reference the admin factory', () => {
    for (const f of ['lib/supabaseRead.js', 'lib/articlesRepo.js', 'lib/feedService.js']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/supabaseAdmin|SERVICE_ROLE/);
    }
  });
});
