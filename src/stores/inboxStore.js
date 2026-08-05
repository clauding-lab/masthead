// src/stores/inboxStore.js — client state for the newsletter inbox (Phase
// 3b). Two data sources, both browser-side and RLS-scoped: `lib/inboxData`
// for the message table (list/read/tombstone), and `/api/inbox-address`
// (Task 8) for the ingest-address lifecycle, called the same way
// `premiumApi.js` calls `/api/premium-feeds` — a bearer token from the
// current Supabase session, never the admin client.
//
// `inboxData`'s functions throw the raw supabase-js error shape
// (`{message, code, ...}`), not `Error` instances (landmine: never branch
// on `instanceof Error` here — read `err?.message`).
import { create } from 'zustand';
import { supabase } from '../lib/supabase';
import * as inboxData from '../lib/inboxData';

const API = '/api/inbox-address';

async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

// Mirrors premiumApi.js's `authed()` exactly — same header/body/error shape
// — but stays local to this file rather than a new lib module (surgical
// scope for this task).
async function authed(method, path, body) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sign in required');
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

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
  // let a signed-out boot generate a noisy, expected-to-fail round trip.
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

  fetchList: async () => {
    set({ isLoading: true, error: null });
    try {
      const messages = await inboxData.listMessages();
      set({ messages, isLoading: false });
    } catch (err) {
      set({ error: err?.message || 'Could not load messages', isLoading: false });
    }
  },

  // getMessage + markRead + local read_at set + unreadCount decrement.
  // markRead is unconditional (fired every open, even a re-open of an
  // already-read message) — the decrement is gated on the row's OWN
  // `read_at` as fetched just now, the only reliable signal that the
  // message was actually unread before this open, so re-opening an
  // already-read message can never drive the badge negative.
  //
  // A miss (purged row, foreign id) makes getMessage throw a PGRST116
  // error rather than resolve null — caught here and surfaced as store
  // error state, never an unhandled rejection.
  openMessage: async (id) => {
    set({ error: null });
    let message;
    try {
      message = await inboxData.getMessage(id);
    } catch (err) {
      set({ error: err?.message || 'Message not found' });
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

  // Optimistic tombstone: local state updates before the write resolves.
  // removeMessage's resolved value can't confirm the tombstone landed (a
  // 0-row update is indistinguishable from success), so this never
  // inspects a return value to "confirm" anything — only a thrown error
  // rolls the optimistic update back.
  remove: async (id) => {
    const prevMessages = get().messages;
    const prevUnreadCount = get().unreadCount;
    const removed = prevMessages.find((m) => m.id === id);
    set({
      messages: prevMessages.filter((m) => m.id !== id),
      unreadCount: removed && removed.read_at === null ? Math.max(0, prevUnreadCount - 1) : prevUnreadCount,
    });
    try {
      await inboxData.removeMessage(id);
    } catch (err) {
      set({ messages: prevMessages, unreadCount: prevUnreadCount, error: err?.message || 'Could not remove message' });
    }
  },

  clearRead: async () => {
    const prevMessages = get().messages;
    set({ messages: prevMessages.filter((m) => m.read_at === null) });
    try {
      await inboxData.clearRead();
    } catch (err) {
      set({ messages: prevMessages, error: err?.message || 'Could not clear read messages' });
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
