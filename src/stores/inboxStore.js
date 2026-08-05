// src/stores/inboxStore.js — client state for the newsletter inbox (Phase
// 3b). Two data sources, both browser-side and RLS-scoped: `lib/inboxData`
// for the message table (list/read/tombstone), and `/api/inbox-address`
// (Task 8) for the ingest-address lifecycle, called the same way
// `premiumApi.js` calls `/api/premium-feeds` — literally: `getAccessToken`
// and the generic bearer-token fetch helper `authed` are imported FROM
// `../lib/premiumApi` rather than duplicated here (Fix round 1, F8 — this
// store isn't premium-specific and neither is `authed`; only the API path
// differs per call).
//
// `inboxData`'s functions throw the raw supabase-js error shape
// (`{message, code, ...}`), not `Error` instances (landmine: never branch
// on `instanceof Error` here — read `err?.message`). `inboxData.getMessage`
// also RESOLVES null rather than throwing when Supabase isn't configured
// (its own `!supabase` guard) — a miss that is not an exception, handled
// separately from the PGRST116 "no row" throw (Fix round 1, F1).
import { create } from 'zustand';
import { getAccessToken, authed } from '../lib/premiumApi';
import * as inboxData from '../lib/inboxData';

const API = '/api/inbox-address';

// api/inbox-address.mjs's canonical 5-key response shape, applied verbatim
// across bootstrap/requestAddress/regenerateAddress/removeAddress so the
// four call sites can't drift on which fields they update.
function applyAddressResult(set, result) {
  set({
    address: result.address,
    bytesUsed: result.bytesUsed,
    messageCount: result.messageCount,
    overQuotaSince: result.overQuotaSince,
    deferredCount: result.deferredCount,
    addressLoaded: true,
  });
}

