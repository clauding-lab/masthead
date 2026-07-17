import { getReadClient } from './supabaseRead.js';

const MAX_LIMIT = 200;
const COLUMNS =
  'id,url,title,source_id,source_name,source_short_name,source_color,category,thumbnail,is_paywall,published_at';

export class StoreUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreUnavailableError';
  }
}

export function rowToHeadline(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceShortName: row.source_short_name,
    sourceColor: row.source_color,
    category: row.category,
    thumbnail: row.thumbnail,
    publishedAt: row.published_at,
    isPaywall: row.is_paywall,
  };
}

// Bound query-builder methods only — never string-built .or()/.filter()
// (spec §5.2 step 2: injection + unbounded-query posture).
export async function selectHeadlines(
  { sourceIds, category = null, limit = MAX_LIMIT } = {},
  client = getReadClient()
) {
  if (!client) throw new StoreUnavailableError('store read client not configured');
  const ids = (Array.isArray(sourceIds) ? sourceIds : []).filter((s) => typeof s === 'string');
  if (ids.length === 0) return [];
  const clamped = Math.min(Math.max(1, Number(limit) || MAX_LIMIT), MAX_LIMIT);
  let query = client
    .from('articles')
    .select(COLUMNS)
    .in('source_id', ids)
    .order('published_at', { ascending: false });
  if (category) query = query.eq('category', category);
  const { data, error } = await query.limit(clamped);
  if (error) throw new StoreUnavailableError(error.message);
  return (data || []).map(rowToHeadline);
}

// Global warmth probe: any row at all? (cold-vs-empty, spec §5.2 step 5)
export async function storeIsWarm(client = getReadClient()) {
  if (!client) return false;
  try {
    const { data, error } = await client.from('articles').select('id').limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}
