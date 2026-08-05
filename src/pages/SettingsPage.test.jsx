// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { renderComponent, cleanupRendered, fireClick, fireClickAsync } from '../test/domTestUtils';

vi.mock('../stores/settingsStore', () => ({ default: vi.fn() }));
vi.mock('../stores/authStore', () => ({ default: vi.fn() }));
vi.mock('../stores/inboxStore', () => ({ default: vi.fn() }));
vi.mock('../stores/premiumStore', () => {
  const loadFeeds = vi.fn();
  const store = Object.assign(() => [], { getState: vi.fn(() => ({ loadFeeds })) });
  return { default: store };
});
vi.mock('../lib/db', () => ({ getStorageEstimate: vi.fn().mockResolvedValue(null) }));

import useSettingsStore from '../stores/settingsStore';
import useAuthStore from '../stores/authStore';
import useInboxStore from '../stores/inboxStore';
import { MAX_LIVE_BYTES } from '../../lib/inboxConfig.js';
import SettingsPage from './SettingsPage';

const USER = { id: 'u1', email: 'reader@example.com' };
const MB = 1024 * 1024;

function baseSettingsState(overrides = {}) {
  return {
    theme: 'system',
    fontSize: 18,
    selectedSourceIds: [],
    customSources: [],
    alwaysLoadRemoteImages: false,
    setTheme: vi.fn(),
    setFontSize: vi.fn(),
    toggleSource: vi.fn(),
    addCustomSource: vi.fn(),
    removeCustomSource: vi.fn(),
    setAlwaysLoadRemoteImages: vi.fn(),
    ...overrides,
  };
}

function baseInboxState(overrides = {}) {
  return {
    address: null,
    bytesUsed: 0,
    messageCount: 0,
    overQuotaSince: null,
    deferredCount: 0,
    regenerateAddress: vi.fn(),
    removeAddress: vi.fn(),
    clearRead: vi.fn(),
    refreshQuota: vi.fn(),
    ...overrides,
  };
}

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

function renderPage() {
  return renderComponent(<SettingsPage />);
}

beforeEach(() => {
  useSettingsStore.mockReturnValue(baseSettingsState());
  useAuthStore.mockReturnValue({ user: USER, signInWithGoogle: vi.fn(), signOut: vi.fn() });
  useInboxStore.mockReturnValue(baseInboxState());
});

afterEach(() => {
  cleanupRendered();
  vi.restoreAllMocks();
});

describe('SettingsPage — Load images automatically toggle (T16 ruling, fold-in 1)', () => {
  it('defaults to OFF (aria-pressed=false)', () => {
    const { container } = renderPage();
    const toggle = container.querySelector('[aria-label="Load remote images automatically"]');

    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking it calls setAlwaysLoadRemoteImages(true)', () => {
    const setAlwaysLoadRemoteImages = vi.fn();
    useSettingsStore.mockReturnValue(baseSettingsState({ alwaysLoadRemoteImages: false, setAlwaysLoadRemoteImages }));

    const { container } = renderPage();
    fireClick(container.querySelector('[aria-label="Load remote images automatically"]'));

    expect(setAlwaysLoadRemoteImages).toHaveBeenCalledWith(true);
  });
});

describe('SettingsPage — Email Inbox management, signed out', () => {
  it('shows no address, quota meter, or address-management controls', () => {
    useAuthStore.mockReturnValue({ user: null, signInWithGoogle: vi.fn(), signOut: vi.fn() });
    useInboxStore.mockReturnValue(baseInboxState({ address: 'reader-xy9k@masthead.clauding-lab.com' }));

    const { container } = renderPage();

    expect(findButtonByText(container, 'Regenerate address')).toBeFalsy();
    expect(findButtonByText(container, 'Remove address')).toBeFalsy();
    expect(findButtonByText(container, 'Clear read messages')).toBeFalsy();
  });

  it('never calls refreshQuota', () => {
    const refreshQuota = vi.fn();
    useAuthStore.mockReturnValue({ user: null, signInWithGoogle: vi.fn(), signOut: vi.fn() });
    useInboxStore.mockReturnValue(baseInboxState({ refreshQuota }));

    renderPage();

    expect(refreshQuota).not.toHaveBeenCalled();
  });
});