const useInboxStore = create((set) => ({
  address: null,
  bytesUsed: 0,
  messageCount: 0,
  overQuotaSince: null,
  deferredCount: 0,
  messages: [],
  unreadCount: 0,
  isLoading: false,
  error: null,
  addressLoaded: false,

  // Address + unread count populated on every session-establishing path
  // (mirrors bootstrapPremiumFeeds in authStore.js, landmine 20): without
  // this, the Inbox tab and its unread badge stay empty until a user
  // happens to visit the tab. Fire-and-forget from authStore, and this
  // must never break app boot — any failure is swallowed, logged, not
  // thrown.
  //
  // Gated on an active session: inboxData's queries run under RLS and fail
  // LOUD (42501 permission error) when signed out, and the address GET
  // needs a bearer token regardless — bail before either call rather than
  // let a signed-out boot generate a noisy, expected-to-fail round trip
  // (no console output either — a signed-out boot is the ordinary case,
  // not a failure).
  bootstrap: async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      applyAddressResult(set, await authed('GET', API));
      set({ unreadCount: await inboxData.unreadCount() });
    } catch (err) {
      console.error('[inbox] bootstrap failed:', err?.message || err);
    }
  },

  // Re-fetches the full list, then refreshes the unread count from the
  // server — a badge and an open list would otherwise silently disagree
  // once new mail arrives while the tab stays open. The count refresh is
  // best-effort ONLY: applied after the list, and a failure there must not
  // discard the list that already loaded or surface as a store error —
  // same swallow posture as bootstrap (logged, never thrown, never masks
  // a real list-fetch failure).
  fetchList: async () => {
    set({ isLoading: true, error: null });
    try {
      const messages = await inboxData.listMessages();
      set({ messages, isLoading: false });
    } catch (err) {
      set({ error: err?.message || 'Could not load messages', isLoading: false });
      return;
    }
    try {
      set({ unreadCount: await inboxData.unreadCount() });
    } catch (err) {
      console.error('[inbox] fetchList unread-count refresh failed:', err?.message || err);
    }
  },

  // getMessage + markRead + local read_at set + unreadCount decrement.
  // markRead is unconditional (fired every open, even a re-open of an
  // already-read message) — the decrement is gated on the row's OWN
  // `read_at` as fetched just now, the only reliable signal that the
  // message was actually unread before this open, so re-opening an
  // already-read message can never drive the badge negative.
  //
  // Two distinct "no row" outcomes from getMessage, handled separately: a
  // PGRST116 throw (purged/foreign id — a real miss) is caught and
  // surfaced as store error state, never an unhandled rejection; a
  // resolved `null` (Supabase unconfigured — inboxData's own guard) is
  // checked explicitly before touching `message.read_at`, or that access
  // is a TypeError on undefined, itself an unhandled rejection (Fix round
  // 1, F1).
  openMessage: async (id) => {
    set({ error: null });
    let message;
    try {
      message = await inboxData.getMessage(id);
    } catch (err) {
      set({ error: err?.message || 'Message not found' });
      return null;
    }
    if (!message) {
      set({ error: 'Message not found' });
      return null;
    }
    const wasUnread = message.read_at === null;
    const now = new Date().toISOString();
    try {
      await inboxData.markRead(id);
    } catch (err) {
      set({ error: err?.message || 'Could not mark message as read' });
      return { ...message };
    }
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, read_at: m.read_at || now } : m)),
      unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
    }));
    return { ...message, read_at: message.read_at || now };
  },

  // Optimistic tombstone. Captures the removed message + its prior
  // read-state via a functional `set()` update (reads fresh state, not a
  // stale closure) so a concurrent action touching other messages during
  // the await isn't clobbered. removeMessage's resolved value can't
  // confirm the tombstone landed (a 0-row update is indistinguishable from
  // success), so it's never inspected — only a THROWN error rolls back.
  // On failure, only THIS message is re-inserted (never a whole-array
  // snapshot restore, which would resurrect a sibling tombstoned by a
  // concurrent remove()/clearRead() that succeeded while this one was
  // still in flight — Fix round 1, F5), and the unreadCount rollback is a
  // delta (+1 iff this removal had decremented it), not a stale count
  // snapshot.
  //
  // The server tombstone ALWAYS fires, regardless of whether `id` is
  // present in `state.messages` (Fix round 2, NEW-1): a deep-linked
  // message (opened straight from a permalink, `fetchList()` never ran)
  // has no local list entry to find, but the row on the server is just as
  // real and must still be removed — `messages.find` returning nothing is
  // reason to skip the LOCAL optimistic update and its rollback bookkeeping,
  // never reason to skip the write itself.
  remove: async (id) => {
    let removed = null;
    let didDecrement = false;
    set((state) => {
      const target = state.messages.find((m) => m.id === id);
      if (!target) return { error: null };
      removed = target;
      // Fix round 2, NEW-3: only a decrement that actually happened earns
      // a rollback increment. Gating on `state.unreadCount > 0` here means
      // an inconsistent state (an unread message locally present while the
      // badge already reads 0) can't have a failed remove() invent an
      // unread that was never counted — Math.max's floor below is a NO-OP
      // in that case, and didDecrement records that fact precisely.
      didDecrement = target.read_at === null && state.unreadCount > 0;
      return {
        messages: state.messages.filter((m) => m.id !== id),
        unreadCount: didDecrement ? state.unreadCount - 1 : state.unreadCount,
        error: null,
      };
    });
    try {
      await inboxData.removeMessage(id);
    } catch (err) {
      set((state) => ({
        messages: removed && !state.messages.some((m) => m.id === id) ? [...state.messages, removed] : state.messages,
        unreadCount: didDecrement ? state.unreadCount + 1 : state.unreadCount,
        error: err?.message || 'Could not remove message',
      }));
    }
  },

  // Same single-item rollback discipline as remove(): captures exactly the
  // set of read messages THIS call is tombstoning, and on failure
  // re-inserts only those still missing — never a full-array snapshot,
  // which would clobber a message added or removed by a different action
  // while this bulk write was in flight.
  //
  // The server bulk tombstone ALWAYS fires (Fix round 2, NEW-2): the local
  // list caps at 100 rows (`inboxData.listMessages`'s default `limit`), so
  // a user with read messages beyond that page has ZERO read rows in
  // `state.messages` even though the server has real rows to clear — an
  // empty local `removedMessages` is reason to skip the local optimistic
  // update (nothing to remove from a list that doesn't show it), never
  // reason to skip the write.
  clearRead: async () => {
    let removedMessages = [];
    set((state) => {
      removedMessages = state.messages.filter((m) => m.read_at !== null);
      if (removedMessages.length === 0) return { error: null };
      return {
        messages: state.messages.filter((m) => m.read_at === null),
        error: null,
      };
    });
    try {
      await inboxData.clearRead();
    } catch (err) {
      set((state) => {
        const present = new Set(state.messages.map((m) => m.id));
        const toRestore = removedMessages.filter((m) => !present.has(m.id));
        return { messages: [...state.messages, ...toRestore], error: err?.message || 'Could not clear read messages' };
      });
    }
  },

  requestAddress: async () => {
    set({ error: null });
    try {
      applyAddressResult(set, await authed('POST', API, {}));
    } catch (err) {
      set({ error: err?.message || 'Could not create your inbox address' });
    }
  },

  regenerateAddress: async () => {
    set({ error: null });
    try {
      applyAddressResult(set, await authed('POST', API, { regenerate: true }));
    } catch (err) {
      set({ error: err?.message || 'Could not regenerate your inbox address' });
    }
  },

  removeAddress: async () => {
    set({ error: null });
    try {
      applyAddressResult(set, await authed('DELETE', API));
    } catch (err) {
      set({ error: err?.message || 'Could not remove your inbox address' });
    }
  },

  reset: () => {
    set({
      address: null,
      bytesUsed: 0,
      messageCount: 0,
      overQuotaSince: null,
      deferredCount: 0,
      messages: [],
      unreadCount: 0,
      isLoading: false,
      error: null,
      addressLoaded: false,
    });
  },
}));

export default useInboxStore;
