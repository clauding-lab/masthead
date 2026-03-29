import { supabase } from './supabase';
import { getAllFavorites, getAllHistory, saveFavorite, addToHistory } from './db';

export async function syncOnSignIn(userId) {
  if (!supabase || !userId) return;

  try {
    // Sync favorites: merge local -> remote and remote -> local
    const localFavs = await getAllFavorites();
    const { data: remoteFavs } = await supabase
      .from('user_favorites')
      .select('*')
      .eq('user_id', userId);

    // Push local favorites not in remote
    const remoteIds = new Set((remoteFavs || []).map((f) => f.article_id));
    const toUpload = localFavs.filter((f) => !remoteIds.has(f.id));
    if (toUpload.length > 0) {
      await supabase.from('user_favorites').upsert(
        toUpload.map((f) => ({
          user_id: userId,
          article_id: f.id,
          title: f.title,
          url: f.url,
          source_id: f.sourceId,
          source_name: f.sourceName,
          category: f.category,
          thumbnail: f.thumbnail,
          excerpt: f.excerpt,
          saved_at: f.savedAt,
        })),
        { onConflict: 'user_id,article_id' }
      );
    }

    // Pull remote favorites not in local
    const localIds = new Set(localFavs.map((f) => f.id));
    const toDownload = (remoteFavs || []).filter((f) => !localIds.has(f.article_id));
    for (const f of toDownload) {
      await saveFavorite({
        id: f.article_id,
        title: f.title,
        url: f.url,
        sourceId: f.source_id,
        sourceName: f.source_name,
        category: f.category,
        thumbnail: f.thumbnail,
        excerpt: f.excerpt,
      });
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

    console.log(`[sync] Synced ${toUpload.length} favs up, ${toDownload.length} down, ${histToUpload.length} history up`);
  } catch (err) {
    console.error('[sync] Error:', err);
  }
}

export async function pushFavorite(userId, article) {
  if (!supabase || !userId) return;
  try {
    await supabase.from('user_favorites').upsert({
      user_id: userId,
      article_id: article.id,
      title: article.title,
      url: article.url,
      source_id: article.sourceId,
      source_name: article.sourceName,
      category: article.category,
      thumbnail: article.thumbnail || article.leadImage,
      excerpt: article.excerpt,
      saved_at: new Date().toISOString(),
    }, { onConflict: 'user_id,article_id' });
  } catch (err) {
    console.error('[sync] push favorite error:', err);
  }
}

export async function removeFavoriteRemote(userId, articleId) {
  if (!supabase || !userId) return;
  try {
    await supabase.from('user_favorites').delete()
      .eq('user_id', userId)
      .eq('article_id', articleId);
  } catch (err) {
    console.error('[sync] remove favorite error:', err);
  }
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
