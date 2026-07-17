import { getAdminClient } from './supabaseAdmin.js';

// WRITE side of public.articles — poller only. The read path must never
// import this module (enforced by lib/securityBoundary.test.js).

export function headlineToRow(h) {
  return {
    source_id: h.sourceId,
    id: h.id,
    url: h.url,
    title: h.title,
    source_name: h.sourceName,
    source_short_name: h.sourceShortName,
    source_color: h.sourceColor,
    category: h.category,
    thumbnail: h.thumbnail,
    is_paywall: h.isPaywall || false,
    published_at: h.publishedAt,
    // first_seen_at deliberately omitted: DB default on insert, untouched on
    // conflict-update, so 14-day retention counts from genuine first sight.
    updated_at: new Date().toISOString(),
  };
}

// In-memory dedupe by (source_id, id), last write wins — a single upsert
// statement must never carry a duplicate PK (spec §5.1 step 3, CRITICAL-1).
export function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(`${row.source_id} ${row.id}`, row);
  return [...byKey.values()];
}

export async function upsertArticles(headlines, client = getAdminClient()) {
  const rows = dedupeRows(
    (headlines || [])
      // http(s)-only stored urls: the store must never persist a
      // javascript:/data: link a hostile feed item smuggled in.
      .filter((h) => h && h.id && h.sourceId && typeof h.url === 'string' && /^https?:\/\//i.test(h.url))
      .map(headlineToRow)
  );
  if (rows.length === 0) return 0;
  const { error } = await client.from('articles').upsert(rows, { onConflict: 'source_id,id' });
  if (error) throw new Error(`articles upsert failed: ${error.message}`);
  return rows.length;
}

export async function prune({ maxAgeDays = 14 } = {}, client = getAdminClient()) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await client.from('articles').delete({ count: 'exact' }).lt('first_seen_at', cutoff);
  if (error) throw new Error(`articles prune failed: ${error.message}`);
  return count ?? 0;
}
