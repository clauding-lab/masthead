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

const useInboxStore = create((set, get) => ({
  // Final whole-branch review, F2: bumped by reset() and captured by
  // bootstrap/fetchList before their awaits and by remove()/clearRead()'s
  // rollback paths — a write whose epoch no longer matches current state is
  // stale (started before a sign-out/reset) and must be dropped rather than
  // resurrecting the previous session's data over the freshly-cleared store.
  epoch: 0,
  address: null,
  bytesUsed: 0,
  messageCount: 0,
  overQuotaSince: null,
  deferredCount: 0,
  messages: [],
  unreadCount: 0,
  isLoading: false,
  error: null,
  // errorCode (F3, Opus fix round 1): set alongside `error` by openMessage
  // ONLY, so a caller can tell a genuine miss ('PGRST116' / 'not_found')
  // apart from a transient/retryable failure (any other code, or 'unknown'
  // when the thrown error carries no .code at all). Read via
  // useInboxStore.getState() immediately after openMessage's own promise
  // settles — see InboxMessagePage.jsx.
  errorCode: null,
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
    const epoch = get().epoch; // F2: stale-write fence — see field comment above
    try {
      const token = await getAccessToken();
      if (!token) return;
      const result = await authed('GET', API);
      if (get().epoch !== epoch) return;
      applyAddressResult(set, result);
      const count = await inboxData.unreadCount();
      if (get().epoch !== epoch) return;
      set({ unreadCount: count });
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
    const epoch = get().epoch; // F2: stale-write fence — see field comment above
    set({ isLoading: true, error: null });
    try {
      const messages = await inboxData.listMessages();
      if (get().epoch !== epoch) return;
      set({ messages, isLoading: false });
    } catch (err) {
      set({ error: err?.message || 'Could not load messages', isLoading: false });
      return;
    }
    try {
      const count = await inboxData.unreadCount();
      if (get().epoch !== epoch) return;
      set({ unreadCount: count });
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
    set({ error: null, errorCode: null });
    let message;
    try {
      message = await inboxData.getMessage(id);
    } catch (err) {
      // errorCode distinguishes a genuine miss (PGRST116 — purged/foreign
      // id) from a transient failure (network, expired JWT, an unrelated
      // Supabase error) — F3, Opus fix round 1: both used to collapse to
      // the same `null` result + `error` string, and InboxMessagePage
      // rendered "This message was removed" for EITHER, which is wrong
      // for a retryable failure. `err?.code || 'unknown'` passes a real
      // code through verbatim and falls back only when the thrown error
      // carries none at all.
      set({ error: err?.message || 'Message not found', errorCode: err?.code || 'unknown' });
      return null;
    }
    if (!message) {
      // Supabase isn't configured (inboxData's own guard) — there is no
      // data layer to retry against, so this collapses to the same
      // genuine-miss bucket as PGRST116 (T13 ruling names "resolved null"
      // as one of the miss cases alongside PGRST116/deleted_at).
      set({ error: 'Message not found', errorCode: 'not_found' });
      return null;
    }
    // Final whole-branch review, F3: unreadCount() filters `deleted_at IS
    // NULL` server-side (lib/inboxData.js) — a tombstoned-but-unread row was
    // never counted in the badge to begin with, so opening it must not
    // decrement.
    const wasUnread = message.read_at === null && !message.deleted_at;
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
    const epoch = get().epoch; // F2: stale-write fence — see field comment above
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
      if (get().epoch !== epoch) return; // F2: don't resurrect into a reset store
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
    const epoch = get().epoch; // F2: stale-write fence — see field comment above
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
      if (get().epoch !== epoch) return; // F2: don't resurrect into a reset store
      set((state) => {
        const present = new Set(state.messages.map((m) => m.id));
        const toRestore = removedMessages.filter((m) => !present.has(m.id));
        return { messages: [...state.messages, ...toRestore], error: err?.message || 'Could not clear read messages' };
      });
      return;
    }
    // T18 quota-freshness fix (F9, T15 review): bytesUsed/messageCount/
    // overQuotaSince/deferredCount are only written by bootstrap + the
    // address actions, so they go stale the instant a bulk tombstone lands.
    // Re-run the address GET so the Settings meter reflects it immediately.
    // refreshQuota already swallows its own errors — a failed refresh must
    // never clobber this already-successful clearRead.
    await get().refreshQuota();
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

  // T18 quota-freshness fix (F9, T15 review, controller-routed): a
  // lightweight re-run of the same address GET (the canonical 5-key
  // applyAddressResult shape) so bytesUsed/messageCount/overQuotaSince/
  // deferredCount don't go stale in-session. Two call sites: clearRead's
  // success path above, and SettingsPage's Email Inbox section on mount
  // (SettingsPage.jsx). Swallow-never-throw, same posture as bootstrap — a
  // refresh failure must never surface as a store error or block whatever
  // triggered it.
  refreshQuota: async () => {
    const epoch = get().epoch; // F2 (A5 fold-in): stale-write fence, symmetric with bootstrap's GET half
    try {
      const token = await getAccessToken();
      if (!token) return;
      const result = await authed('GET', API);
      if (get().epoch !== epoch) return;
      applyAddressResult(set, result);
    } catch (err) {
      console.error('[inbox] quota refresh failed:', err?.message || err);
    }
  },

  reset: () => {
    set((state) => ({
      epoch: state.epoch + 1, // F2: fences off any already-in-flight write below
      address: null,
      bytesUsed: 0,
      messageCount: 0,
      overQuotaSince: null,
      deferredCount: 0,
      messages: [],
      unreadCount: 0,
      isLoading: false,
      error: null,
      errorCode: null,
      addressLoaded: false,
    }));
  },
}));

export default useInboxStore;
