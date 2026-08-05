import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/inboxData', () => ({
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  markRead: vi.fn(),
  removeMessage: vi.fn(),
  clearRead: vi.fn(),
  unreadCount: vi.fn(),
}));
// Fix round 1, F8: inboxStore now imports getAccessToken/authed from
// premiumApi.js rather than duplicating them — mock that module the same
// way feedStore.test.js does, one level below the store under test.
vi.mock('../lib/premiumApi', () => ({
  getAccessToken: vi.fn(),
  authed: vi.fn(),
}));

import { getAccessToken, authed } from '../lib/premiumApi';
import * as inboxData from '../lib/inboxData';
import useInboxStore from './inboxStore';

const TOKEN = 'tok-abc123';
const API = '/api/inbox-address';

const ADDRESS_RESULT = {
  address: 'reader-xy9k@mail.masthead.app',
  bytesUsed: 1024,
  messageCount: 3,
  overQuotaSince: null,
  deferredCount: 0,
};

const INITIAL_STATE = {
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
};

beforeEach(() => {
  vi.clearAllMocks();
  useInboxStore.setState(INITIAL_STATE);
  getAccessToken.mockResolvedValue(TOKEN);
});

describe('bootstrap', () => {
  it('loads the address and unread count in one go', async () => {
    authed.mockResolvedValue(ADDRESS_RESULT);
    inboxData.unreadCount.mockResolvedValue(4);

    await useInboxStore.getState().bootstrap();

    const state = useInboxStore.getState();
    expect(state.address).toBe(ADDRESS_RESULT.address);
    expect(state.bytesUsed).toBe(1024);
    expect(state.messageCount).toBe(3);
    expect(state.overQuotaSince).toBeNull();
    expect(state.deferredCount).toBe(0);
    expect(state.unreadCount).toBe(4);
    expect(state.addressLoaded).toBe(true);
  });

  it('calls authed with GET and the address API path', async () => {
    authed.mockResolvedValue(ADDRESS_RESULT);
    inboxData.unreadCount.mockResolvedValue(0);

    await useInboxStore.getState().bootstrap();

    expect(authed).toHaveBeenCalledWith('GET', API);
  });

  // Fix round 1, F7: pin the gate's actual value (no console noise on a
  // signed-out boot — that's the ordinary case, not a failure), not just
  // "authed wasn't called" (which authed's own internal token check would
  // also produce, making the earlier version of this test vacuous about
  // the explicit early-return gate specifically).
  it('gates on an active session: signed out (no access token) calls neither authed nor unreadCount, and stays silent', async () => {
    getAccessToken.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await useInboxStore.getState().bootstrap();

    expect(authed).not.toHaveBeenCalled();
    expect(inboxData.unreadCount).not.toHaveBeenCalled();
    expect(useInboxStore.getState().addressLoaded).toBe(false);
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('swallows a failure from the address API — never throws, boot-safe', async () => {
    authed.mockRejectedValue(new Error('Request failed: 500'));
    inboxData.unreadCount.mockResolvedValue(0);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(useInboxStore.getState().bootstrap()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    expect(useInboxStore.getState().addressLoaded).toBe(false);
    consoleSpy.mockRestore();
  });

  it('swallows a failure from unreadCount but keeps the address data already applied', async () => {
    authed.mockResolvedValue(ADDRESS_RESULT);
    inboxData.unreadCount.mockRejectedValue({ message: 'permission denied', code: '42501' });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(useInboxStore.getState().bootstrap()).resolves.toBeUndefined();

    const state = useInboxStore.getState();
    expect(state.address).toBe(ADDRESS_RESULT.address);
    expect(state.addressLoaded).toBe(true);
    expect(state.unreadCount).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('fetchList', () => {
  it('loads messages into state', async () => {
    const rows = [{ id: 'm1', read_at: null }, { id: 'm2', read_at: '2026-08-01T00:00:00.000Z' }];
    inboxData.listMessages.mockResolvedValue(rows);
    inboxData.unreadCount.mockResolvedValue(1);

    await useInboxStore.getState().fetchList();

    expect(useInboxStore.getState().messages).toEqual(rows);
    expect(useInboxStore.getState().isLoading).toBe(false);
  });

  // Scope add (controller ruling, T15 note): fetchList must also refresh
  // unreadCount, or the badge and an open list silently disagree once new
  // mail arrives while the tab is open.
  it('refreshes unreadCount from the server after the list applies', async () => {
    inboxData.listMessages.mockResolvedValue([]);
    inboxData.unreadCount.mockResolvedValue(7);

    await useInboxStore.getState().fetchList();

    expect(useInboxStore.getState().unreadCount).toBe(7);
  });

  it('applies the fetched list even when the unreadCount refresh rejects, and does not set an error (swallowed like bootstrap)', async () => {
    const rows = [{ id: 'm1', read_at: null }];
    inboxData.listMessages.mockResolvedValue(rows);
    inboxData.unreadCount.mockRejectedValue({ message: 'nope' });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await useInboxStore.getState().fetchList();

    expect(useInboxStore.getState().messages).toEqual(rows);
    expect(useInboxStore.getState().error).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('sets an error string (not the raw plain-object error) on a list-fetch failure, and never attempts the count refresh', async () => {
    inboxData.listMessages.mockRejectedValue({ message: 'boom', code: 'XXX' });

    await useInboxStore.getState().fetchList();

    expect(useInboxStore.getState().error).toBe('boom');
    expect(useInboxStore.getState().isLoading).toBe(false);
    expect(inboxData.unreadCount).not.toHaveBeenCalled();
  });
});

describe('openMessage', () => {
  it('fetches the full row, marks it read once, sets local read_at, and decrements unreadCount for a previously-unread message', async () => {
    useInboxStore.setState({
      messages: [{ id: 'm1', read_at: null }],
      unreadCount: 2,
    });
    inboxData.getMessage.mockResolvedValueOnce({ id: 'm1', read_at: null, html_body: '<p>x</p>' });
    inboxData.markRead.mockResolvedValueOnce(undefined);

    const result = await useInboxStore.getState().openMessage('m1');

    expect(inboxData.markRead).toHaveBeenCalledTimes(1);
    expect(inboxData.markRead).toHaveBeenCalledWith('m1');
    expect(result.html_body).toBe('<p>x</p>');
    expect(result.read_at).toEqual(expect.any(String));

    const state = useInboxStore.getState();
    expect(state.messages[0].read_at).toEqual(expect.any(String));
    expect(state.unreadCount).toBe(1);
  });

  // Fix round 1, F2: unreadCount starts at 3, not 0 — with the old fixture
  // (0), deleting the `wasUnread ? ... : state.unreadCount` gate entirely
  // still passes, because Math.max(0, 0 - 1) floors right back to 0.
  // Starting above the floor means a deleted gate visibly breaks this.
  it('re-opening an already-read message calls markRead again but never decrements unreadCount (gate pinned above the zero floor)', async () => {
    const readAt = '2026-08-01T00:00:00.000Z';
    useInboxStore.setState({
      messages: [{ id: 'm1', read_at: readAt }],
      unreadCount: 3,
    });
    inboxData.getMessage.mockResolvedValueOnce({ id: 'm1', read_at: readAt, html_body: '<p>x</p>' });
    inboxData.markRead.mockResolvedValueOnce(undefined);

    await useInboxStore.getState().openMessage('m1');

    expect(inboxData.markRead).toHaveBeenCalledTimes(1);
    expect(useInboxStore.getState().unreadCount).toBe(3);
  });

  it('opening the same message twice — first unread, then already-read on the second fetch — decrements exactly once (starts above the zero floor)', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }], unreadCount: 5 });
    inboxData.getMessage
      .mockResolvedValueOnce({ id: 'm1', read_at: null, html_body: '<p>x</p>' })
      .mockResolvedValueOnce({ id: 'm1', read_at: '2026-08-01T00:00:00.000Z', html_body: '<p>x</p>' });
    inboxData.markRead.mockResolvedValue(undefined);

    await useInboxStore.getState().openMessage('m1');
    expect(useInboxStore.getState().unreadCount).toBe(4);

    await useInboxStore.getState().openMessage('m1');
    expect(useInboxStore.getState().unreadCount).toBe(4);
    expect(inboxData.markRead).toHaveBeenCalledTimes(2);
  });

  it('catches a getMessage miss (PGRST116-style throw on a purged/foreign id) as store error state, not an unhandled rejection', async () => {
    inboxData.getMessage.mockRejectedValueOnce({ message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' });

    const result = await useInboxStore.getState().openMessage('missing');

    expect(result).toBeNull();
    expect(useInboxStore.getState().error).toBe('JSON object requested, multiple (or no) rows returned');
    expect(inboxData.markRead).not.toHaveBeenCalled();
  });

  // Fix round 1, F1: inboxData.getMessage RESOLVES null (its own
  // `!supabase` guard) rather than throwing — without the explicit null
  // check, `message.read_at` below is a TypeError on null, an unhandled
  // rejection rather than a caught store error.
  it('resolves with a store error, not a TypeError rejection, when getMessage resolves null', async () => {
    inboxData.getMessage.mockResolvedValueOnce(null);

    const result = await useInboxStore.getState().openMessage('m1');

    expect(result).toBeNull();
    expect(useInboxStore.getState().error).toBe('Message not found');
    expect(inboxData.markRead).not.toHaveBeenCalled();
  });

  it('surfaces a markRead failure as store error state without corrupting local read state', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }], unreadCount: 1 });
    inboxData.getMessage.mockResolvedValueOnce({ id: 'm1', read_at: null });
    inboxData.markRead.mockRejectedValueOnce({ message: 'nope' });

    await useInboxStore.getState().openMessage('m1');

    expect(useInboxStore.getState().error).toBe('nope');
    expect(useInboxStore.getState().unreadCount).toBe(1);
    expect(useInboxStore.getState().messages[0].read_at).toBeNull();
  });
});

describe('remove', () => {
  it('tombstones optimistically: local state drops the message before the write resolves', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }, { id: 'm2', read_at: null }], unreadCount: 2 });
    let resolveRemove;
    inboxData.removeMessage.mockReturnValue(new Promise((resolve) => { resolveRemove = resolve; }));

    const pending = useInboxStore.getState().remove('m1');

    expect(useInboxStore.getState().messages).toEqual([{ id: 'm2', read_at: null }]);
    expect(useInboxStore.getState().unreadCount).toBe(1);

    resolveRemove(undefined);
    await pending;
  });

  it('never inspects removeMessage\'s resolved value to confirm the tombstone landed', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }], unreadCount: 1 });
    inboxData.removeMessage.mockResolvedValue({ count: 0 });

    await useInboxStore.getState().remove('m1');

    expect(useInboxStore.getState().messages).toEqual([]);
    expect(useInboxStore.getState().error).toBeNull();
  });

  it('rolls back the optimistic removal and sets an error when the write fails', async () => {
    const initial = [{ id: 'm1', read_at: null }];
    useInboxStore.setState({ messages: initial, unreadCount: 1 });
    inboxData.removeMessage.mockRejectedValue({ message: 'network down' });

    await useInboxStore.getState().remove('m1');

    expect(useInboxStore.getState().messages).toEqual(initial);
    expect(useInboxStore.getState().unreadCount).toBe(1);
    expect(useInboxStore.getState().error).toBe('network down');
  });

  // Fix round 1, F3: unreadCount starts at 3, not 0 — same floor-masking
  // problem as F2.
  it('does not decrement unreadCount when removing an already-read message (gate pinned above the zero floor)', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: '2026-08-01T00:00:00.000Z' }], unreadCount: 3 });
    inboxData.removeMessage.mockResolvedValue(undefined);

    await useInboxStore.getState().remove('m1');

    expect(useInboxStore.getState().unreadCount).toBe(3);
  });

  // Fix round 1, F5: a whole-array snapshot rollback would resurrect m2
  // (tombstoned by a concurrent, already-succeeded remove()) when m1's
  // removal fails afterward. The fix re-inserts only the message THIS
  // call removed.
  it('a failed removal re-inserts only its own message, not a sibling tombstoned by a concurrent remove() that already succeeded', async () => {
    const m1 = { id: 'm1', read_at: null };
    const m2 = { id: 'm2', read_at: null };
    useInboxStore.setState({ messages: [m1, m2], unreadCount: 2 });
    let rejectM1;
    inboxData.removeMessage.mockImplementation((id) => {
      if (id === 'm1') return new Promise((_resolve, reject) => { rejectM1 = reject; });
      return Promise.resolve(undefined);
    });

    const pendingM1 = useInboxStore.getState().remove('m1');
    // m1 is optimistically gone; m2 still present.
    expect(useInboxStore.getState().messages).toEqual([m2]);

    // A concurrent remove() for m2 completes successfully while m1's
    // write is still in flight.
    await useInboxStore.getState().remove('m2');
    expect(useInboxStore.getState().messages).toEqual([]);
    expect(useInboxStore.getState().unreadCount).toBe(0);

    // Now m1's write fails — its rollback must bring back ONLY m1.
    rejectM1({ message: 'network down' });
    await pendingM1;

    expect(useInboxStore.getState().messages).toEqual([m1]);
    expect(useInboxStore.getState().unreadCount).toBe(1);
  });

  // Fix round 1, F6: every other action clears a stale error on its
  // optimistic set; remove() and clearRead() previously didn't.
  it('clears a stale error on a successful removal', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }], unreadCount: 1, error: 'previous failure' });
    inboxData.removeMessage.mockResolvedValue(undefined);

    await useInboxStore.getState().remove('m1');

    expect(useInboxStore.getState().error).toBeNull();
  });

  // Fix round 2, NEW-1: a message opened straight from a permalink
  // (fetchList() never ran) has no entry in `state.messages` — the server
  // tombstone must still fire. The old `if (!removed) return;` skipped
  // inboxData.removeMessage entirely whenever the id wasn't found locally,
  // a silent no-op T16's deep-linked reader route would have hit.
  it('still issues the server tombstone for an id absent from the local list (deep-linked message, fetchList never ran)', async () => {
    useInboxStore.setState({ messages: [] });
    inboxData.removeMessage.mockResolvedValue(undefined);

    await useInboxStore.getState().remove('m-permalink');

    expect(inboxData.removeMessage).toHaveBeenCalledWith('m-permalink');
  });

  // Fix round 2, NEW-3: unreadCount already at 0 (an inconsistent state —
  // an unread message present locally while the badge reads 0) must not
  // let a failed remove()'s rollback invent an unread. The old
  // `wasUnread ? state.unreadCount + 1` rollback was a bare delta with no
  // memory of whether the optimistic decrement actually happened (it was
  // already floored at 0 by Math.max), so the +1 manufactured a phantom
  // unread.
  it('a failed remove of an unread message does not invent an unread when unreadCount was already 0', async () => {
    useInboxStore.setState({ messages: [{ id: 'a', read_at: null }], unreadCount: 0 });
    inboxData.removeMessage.mockRejectedValue({ message: 'down' });

    await useInboxStore.getState().remove('a');

    expect(useInboxStore.getState().unreadCount).toBe(0);
  });
});

