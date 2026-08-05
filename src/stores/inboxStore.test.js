import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/inboxData', () => ({
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  markRead: vi.fn(),
  removeMessage: vi.fn(),
  clearRead: vi.fn(),
  unreadCount: vi.fn(),
}));
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

import { supabase } from '../lib/supabase';
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

function mockFetchOnce(status, body) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = fn;
  return fn;
}

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
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: TOKEN } } });
});

describe('bootstrap', () => {
  it('loads the address and unread count in one go', async () => {
    mockFetchOnce(200, ADDRESS_RESULT);
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

  it('sends the address GET with a bearer token', async () => {
    const fetchMock = mockFetchOnce(200, ADDRESS_RESULT);
    inboxData.unreadCount.mockResolvedValue(0);

    await useInboxStore.getState().bootstrap();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(API);
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('gates on an active session: signed out (no access token) calls neither the address API nor unreadCount', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await useInboxStore.getState().bootstrap();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(inboxData.unreadCount).not.toHaveBeenCalled();
    expect(useInboxStore.getState().addressLoaded).toBe(false);
  });

  it('swallows a failure from the address API — never throws, boot-safe', async () => {
    mockFetchOnce(500, {});
    inboxData.unreadCount.mockResolvedValue(0);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(useInboxStore.getState().bootstrap()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();
    expect(useInboxStore.getState().addressLoaded).toBe(false);
    consoleSpy.mockRestore();
  });

  it('swallows a failure from unreadCount but keeps the address data already applied', async () => {
    mockFetchOnce(200, ADDRESS_RESULT);
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

    await useInboxStore.getState().fetchList();

    expect(useInboxStore.getState().messages).toEqual(rows);
    expect(useInboxStore.getState().isLoading).toBe(false);
  });

  it('sets an error string (not the raw plain-object error) on failure', async () => {
    inboxData.listMessages.mockRejectedValue({ message: 'boom', code: 'XXX' });

    await useInboxStore.getState().fetchList();

    expect(useInboxStore.getState().error).toBe('boom');
    expect(useInboxStore.getState().isLoading).toBe(false);
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

  it('re-opening an already-read message calls markRead again but never decrements unreadCount below its floor (gated on the fetched row\'s own read_at)', async () => {
    const readAt = '2026-08-01T00:00:00.000Z';
    useInboxStore.setState({
      messages: [{ id: 'm1', read_at: readAt }],
      unreadCount: 0,
    });
    inboxData.getMessage.mockResolvedValueOnce({ id: 'm1', read_at: readAt, html_body: '<p>x</p>' });
    inboxData.markRead.mockResolvedValueOnce(undefined);

    await useInboxStore.getState().openMessage('m1');

    expect(inboxData.markRead).toHaveBeenCalledTimes(1);
    expect(useInboxStore.getState().unreadCount).toBe(0);
  });

  it('opening the same message twice — first unread, then already-read on the second fetch — decrements exactly once', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: null }], unreadCount: 1 });
    inboxData.getMessage
      .mockResolvedValueOnce({ id: 'm1', read_at: null, html_body: '<p>x</p>' })
      .mockResolvedValueOnce({ id: 'm1', read_at: '2026-08-01T00:00:00.000Z', html_body: '<p>x</p>' });
    inboxData.markRead.mockResolvedValue(undefined);

    await useInboxStore.getState().openMessage('m1');
    expect(useInboxStore.getState().unreadCount).toBe(0);

    await useInboxStore.getState().openMessage('m1');
    expect(useInboxStore.getState().unreadCount).toBe(0);
    expect(inboxData.markRead).toHaveBeenCalledTimes(2);
  });

  it('catches a getMessage miss (PGRST116-style throw on a purged/foreign id) as store error state, not an unhandled rejection', async () => {
    inboxData.getMessage.mockRejectedValueOnce({ message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' });

    const result = await useInboxStore.getState().openMessage('missing');

    expect(result).toBeNull();
    expect(useInboxStore.getState().error).toBe('JSON object requested, multiple (or no) rows returned');
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

  it('does not decrement unreadCount when removing an already-read message', async () => {
    useInboxStore.setState({ messages: [{ id: 'm1', read_at: '2026-08-01T00:00:00.000Z' }], unreadCount: 0 });
    inboxData.removeMessage.mockResolvedValue(undefined);

    await useInboxStore.getState().remove('m1');

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
});

describe('requestAddress / regenerateAddress / removeAddress', () => {
  it('requestAddress POSTs {} and applies the result', async () => {
    const fetchMock = mockFetchOnce(200, ADDRESS_RESULT);

    await useInboxStore.getState().requestAddress();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(API);
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({});
    expect(useInboxStore.getState().address).toBe(ADDRESS_RESULT.address);
    expect(useInboxStore.getState().addressLoaded).toBe(true);
  });

  it('regenerateAddress POSTs {regenerate:true} and applies the new address', async () => {
    const rotated = { ...ADDRESS_RESULT, address: 'reader-newslug@mail.masthead.app' };
    const fetchMock = mockFetchOnce(200, rotated);

    await useInboxStore.getState().regenerateAddress();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ regenerate: true });
    expect(useInboxStore.getState().address).toBe(rotated.address);
  });

  it('removeAddress DELETEs and applies the disabled (null-address) result', async () => {
    const disabled = { address: null, bytesUsed: 0, messageCount: 0, overQuotaSince: null, deferredCount: 0 };
    const fetchMock = mockFetchOnce(200, disabled);
    useInboxStore.setState({ address: ADDRESS_RESULT.address });

    await useInboxStore.getState().removeAddress();

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('DELETE');
    expect(useInboxStore.getState().address).toBeNull();
    expect(useInboxStore.getState().addressLoaded).toBe(true);
  });

  it('sets an error and never throws when the server rejects the request', async () => {
    mockFetchOnce(409, { error: 'Already have an address' });

    await expect(useInboxStore.getState().requestAddress()).resolves.toBeUndefined();

    expect(useInboxStore.getState().error).toBe('Already have an address');
  });

  it('sets an error when there is no access token (signed out) and never calls fetch', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    await useInboxStore.getState().requestAddress();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useInboxStore.getState().error).toBe('Sign in required');
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
