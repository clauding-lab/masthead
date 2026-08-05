// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, cleanupRendered, fireClick } from '../test/domTestUtils';

vi.mock('../stores/inboxStore', () => ({ default: vi.fn() }));
vi.mock('../stores/authStore', () => ({ default: vi.fn() }));

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

  it('surfaces a request-address failure via the store error string', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({ addressLoaded: true, address: null, error: 'Already have an address' })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('Already have an address');
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

describe('InboxPage — address present, empty list (onboarding hint)', () => {
  it('shows the copyable address and no message rows', () => {
    const address = 'reader-xy9k@masthead.clauding-lab.com';
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address, messages: [] }));

    const { container } = renderPage();

    expect(container.textContent).toContain(address);
    expect(findButtonByText(container, 'Copy')).toBeTruthy();
  });

  it('the Copy button writes the address to the clipboard', () => {
    const address = 'reader-xy9k@masthead.clauding-lab.com';
    useInboxStore.mockReturnValue(baseInboxState({ addressLoaded: true, address, messages: [] }));
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderPage();
    fireClick(findButtonByText(container, 'Copy'));

    expect(writeText).toHaveBeenCalledWith(address);
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
      received_at: new Date().toISOString(),
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
  it('shows a near-quota banner at >=80% bytes usage', () => {
    useInboxStore.mockReturnValue(
      baseInboxState({
        addressLoaded: true,
        address: 'a@b.com',
        messages: [],
        bytesUsed: 90 * 1024 * 1024, // MAX_LIVE_BYTES is 100 * 1024 * 1024
        messageCount: 1,
      })
    );

    const { container } = renderPage();

    expect(container.textContent).toContain('80%');
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
