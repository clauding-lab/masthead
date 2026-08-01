import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (/\.(js|jsx|mjs)$/.test(entry)) files.push(p);
  }
  return files;
}

function importSpecifiers(content) {
  const specs = [];
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) specs.push(m[1] || m[2] || m[3]);
  return specs;
}

function resolveRelative(fromFile, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Spec §6: a documented landmine is a live hole until a failing test enforces it.
describe('service-role import boundary', () => {
  it('no src/** file imports supabaseAdmin or articlesWrite, or names the service-role key', () => {
    for (const f of walk('src')) {
      const content = readFileSync(f, 'utf8');
      expect(content, f).not.toMatch(/supabaseAdmin|articlesWrite|SERVICE_ROLE/);
    }
  });
  it('no src/** file reaches supabaseAdmin or articlesWrite through ANY import chain', () => {
    const banned = new Set([resolve('lib/supabaseAdmin.js'), resolve('lib/articlesWrite.js')]);
    const visited = new Set();
    const queue = walk('src').map((f) => [resolve(f), [f]]);
    while (queue.length > 0) {
      const [file, chain] = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      expect(banned.has(file), `forbidden import chain: ${chain.join(' → ')}`).toBe(false);
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        const next = resolveRelative(file, spec);
        if (next) queue.push([next, [...chain, next]]);
      }
    }
    expect(visited.size).toBeGreaterThan(0);
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
  it('only the allowlisted lib/** files import lib/supabaseAdmin.js', () => {
    // Permitted importers of the service-role client (extend deliberately, one at a time):
    //   lib/articlesWrite.js — poller write path
    //   lib/authVerify.js    — shared fail-closed JWT verifier (spec §4.1)
    //   lib/premiumRepo.js   — service-role CRUD for user_premium_feeds (spec §3.2)
    //   lib/inboxRepo.js     — service-role CRUD for the newsletter inbox (spec §4)
    const permitted = new Set([
      resolve('lib/articlesWrite.js'),
      resolve('lib/authVerify.js'),
      resolve('lib/premiumRepo.js'),
      resolve('lib/inboxRepo.js'),
    ]);
    const target = resolve('lib/supabaseAdmin.js');
    for (const f of walk('lib')) {
      const file = resolve(f);
      if (file === target) continue;
      const importsAdmin = importSpecifiers(readFileSync(file, 'utf8')).some(
        (spec) => resolveRelative(file, spec) === target
      );
      if (importsAdmin) {
        expect(permitted.has(file), `unpermitted lib/supabaseAdmin.js importer: ${f}`).toBe(true);
      }
    }
  });
  it('the bundle leak guard is wired into the production build', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.build).toContain('check-bundle');
  });
});