describe('clearRead', () => {
  it('drops read messages locally before the write resolves and keeps unread ones', async () => {
    useInboxStore.setState({
      messages: [
        { id: 'm1', read_at: '2026-08-01T00:00:00.000Z' },
        { id: 'm2', read_at: null },
      ],
    });
    inboxData.clearRead.mockResolvedValue(undefined);

    await useInboxStore.getState().clearRead();

    expect(useInboxStore.getState().messages).toEqual([{ id: 'm2', read_at: null }]);
  });

  it('rolls back on failure and sets an error', async () => {
    const initial = [{ id: 'm1', read_at: '2026-08-01T00:00:00.000Z' }];
    useInboxStore.setState({ messages: initial });
    inboxData.clearRead.mockRejectedValue({ message: 'nope' });

    await useInboxStore.getState().clearRead();

    expect(useInboxStore.getState().messages).toEqual(initial);
    expect(useInboxStore.getState().error).toBe('nope');
  });

  // Fix round 1, F5 (same review applied to clearRead's rollback shape): a
  // whole-array snapshot restore would drop a message that arrived
  // concurrently (e.g. via fetchList/openMessage) while the clearRead
  // write was in flight. The fix re-inserts only the read messages THIS
  // call removed, merged onto whatever is present when the failure lands.
  it('a failed clearRead re-inserts only the messages it removed, not a stale full-array snapshot — a concurrently-added message survives', async () => {
    const readA = { id: 'a', read_at: '2026-08-01T00:00:00.000Z' };
    const unreadB = { id: 'b', read_at: null };
    useInboxStore.setState({ messages: [readA, unreadB] });
    let rejectClear;
    inboxData.clearRead.mockReturnValue(new Promise((_resolve, reject) => { rejectClear = reject; }));

    const pending = useInboxStore.getState().clearRead();
    expect(useInboxStore.getState().messages).toEqual([unreadB]);

    // A new message arrives concurrently while the clearRead write is
    // still in flight (e.g. fetchList/openMessage updating state).
    const newC = { id: 'c', read_at: null };
    useInboxStore.setState((state) => ({ messages: [...state.messages, newC] }));

    rejectClear({ message: 'nope' });
    await pending;

    const messages = useInboxStore.getState().messages;
    expect(messages).toEqual(expect.arrayContaining([readA, unreadB, newC]));
    expect(messages).toHaveLength(3);
  });

  it('clears a stale error on a successful clearRead', async () => {
    useInboxStore.setState({
      messages: [{ id: 'm1', read_at: '2026-08-01T00:00:00.000Z' }],
      error: 'previous failure',
    });
    inboxData.clearRead.mockResolvedValue(undefined);

    await useInboxStore.getState().clearRead();

    expect(useInboxStore.getState().error).toBeNull();
  });

  // Fix round 2, NEW-2: the local list caps at 100 rows (inboxData.listMessages's
  // default limit) — a user with read messages beyond that page has ZERO
  // read rows locally even though the server has real rows to clear. The
  // old `if (removedMessages.length === 0) return;` skipped
  // inboxData.clearRead() entirely whenever nothing read was visible
  // locally, a silent no-op that would tombstone nothing server-side.
  it('still issues the server bulk tombstone when no read messages are visible locally (all-unread page)', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }] });
    inboxData.clearRead.mockResolvedValue(undefined);

    await useInboxStore.getState().clearRead();

    expect(inboxData.clearRead).toHaveBeenCalled();
  });

  it('still issues the server bulk tombstone when the local list is empty (clearRead before any fetchList)', async () => {
    useInboxStore.setState({ messages: [] });
    inboxData.clearRead.mockResolvedValue(undefined);

    await useInboxStore.getState().clearRead();

    expect(inboxData.clearRead).toHaveBeenCalled();
  });
});