describe('SettingsPage — Email Inbox management, signed in, no address yet', () => {
  it('shows a hint pointing at the Inbox tab, no meter, no address-management buttons', () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: null }));

    const { container } = renderPage();

    expect(container.textContent).toContain('Inbox tab');
    expect(findButtonByText(container, 'Regenerate address')).toBeFalsy();
    expect(findButtonByText(container, 'Remove address')).toBeFalsy();
    expect(findButtonByText(container, 'Clear read messages')).toBeFalsy();
  });
});

describe('SettingsPage — Email Inbox management, signed in, address present', () => {
  const ADDRESS = 'reader-xy9k@masthead.clauding-lab.com';

  it('shows the address and a Copy button', () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS }));

    const { container } = renderPage();

    expect(container.textContent).toContain(ADDRESS);
    expect(findButtonByText(container, 'Copy')).toBeTruthy();
  });

  it('the Copy button writes the address to the clipboard', async () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderPage();
    await fireClickAsync(findButtonByText(container, 'Copy'));

    expect(writeText).toHaveBeenCalledWith(ADDRESS);
  });

  // F5 (Opus fix round 1, mutation survivor): the denominator claim is
  // computed FROM the imported MAX_LIVE_BYTES constant, not a hardcoded
  // '100 MB' literal — a mutant that changed SettingsPage's MAX_LIVE_MB
  // derivation (or any future change to the constant itself) would
  // silently desync a literal-string assertion; a computed one can't.
  const EXPECTED_MAX_MB = MAX_LIVE_BYTES / MB;

  it('formats the quota meter as MB (one decimal) of the live MAX_LIVE_BYTES cap, with the live message count', () => {
    const bytesUsed = 12.4 * MB; // chosen so bytesUsed / MB is exactly 12.4
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, bytesUsed, messageCount: 87 }));

    const { container } = renderPage();

    expect(container.textContent).toContain(`12.4 MB of ${EXPECTED_MAX_MB} MB`);
    expect(container.textContent).toContain('87 messages');
  });

  it('meter edge: 0 bytes formats as 0.0 MB', () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, bytesUsed: 0, messageCount: 0 }));

    const { container } = renderPage();

    expect(container.textContent).toContain(`0.0 MB of ${EXPECTED_MAX_MB} MB`);
  });

  it('meter edge: exactly MAX_LIVE_BYTES formats as 100.0 MB, not a rounding artifact', () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, bytesUsed: MAX_LIVE_BYTES, messageCount: 500 }));

    const { container } = renderPage();

    expect(container.textContent).toContain(`${EXPECTED_MAX_MB}.0 MB of ${EXPECTED_MAX_MB} MB`);
  });

  it('shows a deferred note when deferredCount > 0', () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, deferredCount: 3 }));

    const { container } = renderPage();

    expect(container.textContent).toContain('3 messages deferred');
  });

  it('shows no deferred note when deferredCount is 0', () => {
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, deferredCount: 0 }));

    const { container } = renderPage();

    expect(container.textContent).not.toContain('deferred');
  });

  it('fires a lightweight refreshQuota when the section mounts', () => {
    const refreshQuota = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, refreshQuota }));

    renderPage();

    expect(refreshQuota).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsPage — Regenerate address (ConfirmSheet-gated)', () => {
  const ADDRESS = 'reader-xy9k@masthead.clauding-lab.com';

  it('clicking Regenerate address opens a confirm sheet and does NOT call regenerateAddress yet', () => {
    const regenerateAddress = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, regenerateAddress }));

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Regenerate address'));

    expect(container.textContent).toContain('permanently stops mail sent to the old address');
    expect(regenerateAddress).not.toHaveBeenCalled();
  });

  // F1 (Opus fix round 1, mutation survivor): a mutant that fires ALL
  // THREE address/message actions off a single confirm (e.g. `if (action) {
  // removeAddress(); clearRead(); }` alongside the correct regenerate call)
  // still shipped 23/23 green without these negative assertions — the
  // positive "called once" check alone can't see the two extra calls a
  // cross-firing mutant makes to sibling actions.
  it('confirming calls regenerateAddress exactly once — and never removeAddress or clearRead', () => {
    const regenerateAddress = vi.fn();
    const removeAddress = vi.fn();
    const clearRead = vi.fn();
    useInboxStore.mockReturnValue(
      baseInboxState({ address: ADDRESS, regenerateAddress, removeAddress, clearRead })
    );

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Regenerate address'));
    fireClick(findButtonByText(container, 'Regenerate'));

    expect(regenerateAddress).toHaveBeenCalledTimes(1);
    expect(removeAddress).not.toHaveBeenCalled();
    expect(clearRead).not.toHaveBeenCalled();
  });

  it('canceling never calls regenerateAddress', () => {
    const regenerateAddress = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, regenerateAddress }));

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Regenerate address'));
    fireClick(findButtonByText(container, 'Cancel'));

    expect(regenerateAddress).not.toHaveBeenCalled();
    expect(findButtonByText(container, 'Cancel')).toBeFalsy(); // sheet closed
  });
});

