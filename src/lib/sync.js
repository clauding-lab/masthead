import { supabase } from './supabase';
import {
  getAllFavorites, getAllHistory, saveFavorite, putHistoryEntry,
  removeFavorite, patchSavedArticle,
} from './db';
import sourcesData from '../../lib/sources.json';

function savedRowFromLocal(userId, f) {
  return {
    user_id: userId,
    article_id: f.id,
    url: f.url,
    title: f.title ?? null,
    byline: f.byline ?? null,
    excerpt: f.excerpt ?? null,
    content: f.content ?? null,
    content_truncated: !!f.contentTruncated,
    lead_image: f.leadImage ?? f.thumbnail ?? null,
    word_count: f.wordCount ?? null,
    source_id: f.sourceId ?? null,
    source_name: f.sourceName ?? null,
    source_color: f.sourceColor ?? null,
    is_paywall: !!f.isPaywall,
    saved_at: f.savedAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

function localFromSavedRow(r) {
  return {
    id: r.article_id,
    url: r.url,
    title: r.title,
    byline: r.byline,
    excerpt: r.excerpt,
    content: r.content,
    contentTruncated: !!r.content_truncated,
    leadImage: r.lead_image,
    thumbnail: r.lead_image,
    wordCount: r.word_count,
    sourceId: r.source_id,
    sourceName: r.source_name,
    sourceColor: r.source_color,
    isPaywall: !!r.is_paywall,
    savedAt: r.saved_at,
    savedVia: 'sync',
    pendingBody: false,
    bodyFailed: !r.content,
  };
}

export { savedRowFromLocal, localFromSavedRow };

// Shell upserts are metadata-only: omitting the content keys means ON CONFLICT
// leaves any stored body untouched (spec §4 step 5).
export async function pushSaved(userId, record) {
  if (!supabase || !userId) return;
  try {
    const row = savedRowFromLocal(userId, record);
    if (!record.content) {
      delete row.content;
      delete row.content_truncated;
    }
    await supabase
      .from('user_saved_articles')
      .upsert(row, { onConflict: 'user_id,article_id' });
  } catch (err) {
    console.error('[sync] push saved error:', err);
  }
}

// Delete = tombstone, never a row delete, so a stale peer cannot resurrect it
// (spec §7 pass 1). A link-less record can't satisfy the url CHECK, so it
// falls back to update-only (no-op if the row never synced).
export async function removeSaved(userId, { id, url }) {
  if (!supabase || !userId) return;
  const stamp = new Date().toISOString();
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await supabase.from('user_saved_articles').upsert(
        { user_id: userId, article_id: id, url, deleted_at: stamp, updated_at: stamp },
        { onConflict: 'user_id,article_id' }
      );
    } else {
      await supabase
        .from('user_saved_articles')
        .update({ deleted_at: stamp, updated_at: stamp })
        .eq('user_id', userId)
        .eq('article_id', id);
    }
  } catch (err) {
    console.error('[sync] remove saved error:', err);
  }
}