describe('requestAddress / regenerateAddress / removeAddress', () => {
  it('requestAddress POSTs {} via authed and applies the result', async () => {
    authed.mockResolvedValue(ADDRESS_RESULT);

    await useInboxStore.getState().requestAddress();

    expect(authed).toHaveBeenCalledWith('POST', API, {});
    expect(useInboxStore.getState().address).toBe(ADDRESS_RESULT.address);
    expect(useInboxStore.getState().addressLoaded).toBe(true);
  });

  it('regenerateAddress POSTs {regenerate:true} via authed and applies the new address', async () => {
    const rotated = { ...ADDRESS_RESULT, address: 'reader-newslug@mail.masthead.app' };
    authed.mockResolvedValue(rotated);

    await useInboxStore.getState().regenerateAddress();

    expect(authed).toHaveBeenCalledWith('POST', API, { regenerate: true });
    expect(useInboxStore.getState().address).toBe(rotated.address);
  });

  it('removeAddress DELETEs via authed and applies the disabled (null-address) result', async () => {
    const disabled = { address: null, bytesUsed: 0, messageCount: 0, overQuotaSince: null, deferredCount: 0 };
    authed.mockResolvedValue(disabled);
    useInboxStore.setState({ address: ADDRESS_RESULT.address });

    await useInboxStore.getState().removeAddress();

    expect(authed).toHaveBeenCalledWith('DELETE', API);
    expect(useInboxStore.getState().address).toBeNull();
    expect(useInboxStore.getState().addressLoaded).toBe(true);
  });

  // Fix round 1, F4: overQuotaSince/deferredCount fixtures previously
  // matched the store's own initial-state defaults (null / 0), so
  // deleting those two keys from applyAddressResult kept every existing
  // assertion green. Non-default values pin that the mapping actually
  // copies them through.
  it('propagates overQuotaSince and deferredCount from the server response, not just the default null/0', async () => {
    const quotaResult = {
      address: ADDRESS_RESULT.address,
      bytesUsed: 900,
      messageCount: 500,
      overQuotaSince: '2026-08-02T09:00:00.000Z',
      deferredCount: 7,
    };
    authed.mockResolvedValue(quotaResult);

    await useInboxStore.getState().requestAddress();

    expect(useInboxStore.getState().overQuotaSince).toBe('2026-08-02T09:00:00.000Z');
    expect(useInboxStore.getState().deferredCount).toBe(7);
  });

  it('sets an error and never throws when the server rejects the request', async () => {
    authed.mockRejectedValue(new Error('Already have an address'));

    await expect(useInboxStore.getState().requestAddress()).resolves.toBeUndefined();

    expect(useInboxStore.getState().error).toBe('Already have an address');
  });

  it('sets an error when there is no access token (signed out)', async () => {
    authed.mockRejectedValue(new Error('Sign in required'));

    await useInboxStore.getState().requestAddress();

    expect(useInboxStore.getState().error).toBe('Sign in required');
  });
});

