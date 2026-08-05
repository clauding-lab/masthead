// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, cleanupRendered, fireClick, fireClickAsync } from '../test/domTestUtils';

vi.mock('../stores/inboxStore', () => ({ default: vi.fn() }));
vi.mock('../stores/authStore', () => ({ default: vi.fn() }));
// Isolate InboxPage's own branching from PullToRefresh's real touch-gesture
// internals (matches FeedLayout.test.jsx's convention of stubbing child
// components) — Fix round 1, F6 needs a stable marker to assert the list
// state actually wraps its content in the pull-to-refresh gesture, which
// the real component has no visible DOM signal for at rest (pullDistance 0
// renders no text, no distinguishing class).
// T15 re-review fold-in: the original stub swallowed `onRefresh` entirely,
// so wiring `<PullToRefresh onRefresh={someUnrelatedFunction}>` would still
// pass every test in this file (a "dead gesture" — the wrapper renders, but
// pulling it does nothing). Rendering a real button that fires the prop
// lets a later test prove fetchList is actually reachable through it.
vi.mock('../components/PullToRefresh', () => ({
  default: ({ children, onRefresh }) => (
    <div data-testid="pull-to-refresh">
      <button onClick={onRefresh}>Trigger Refresh</button>
      {children}
    </div>
  ),
}));

import useInboxStore from '../stores/inboxStore';
import useAuthStore from '../stores/authStore';
import InboxPage from './InboxPage';

const USER = { id: 'u1', email: 'reader@example.com' };

function baseInboxState(overrides = {}) {
  return {
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
    fetchList: vi.fn(),
    requestAddress: vi.fn(),
    ...overrides,
  };
}

function renderPage() {
  return renderComponent(
    <MemoryRouter>
      <InboxPage />
    </MemoryRouter>
  );
}

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

let signInWithGoogle;

beforeEach(() => {
  signInWithGoogle = vi.fn();
  useAuthStore.mockReturnValue({ user: USER, signInWithGoogle });
  useInboxStore.mockReturnValue(baseInboxState());
});

afterEach(() => {
  cleanupRendered();
  vi.restoreAllMocks();
});

describe('InboxPage — signed-out', () => {
  it('shows a sign-in prompt and never calls fetchList', () => {
    const fetchList = vi.fn();
    useAuthStore.mockReturnValue({ user: null, signInWithGoogle });
    useInboxStore.mockReturnValue(baseInboxState({ fetchList }));

    const { container } = renderPage();

    expect(container.textContent).toContain('Sign in');
    expect(fetchList).not.toHaveBeenCalled();
  });

  it('the sign-in action calls signInWithGoogle', () => {
    useAuthStore.mockReturnValue({ user: null, signInWithGoogle });

    const { container } = renderPage();
    const btn = findButtonByText(container, 'Sign in with Google');
    expect(btn).toBeTruthy();
    fireClick(btn);

    expect(signInWithGoogle).toHaveBeenCalledTimes(1);
  });
});

describe('InboxPage — signed-in, addressLoaded, no address', () => {
  it('shows a "Get your address" card whose button calls requestAddress', () => {
    const requestAddress = vi.fn();
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address: null, requestAddress }));

    const { container } = renderPage();
    const btn = findButtonByText(container, 'Get your address');
    expect(btn).toBeTruthy();
    fireClick(btn);

    expect(requestAddress).toHaveBeenCalledTimes(1);
  });

  it('surfaces a request-address failure via the store error string, announced as an alert', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: null, error: 'Already have an address' })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('Already have an address');
    // Fix round 1, F8: a failure is an alert (role="alert"), not an
    // informational banner (role="status" — used by the quota/deferred
    // banners elsewhere in this page).
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  // Binding ruling: addressLoaded is NOT a loading flag. never-ran /
  // in-flight / ran-and-failed all collapse to false — this must NOT render
  // a spinner that spins forever; it falls back to the same get-address
  // prompt as the addressLoaded:true case.
  it('addressLoaded false (never-ran/in-flight/failed boot) shows the get-address prompt, never a spinner', () => {
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: false, address: null }));

    const { container } = renderPage();

    expect(findButtonByText(container, 'Get your address')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeFalsy();
  });
});

// Fix round 1, F1: an empty `messages` array doesn't mean "no mail" until
// the first fetchList has actually resolved — bootstrap/fetchList leave
// `messages: []` for the whole in-flight duration, and a returning user
// with 200 messages would otherwise see the "Your inbox is ready" onboarding
// hint flash on every cold start.
describe('InboxPage — loading state', () => {
  it('shows a loading skeleton, not the onboarding hint, while isLoading and no messages have loaded yet', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: [], isLoading: true })
    );

    const { container } = renderPage();

    expect(container.textContent).not.toContain('Your inbox is ready');
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });
});

