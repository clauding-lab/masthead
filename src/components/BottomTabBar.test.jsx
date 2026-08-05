// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, cleanupRendered } from '../test/domTestUtils';

// Selector-style mock (like settingsStore/premiumStore in FeedLayout.test.jsx)
// so BottomTabBar's `useInboxStore((s) => s.unreadCount)` reads reactively
// off whatever this test sets, rather than a stale .getState() snapshot
// (FeedLayout.jsx line 23's comment — the same landmine, extended to the
// tab bar's badge).
let inboxState;
vi.mock('../stores/inboxStore', () => ({
  default: (selector) => selector(inboxState),
}));

import BottomTabBar from './BottomTabBar';

function renderBar() {
  return renderComponent(
    <MemoryRouter>
      <BottomTabBar />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanupRendered();
  vi.restoreAllMocks();
});

describe('BottomTabBar — Inbox tab', () => {
  it('renders a 6th Inbox tab', () => {
    inboxState = { unreadCount: 0 };
    const { container } = renderBar();

    const links = Array.from(container.querySelectorAll('a'));
    expect(links).toHaveLength(6);
    expect(container.textContent).toContain('Inbox');
  });

  it('shows no badge dot when unreadCount is 0', () => {
    inboxState = { unreadCount: 0 };
    const { container } = renderBar();

    expect(container.querySelector('[aria-label="Unread messages"]')).toBeFalsy();
  });

  it('shows a badge dot when unreadCount > 0', () => {
    inboxState = { unreadCount: 3 };
    const { container } = renderBar();

    expect(container.querySelector('[aria-label="Unread messages"]')).toBeTruthy();
  });
});