// T14 re-review probes (T15 mandatory adds): both pin behavior that a
// final-value-only assertion cannot see — a mutant can visit an invalid
// intermediate state and still land back on a correct-looking end value.
describe('concurrency safety (T14 re-review probes)', () => {
  // Probe (a): the `didDecrement` gate (`target.read_at === null &&
  // state.unreadCount > 0`) must hold DURING the optimistic update, not just
  // at the end. A mutant that drops the `&& state.unreadCount > 0` half
  // decrements unreadCount to -1 the instant remove() is called (visible to
  // a subscribed badge immediately), then a rejected write rolls it back to
  // 0 — a final-value assertion never observes the -1 that rendered
  // mid-flight. Reading unreadCount BEFORE the write settles is the only way
  // to catch it.
  it('remove: mid-flight unreadCount never dips below 0 while the write is still pending', async () => {
    useInboxStore.setState({ messages: [{ id: 'a', read_at: null }], unreadCount: 0, error: null });
    let rejectRemove;
    inboxData.removeMessage.mockReturnValue(new Promise((_resolve, reject) => { rejectRemove = reject; }));

    const pending = useInboxStore.getState().remove('a');
    const midFlight = useInboxStore.getState().unreadCount; // what a subscribed badge renders right now

    rejectRemove({ message: 'down' });
    await pending;

    expect(midFlight).toBe(0);
    expect(useInboxStore.getState().unreadCount).toBe(0);
  });

  // Probe (b): openMessage's `Math.max(0, state.unreadCount - 1)` floor
  // (inboxStore.js:133) is load-bearing on its own — remove()'s comment that
  // its own floor was a no-op does NOT transfer here, because openMessage
  // has no `didDecrement`-style gate keeping it above zero in the first
  // place. A concurrent remove() can drive unreadCount to 0 before
  // openMessage's own decrement lands; without the floor that final
  // decrement goes negative.
  it('openMessage: concurrent remove driving unreadCount to 0 followed by an openMessage decrement never goes negative', async () => {
    useInboxStore.setState({
      messages: [{ id: 'a', read_at: null }, { id: 'b', read_at: null }],
      unreadCount: 1,
      error: null,
    });
    inboxData.removeMessage.mockResolvedValue(undefined);
    inboxData.getMessage.mockResolvedValue({ id: 'b', read_at: null });
    inboxData.markRead.mockResolvedValue(undefined);

    await Promise.all([useInboxStore.getState().remove('a'), useInboxStore.getState().openMessage('b')]);

    expect(useInboxStore.getState().unreadCount).toBeGreaterThanOrEqual(0);
  });
});

describe('reset', () => {
  it('clears every field back to its initial value', () => {
    useInboxStore.setState({
      address: 'reader-xy9k@mail.masthead.app',
      bytesUsed: 500,
      messageCount: 2,
      overQuotaSince: '2026-08-01T00:00:00.000Z',
      deferredCount: 3,
      messages: [{ id: 'm1' }],
      unreadCount: 5,
      isLoading: true,
      error: 'boom',
      addressLoaded: true,
    });

    useInboxStore.getState().reset();

    expect(useInboxStore.getState()).toMatchObject(INITIAL_STATE);
  });
});