describe('InboxPage — address present, empty list (onboarding hint)', () => {
  let originalClipboardDescriptor;

  beforeEach(() => {
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  });

  // Fix round 1, F11: restore whatever clipboard descriptor was there
  // before this suite stubbed it, rather than leaving the stub installed
  // for every test file that runs after this one in the same worker.
  afterEach(() => {
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
    } else {
      delete navigator.clipboard;
    }
  });

  it('shows the copyable address and no message rows, and no quota banners at zero usage', () => {
    const address = 'reader-xy9k@masthead.clauding-lab.com';
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address, messages: [] }));

    const { container } = renderPage();

    expect(container.textContent).toContain(address);
    expect(findButtonByText(container, 'Copy')).toBeTruthy();
    // Fix round 1, F2/F3: pins the absence side of both quota-derived
    // banners against this already-under-threshold, zero-deferred fixture —
    // without this, a mutant that always shows either banner still passes
    // every other test in this file.
    expect(container.textContent).not.toContain('80%');
    expect(container.textContent).not.toContain('deferred');
  });

  it('the Copy button writes the address to the clipboard and flips the label to Copied on success', async () => {
    const address = 'reader-xy9k@masthead.clauding-lab.com';
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address, messages: [] }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderPage();
    await fireClickAsync(findButtonByText(container, 'Copy'));

    expect(writeText).toHaveBeenCalledWith(address);
    expect(findButtonByText(container, 'Copied')).toBeTruthy();
  });

  // Fix round 1, F7: a rejected clipboard write (permission denial) must
  // neither flip the label to a false "Copied" nor escape as an unhandled
  // rejection.
  it('a clipboard permission denial does not flip the label to Copied', async () => {
    const address = 'reader-xy9k@masthead.clauding-lab.com';
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address, messages: [] }));
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderPage();
    await fireClickAsync(findButtonByText(container, 'Copy'));

    expect(writeText).toHaveBeenCalledWith(address);
    expect(findButtonByText(container, 'Copy')).toBeTruthy();
    expect(findButtonByText(container, 'Copied')).toBeFalsy();
  });
});

describe('InboxPage — list state', () => {
  const MESSAGES = [
    {
      id: 'm1',
      from_name: 'The Overhead',
      from_email: 'news@overhead.example',
      subject: 'Weekly markets digest',
      excerpt: 'Rates, reserves, and remittances this week.',
      // Fix round 1, F5: a fixed offset (3h1m, not "now") so timeAgo has
      // real coverage — a minute of slack past the 3h boundary means a few
      // ms of test-runner delay can never round this down to "2h ago".
      received_at: new Date(Date.now() - (3 * 60 + 1) * 60 * 1000).toISOString(),
      read_at: null,
      auth_results: 'spf=pass dkim=pass dmarc=pass',
    },
    {
      id: 'm2',
      from_name: '',
      from_email: 'digest@lookalike.example',
      subject: 'Special offer inside',
      excerpt: null,
      received_at: new Date().toISOString(),
      read_at: new Date().toISOString(),
      auth_results: 'spf=fail dkim=fail dmarc=fail',
    },
  ];

  it('renders one InboxMessageRow per message with sender, subject, and excerpt', () => {
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES }));

    const { container } = renderPage();

    expect(container.textContent).toContain('The Overhead');
    expect(container.textContent).toContain('digest@lookalike.example');
    expect(container.textContent).toContain('Weekly markets digest');
    expect(container.textContent).toContain('Special offer inside');
    expect(container.textContent).toContain('Rates, reserves, and remittances this week.');
  });

  // Fix round 1, F5: timeAgo had zero coverage — deleting it from
  // InboxMessageRow entirely still passed every existing test.
  it('shows the relative received date via timeAgo', () => {
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES }));

    const { container } = renderPage();

    expect(container.textContent).toContain('3h ago');
  });

  // Fix round 1, F6: replacing the PullToRefresh wrapper with a bare
  // fragment previously passed every test — nothing asserted its presence.
  it('wraps the list in PullToRefresh so the pull gesture is available', () => {
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES }));

    const { container } = renderPage();

    expect(container.querySelector('[data-testid="pull-to-refresh"]')).toBeTruthy();
  });

  it('shows an unread dot only for the message with read_at null', () => {
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES }));

    const { container } = renderPage();

    expect(container.querySelectorAll('[aria-label="Unread"]')).toHaveLength(1);
  });

  it('marks the sender unverified only when auth_results contains dmarc=fail', () => {
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES }));

    const { container } = renderPage();
    const rows = Array.from(container.querySelectorAll('a'));
    const overheadRow = rows.find((r) => r.textContent.includes('The Overhead'));
    const lookalikeRow = rows.find((r) => r.textContent.includes('digest@lookalike.example'));

    expect(overheadRow.textContent).not.toContain('Unverified');
    expect(lookalikeRow.textContent).toContain('Unverified');
  });

  it('calls fetchList on mount', () => {
    const fetchList = vi.fn();
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES, fetchList })
    );

    renderPage();

    expect(fetchList).toHaveBeenCalledTimes(1);
  });

  // T15 re-review fold-in (1): the pull-to-refresh gesture must actually be
  // wired to fetchList, not just present as an inert wrapper.
  it('wires the pull-to-refresh gesture to fetchList (dead-gesture pin)', () => {
    const fetchList = vi.fn();
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES, fetchList })
    );

    const { container } = renderPage();
    expect(fetchList).toHaveBeenCalledTimes(1); // the mount call

    fireClick(findButtonByText(container, 'Trigger Refresh'));

    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  // T15 re-review fold-in (3): messages.length === 0 is the OTHER half of
  // the skeleton gate (`messages.length === 0 && isLoading`) — a mutant that
  // drops the length check would show the skeleton over a populated list
  // during a pull-to-refresh-triggered isLoading:true.
  it('renders message rows, not the skeleton, when isLoading is true but messages are already present', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: MESSAGES, isLoading: true })
    );

    const { container } = renderPage();

    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(container.textContent).toContain('Weekly markets digest');
  });
});

