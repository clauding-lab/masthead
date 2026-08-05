// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, cleanupRendered } from '../test/domTestUtils';
// Fix round 1, F12: uses the REAL store (no vi.mock), not a hand-rolled
// selector stub — proves BottomTabBar's actual `useInboxStore((s) =>
// s.unreadCount)` wiring reacts to a live Zustand state change within a
// single mounted instance, not just that different static states produce
// different renders across separate mounts.
import useInboxStore from '../stores/inboxStore';
import BottomTabBar from './BottomTabBar';

function renderBar() {
  return renderComponent(
    <MemoryRouter>
      <BottomTabBar />
    </MemoryRouter>
  );
}

beforeEach(() => {
  useInboxStore.setState({ unreadCount: 0 });
});

afterEach(() => {
  cleanupRendered();
  useInboxStore.setState({ unreadCount: 0 });
});

describe('BottomTabBar — Inbox tab', () => {
  it('renders a 6th Inbox tab', () => {
    const { container } = renderBar();

    const links = Array.from(container.querySelectorAll('a'));
    expect(links).toHaveLength(6);
    expect(container.textContent).toContain('Inbox');
  });

  it('shows no badge dot when unreadCount is 0', () => {
    const { container } = renderBar();

    expect(container.querySelector('[aria-label="Unread messages"]')).toBeFalsy();
  });

  it('shows a badge dot when unreadCount > 0', () => {
    useInboxStore.setState({ unreadCount: 3 });

    const { container } = renderBar();

    expect(container.querySelector('[aria-label="Unread messages"]')).toBeTruthy();
  });

  // Fix round 1, F12: the reactive-subscription proof — one mounted
  // component, live state transitions, no remount in between.
  it('reacts live to unreadCount changes on the real store: dot appears at 1, disappears back at 0', () => {
    const { container } = renderBar();

    expect(container.querySelector('[aria-label="Unread messages"]')).toBeFalsy();

    act(() => {
      useInboxStore.setState({ unreadCount: 1 });
    });
    expect(container.querySelector('[aria-label="Unread messages"]')).toBeTruthy();

    act(() => {
      useInboxStore.setState({ unreadCount: 0 });
    });
    expect(container.querySelector('[aria-label="Unread messages"]')).toBeFalsy();
  });
});
