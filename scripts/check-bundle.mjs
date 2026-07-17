// Post-build guard: the client bundle must never contain the service-role key
// or its env name. Run: npm run build && node scripts/check-bundle.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/assets';
const markers = ['SUPABASE_SERVICE_ROLE_KEY'];
const keyValue = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (keyValue) markers.push(keyValue);

let scanned = 0;
let files;
try {
  files = readdirSync(DIST);
} catch {
  console.error(`FAIL: ${DIST} not found — run "npm run build" first`);
  process.exit(1);
}
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const content = readFileSync(join(DIST, f), 'utf8');
  scanned += 1;
  for (const marker of markers) {
    if (content.includes(marker)) {
      console.error(`FAIL: dist/assets/${f} contains a service-role marker`);
      process.exit(1);
    }
  }
}
if (scanned === 0) {
  console.error('FAIL: no JS bundles found in dist/assets');
  process.exit(1);
}
console.log(
  `OK: ${scanned} bundle file(s) clean` +
    (keyValue ? ' (checked env-name AND live key value)' : ' (env key unset; env-name marker only)')
);