describe('InboxPage — window focus refetch', () => {
  it('calls fetchList again on a window focus event, and stops after unmount', () => {
    const fetchList = vi.fn();
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: 'a@b.com', messages: [], fetchList })
    );

    const { unmount } = renderPage();
    expect(fetchList).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('focus'));
    expect(fetchList).toHaveBeenCalledTimes(2);

    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(fetchList).toHaveBeenCalledTimes(2);
  });
});

describe('InboxPage — quota banners', () => {
  // Fix round 1, F4: both original fixtures sat at exactly 0.90, so
  // QUOTA_WARNING_RATIO could silently drift from 0.8 to 0.9 with every
  // test still green. A boundary case (exactly 80%) plus a just-below case
  // (79%) together pin the constant from both directions.
  it('shows a near-quota banner exactly at the 80% bytes boundary', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({
        addressLoaded: true,
        address: 'a@b.com',
        messages: [],
        bytesUsed: 80 * 1024 * 1024, // exactly 80% of MAX_LIVE_BYTES (100 * 1024 * 1024)
        messageCount: 1,
      })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('80%');
  });

  it('does not show a near-quota banner just below the 80% bytes boundary', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({
        addressLoaded: true,
        address: 'a@b.com',
        messages: [],
        bytesUsed: 79 * 1024 * 1024, // just under 80% of MAX_LIVE_BYTES
        messageCount: 1,
      })
    );

    const { container } = renderPage();

    expect(container.textContent).not.toContain('80%');
  });

  it('shows a near-quota banner at >=80% message-count usage', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({
        addressLoaded: true,
        address: 'a@b.com',
        messages: [],
        bytesUsed: 0,
        messageCount: 450, // MAX_LIVE_MESSAGES is 500
      })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('80%');
  });

  it('overQuotaSince set shows "Inbox full — N deferred since <date>"', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({
        addressLoaded: true,
        address: 'a@b.com',
        messages: [],
        overQuotaSince: '2026-08-01T12:00:00.000Z',
        deferredCount: 5,
      })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('Inbox full');
    expect(container.textContent).toContain('5 deferred since August 1, 2026');
    // T15 re-review fold-in (2): quota/deferred banners are informational
    // (role="status"), never role="alert" — pinned from both directions so
    // a mutant that swapped the QuotaBanner default tone can't hide behind
    // an assertion that only checks one side.
    expect(container.querySelector('[role="status"]')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeFalsy();
  });

  it('deferredCount > 0 with no overQuotaSince shows a deferred note, distinct from the full-inbox banner', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({
        addressLoaded: true,
        address: 'a@b.com',
        messages: [],
        overQuotaSince: null,
        deferredCount: 3,
      })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('3 messages deferred');
    expect(container.textContent).not.toContain('Inbox full');
  });
});
