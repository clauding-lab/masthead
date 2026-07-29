// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// premiumStore/feedStore mock shapes are extended below (getState.loadFeeds,
// getState.getEnabledPremiumIdsByKind, getState.fetchFeeds) to cover the
// final-review Critical 1 boot-bootstrap tests — additive alongside the
// existing reset/setState fields the signOut sweep tests already use.
const {
  resetPremiumMock, newsSetState, blogsSetState, initFromStorageMock,
  loadFeedsMock, getEnabledPremiumIdsByKindMock, newsFetchFeedsMock, blogsFetchFeedsMock,
  getSessionMock, onAuthStateChangeMock,
} = vi.hoisted(() => ({
  resetPremiumMock: vi.fn(),
  newsSetState: vi.fn(),
  blogsSetState: vi.fn(),
  initFromStorageMock: vi.fn(),
  loadFeedsMock: vi.fn(),
  getEnabledPremiumIdsByKindMock: vi.fn(),
  newsFetchFeedsMock: vi.fn(),
  blogsFetchFeedsMock: vi.fn(),
  getSessionMock: vi.fn(),
  onAuthStateChangeMock: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signOut: vi.fn().mockResolvedValue({}),
      getSession: getSessionMock,
      onAuthStateChange: onAuthStateChangeMock,
    },
  },
}));
vi.mock('../lib/localData', () => ({
  clearUserData: vi.fn().mockResolvedValue(undefined),
}));
// Real syncOnSignIn/pushOnboardingSources would reach for supabase.from(),
// which the plain auth-only mock above doesn't provide — mock the module so
// the fresh-sign-in boot tests exercise authStore's own wiring, not sync.js.
vi.mock('../lib/sync', () => ({
  syncOnSignIn: vi.fn().mockResolvedValue(undefined),
  pushOnboardingSources: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./settingsStore', () => ({
  default: { getState: () => ({ initFromStorage: initFromStorageMock }) },
}));
vi.mock('./premiumStore', () => ({
  default: {
    getState: () => ({
      reset: resetPremiumMock,
      loadFeeds: loadFeedsMock,
      getEnabledPremiumIdsByKind: getEnabledPremiumIdsByKindMock,
    }),
  },
}));
vi.mock('./feedStore', () => ({
  useNewsFeedStore: { setState: newsSetState, getState: () => ({ fetchFeeds: newsFetchFeedsMock }) },
  useBlogsFeedStore: { setState: blogsSetState, getState: () => ({ fetchFeeds: blogsFetchFeedsMock }) },
}));

import { supabase } from '../lib/supabase';
import { clearUserData } from '../lib/localData';
import useAuthStore from './authStore';

