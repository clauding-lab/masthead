// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resetPremiumMock, newsSetState, blogsSetState, initFromStorageMock } = vi.hoisted(() => ({
  resetPremiumMock: vi.fn(),
  newsSetState: vi.fn(),
  blogsSetState: vi.fn(),
  initFromStorageMock: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('../lib/localData', () => ({
  clearUserData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./settingsStore', () => ({
  default: { getState: () => ({ initFromStorage: initFromStorageMock }) },
}));
vi.mock('./premiumStore', () => ({
  default: { getState: () => ({ reset: resetPremiumMock }) },
}));
vi.mock('./feedStore', () => ({
  useNewsFeedStore: { setState: newsSetState },
  useBlogsFeedStore: { setState: blogsSetState },
}));

import { supabase } from '../lib/supabase';
import { clearUserData } from '../lib/localData';
import useAuthStore from './authStore';

beforeEach(() => {
  vi.clearAllMocks();
  supabase.auth.signOut.mockResolvedValue({});
  clearUserData.mockResolvedValue(undefined);
  vi.stubGlobal('caches', { delete: vi.fn().mockResolvedValue(true) });
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