export async function syncOnSignIn(userId) {
  if (!supabase || !userId) return;

  try {
    // Saved-articles sync: three passes (spec §7).
    const localSaved = await getAllFavorites();
    const { data: cloudData } = await supabase
      .from('user_saved_articles')
      .select('*')
      .eq('user_id', userId);
    const cloud = cloudData || [];
    const cloudById = new Map(cloud.map((r) => [r.article_id, r]));
    const localById = new Map(localSaved.map((f) => [f.id, f]));

    // Pass 1: cloud tombstones are authoritative — drop local copies, never re-push.
    for (const r of cloud) {
      if (r.deleted_at && localById.has(r.article_id)) {
        await removeFavorite(r.article_id);
        localById.delete(r.article_id);
      }
    }

    // Pass 2: set difference. Push local-only (bodies included); pull live cloud-only.
    const toUpload = [...localById.values()].filter((f) => !cloudById.has(f.id));
    if (toUpload.length > 0) {
      await supabase
        .from('user_saved_articles')
        .upsert(toUpload.map((f) => savedRowFromLocal(userId, f)), { onConflict: 'user_id,article_id' });
    }
    let pulled = 0;
    for (const r of cloud) {
      if (!r.deleted_at && !localById.has(r.article_id)) {
        await saveFavorite(localFromSavedRow(r));
        pulled += 1;
      }
    }

    // Pass 3: reconcile the intersection — a body always beats a shell; two
    // bodies (or two shells) → newer stamp wins (spec §7).
    for (const r of cloud) {
      if (r.deleted_at) continue;
      const local = localById.get(r.article_id);
      if (!local) continue;
      const localHasBody = !!local.content;
      const cloudHasBody = !!r.content;
      const upgradeLocal = () =>
        patchSavedArticle(local.id, {
          title: r.title ?? local.title,
          byline: r.byline ?? local.byline ?? null,
          excerpt: r.excerpt ?? local.excerpt,
          content: r.content,
          contentTruncated: !!r.content_truncated,
          leadImage: r.lead_image ?? local.leadImage ?? null,
          wordCount: r.word_count ?? local.wordCount ?? null,
          pendingBody: false,
          bodyFailed: false,
        });
      if (localHasBody && !cloudHasBody) {
        await pushSaved(userId, local);
      } else if (!localHasBody && cloudHasBody) {
        await upgradeLocal();
      } else if (localHasBody && cloudHasBody) {
        const localAt = new Date(local.updatedAtLocal || local.savedAt || 0).getTime();
        const cloudAt = new Date(r.updated_at || 0).getTime();
        if (localAt > cloudAt) await pushSaved(userId, local);
        else if (cloudAt > localAt) await upgradeLocal();
      }
    }

    // Sync history
    const localHistory = await getAllHistory();
    const { data: remoteHistory } = await supabase
      .from('user_history')
      .select('*')
      .eq('user_id', userId);

    const remoteHistIds = new Set((remoteHistory || []).map((h) => h.article_id));
    const histToUpload = localHistory.filter((h) => !remoteHistIds.has(h.id));
    if (histToUpload.length > 0) {
      await supabase.from('user_history').upsert(
        histToUpload.map((h) => ({
          user_id: userId,
          article_id: h.id,
          title: h.title,
          url: h.url,
          source_id: h.sourceId,
          source_name: h.sourceName,
          category: h.category,
          thumbnail: h.thumbnail,
          read_at: h.readAt,
        })),
        { onConflict: 'user_id,article_id' }
      );
    }

    // Pull remote history not in local (preserving original read timestamps)
    const localHistIds = new Set(localHistory.map((h) => h.id));
    const histToDownload = (remoteHistory || []).filter((h) => !localHistIds.has(h.article_id));
    for (const h of histToDownload) {
      await putHistoryEntry({
        id: h.article_id,
        title: h.title,
        url: h.url,
        sourceId: h.source_id,
        sourceName: h.source_name,
        category: h.category,
        thumbnail: h.thumbnail,
        readAt: h.read_at,
      });
    }

    console.log(`[sync] Saved: ${toUpload.length} up, ${pulled} down; history: ${histToUpload.length} up, ${histToDownload.length} down`);
  } catch (err) {
    console.error('[sync] Error:', err);
  }
}

export function buildSourceRows(userId, ids) {
  const idSet = new Set(ids);
  return sourcesData.sources
    .filter((s) => idSet.has(s.id))
    .map((s) => ({
      user_id: userId,
      source_id: s.id,
      name: s.name,
      short_name: s.shortName,
      url: s.url,
      feed_url: s.feedUrl,
      category: s.category,
      color: s.color,
      is_default: true,
      is_enabled: true,
    }));
}

export async function pushOnboardingSources(userId, ids) {
  if (!supabase || !userId) return;
  const rows = buildSourceRows(userId, ids);
  if (rows.length === 0) return;
  const { error } = await supabase.from('user_sources').upsert(rows, { onConflict: 'user_id,source_id' });
  if (error) throw error;
  await supabase.from('profiles').update({ onboarding_completed: true }).eq('id', userId);
}

export async function pushHistoryEntry(userId, entry) {
  if (!supabase || !userId) return;
  try {
    await supabase.from('user_history').upsert({
      user_id: userId,
      article_id: entry.id,
      title: entry.title,
      url: entry.url,
      source_id: entry.sourceId,
      source_name: entry.sourceName,
      category: entry.category,
      thumbnail: entry.thumbnail,
      read_at: new Date().toISOString(),
    }, { onConflict: 'user_id,article_id' });
  } catch (err) {
    console.error('[sync] push history error:', err);
  }
}