beforeEach(() => {
  vi.clearAllMocks();
  supabase.auth.signOut.mockResolvedValue({});
  clearUserData.mockResolvedValue(undefined);
  vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
  // Default: signed-out boot, nothing enabled — individual tests override.
  getSessionMock.mockResolvedValue({ data: { session: null } });
  onAuthStateChangeMock.mockImplementation(() => {});
  loadFeedsMock.mockResolvedValue(undefined);
  getEnabledPremiumIdsByKindMock.mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 2E §5.2 / red-team finding: signOut must sweep premium state and the
// Workbox api-cache runtime cache, or a shared device hands the masked
// premium list to the next signed-in account.
describe('signOut sweep', () => {
  it('resets premiumStore, empties both feed stores, and deletes the api-cache runtime cache', async () => {
    await useAuthStore.getState().signOut();

    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(clearUserData).toHaveBeenCalledTimes(1);
    expect(initFromStorageMock).toHaveBeenCalledTimes(1);

    expect(resetPremiumMock).toHaveBeenCalledTimes(1);

    const emptyState = { headlines: [], fetchedAt: null, error: null, premiumIssues: [], premiumAuthFailed: false };
    expect(newsSetState).toHaveBeenCalledWith(emptyState);
    expect(blogsSetState).toHaveBeenCalledWith(emptyState);

    expect(globalThis.caches.delete).toHaveBeenCalledWith('api-cache');
  });

  it('still sweeps state even when caches.delete rejects', async () => {
    globalThis.caches.delete.mockRejectedValue(new Error('cache api unavailable'));

    await expect(useAuthStore.getState().signOut()).resolves.toBeUndefined();

    expect(resetPremiumMock).toHaveBeenCalledTimes(1);
    expect(newsSetState).toHaveBeenCalledTimes(1);
    expect(blogsSetState).toHaveBeenCalledTimes(1);
  });
});

// Final-review Critical 1: premiumStore.loadFeeds() was previously called
// ONLY from SettingsPage, so premiumStore.feeds stayed [] on a normal boot
// to "/" and premium articles never surfaced. Both session-establishing
// paths — a restored session (getSession) and a fresh sign-in
// (onAuthStateChange) — must call loadFeeds, without ever blocking or
// breaking boot, and must refetch any kind surface whose enabled premium
// set is now non-empty (the surface's own mount-time fetchFeeds may have
// already run with premiumIds: [] before loadFeeds resolved).
describe('premium feed bootstrap on session establish (final-review Critical 1)', () => {
  beforeEach(() => {
    // Each test drives initAuth() fresh; start from a clean, unauthenticated
    // store so onAuthStateChange's prevUser comparison isn't polluted by
    // whatever a previous test left behind in this module-singleton store.
    useAuthStore.setState({ user: null, session: null, isLoading: true, isInitialized: false });
  });

  it('a restored session (getSession returns a user) triggers loadFeeds', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });

    await useAuthStore.getState().initAuth();
    await vi.waitFor(() => expect(loadFeedsMock).toHaveBeenCalledTimes(1));
  });

  it('a signed-out boot (no session) never calls loadFeeds', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });

    await useAuthStore.getState().initAuth();
    // Nothing async is in flight for the signed-out path, but wait a tick
    // anyway so a wrongly-fired call would have had time to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadFeedsMock).not.toHaveBeenCalled();
  });

  it('a fresh sign-in via onAuthStateChange (no prior user) triggers loadFeeds', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } });
    await useAuthStore.getState().initAuth();
    expect(onAuthStateChangeMock).toHaveBeenCalledTimes(1);
    const onChange = onAuthStateChangeMock.mock.calls[0][0];

    onChange('SIGNED_IN', { user: { id: 'u2' } });

    await vi.waitFor(() => expect(loadFeedsMock).toHaveBeenCalledTimes(1));
  });

  it('a token refresh (session change with an already-known user) does not re-trigger loadFeeds', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
    await useAuthStore.getState().initAuth();
    await vi.waitFor(() => expect(loadFeedsMock).toHaveBeenCalledTimes(1));
    loadFeedsMock.mockClear();
    const onChange = onAuthStateChangeMock.mock.calls[0][0];

    onChange('TOKEN_REFRESHED', { user: { id: 'u1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadFeedsMock).not.toHaveBeenCalled();
  });

  it('sequencing: once loadFeeds resolves with a non-empty enabled set for a kind, that kind refetches with the premium ids applied', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
    getEnabledPremiumIdsByKindMock.mockImplementation((kind) => (kind === 'news' ? ['p1'] : []));

    await useAuthStore.getState().initAuth();

    await vi.waitFor(() => expect(newsFetchFeedsMock).toHaveBeenCalledTimes(1));
    // Only the kind whose enabled set changed refetches — not a blanket
    // "refetch everything" that would mask the targeted mechanism.
    expect(blogsFetchFeedsMock).not.toHaveBeenCalled();
  });

  it('no fetchFeeds call for either kind when nothing is enabled (the common case: no premium subscription)', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
    getEnabledPremiumIdsByKindMock.mockReturnValue([]);

    await useAuthStore.getState().initAuth();
    await vi.waitFor(() => expect(loadFeedsMock).toHaveBeenCalledTimes(1));

    expect(newsFetchFeedsMock).not.toHaveBeenCalled();
    expect(blogsFetchFeedsMock).not.toHaveBeenCalled();
  });

  it('this is a one-shot sequence, not a subscription: fetchFeeds never itself calls loadFeeds again', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
    getEnabledPremiumIdsByKindMock.mockImplementation((kind) => (kind === 'news' ? ['p1'] : []));
    // newsFetchFeedsMock is a bare vi.fn() with no implementation calling
    // back into loadFeeds — asserting exactly-once pins that boot triggers
    // loadFeeds precisely once per session-establishing event, never more.
    await useAuthStore.getState().initAuth();

    await vi.waitFor(() => expect(newsFetchFeedsMock).toHaveBeenCalledTimes(1));
    expect(loadFeedsMock).toHaveBeenCalledTimes(1);
  });

  it('a loadFeeds rejection is swallowed — boot completes and no refetch is attempted', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } });
    loadFeedsMock.mockRejectedValue(new Error('premium API down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(useAuthStore.getState().initAuth()).resolves.toBeUndefined();
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled());

    expect(useAuthStore.getState().isInitialized).toBe(true);
    expect(newsFetchFeedsMock).not.toHaveBeenCalled();
    expect(blogsFetchFeedsMock).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