describe('SettingsPage — Remove address (ConfirmSheet-gated)', () => {
  const ADDRESS = 'reader-xy9k@masthead.clauding-lab.com';

  it('clicking Remove address opens a confirm sheet and does NOT call removeAddress yet', () => {
    const removeAddress = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, removeAddress }));

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Remove address'));

    expect(removeAddress).not.toHaveBeenCalled();
    expect(findButtonByText(container, 'Remove')).toBeTruthy();
  });

  // F1 (Opus fix round 1): see the regenerate describe block above for why
  // this permutation is needed — cross-fire on a shared handler is a real
  // mutant, not a hypothetical one.
  it('confirming calls removeAddress exactly once — and never regenerateAddress or clearRead', () => {
    const removeAddress = vi.fn();
    const regenerateAddress = vi.fn();
    const clearRead = vi.fn();
    useInboxStore.mockReturnValue(
      baseInboxState({ address: ADDRESS, removeAddress, regenerateAddress, clearRead })
    );

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Remove address'));
    fireClick(findButtonByText(container, 'Remove'));

    expect(removeAddress).toHaveBeenCalledTimes(1);
    expect(regenerateAddress).not.toHaveBeenCalled();
    expect(clearRead).not.toHaveBeenCalled();
  });

  it('canceling never calls removeAddress', () => {
    const removeAddress = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, removeAddress }));

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Remove address'));
    fireClick(findButtonByText(container, 'Cancel'));

    expect(removeAddress).not.toHaveBeenCalled();
  });
});

describe('SettingsPage — Clear read messages (ConfirmSheet-gated bulk tombstone)', () => {
  const ADDRESS = 'reader-xy9k@masthead.clauding-lab.com';

  it('clicking Clear read messages opens a confirm sheet and does NOT call clearRead yet', () => {
    const clearRead = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, clearRead }));

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Clear read messages'));

    expect(clearRead).not.toHaveBeenCalled();
    expect(container.textContent).toContain("can't be undone");
  });

  // F1 (Opus fix round 1): see the regenerate describe block above for why
  // this permutation is needed — cross-fire on a shared handler is a real
  // mutant, not a hypothetical one.
  it('confirming calls clearRead exactly once — and never regenerateAddress or removeAddress', () => {
    const clearRead = vi.fn();
    const regenerateAddress = vi.fn();
    const removeAddress = vi.fn();
    useInboxStore.mockReturnValue(
      baseInboxState({ address: ADDRESS, clearRead, regenerateAddress, removeAddress })
    );

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Clear read messages'));
    fireClick(findButtonByText(container, 'Clear read'));

    expect(clearRead).toHaveBeenCalledTimes(1);
    expect(regenerateAddress).not.toHaveBeenCalled();
    expect(removeAddress).not.toHaveBeenCalled();
  });

  it('canceling never calls clearRead', () => {
    const clearRead = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ address: ADDRESS, clearRead }));

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Clear read messages'));
    fireClick(findButtonByText(container, 'Cancel'));

    expect(clearRead).not.toHaveBeenCalled();
  });
});

describe('SettingsPage — landmine 22 grep pin', () => {
  it('never calls window.confirm anywhere in its own source', () => {
    const src = fs.readFileSync(path.join(globalThis.process.cwd(), 'src/pages/SettingsPage.jsx'), 'utf8');
    expect(src).not.toContain('window.confirm(');
  });
});
