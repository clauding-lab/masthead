// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent, cleanupRendered } from '../test/domTestUtils';

// Isolate the picker-vs-feed decision under test: mock every store FeedLayout
// reads from, and stub out FeedPage/SourcePickerEmptyState so this test only
// exercises FeedLayout's own branching logic (final-review Critical 2).
const newsStoreMock = vi.fn();
const blogsStoreMock = vi.fn();
vi.mock('../stores/feedStore', () => ({
  useNewsFeedStore: (...args) => newsStoreMock(...args),
  useBlogsFeedStore: (...args) => blogsStoreMock(...args),
}));

let settingsState;
vi.mock('../stores/settingsStore', () => ({
  default: (selector) => selector(settingsState),
}));

let premiumState;
vi.mock('../stores/premiumStore', () => ({
  default: (selector) => selector(premiumState),
}));

vi.mock('./FeedPage', () => ({
  default: () => <div data-testid="feed-page" />,
}));
vi.mock('../components/SourcePickerEmptyState', () => ({
  default: ({ kind }) => <div data-testid="source-picker" data-kind={kind} />,
}));

import FeedLayout from './FeedLayout';

function baseStoreState() {
  return {
    fetchedAt: null,
    isLoading: false,
    selectedCategory: null,
    setCategory: vi.fn(),
    refresh: vi.fn(),
    premiumIssues: [],
  };
}

beforeEach(() => {
  const blogsState = baseStoreState();
  newsStoreMock.mockImplementation(() => baseStoreState());
  blogsStoreMock.mockImplementation(() => blogsState);
  settingsState = {
    selectedSourceIds: [],
    customSources: [],
    getEffectiveSourcesByKind: () => [],
  };
  premiumState = { feeds: [], enabledIds: [] };
});

afterEach(() => {
  cleanupRendered();
  vi.restoreAllMocks();
});

describe('FeedLayout blogs picker gate (final-review Critical 2)', () => {
  it('zero regular blog sources and zero premium blog feeds → picker shown (existing behavior)', () => {
    const { container } = renderComponent(<FeedLayout mode="blogs" />);

    expect(container.querySelector('[data-testid="source-picker"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="feed-page"]')).toBeFalsy();
  });

  it('zero regular blog sources but one enabled premium blog feed → feed surface shown, picker not shown', () => {
    premiumState = {
      feeds: [{ id: 'p1', kind: 'blog' }],
      enabledIds: ['p1'],
    };

    const { container } = renderComponent(<FeedLayout mode="blogs" />);

    expect(container.querySelector('[data-testid="source-picker"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="feed-page"]')).toBeTruthy();
  });

  it('a premium blog feed that exists but is disabled still shows the picker', () => {
    premiumState = {
      feeds: [{ id: 'p1', kind: 'blog' }],
      enabledIds: [],
    };

    const { container } = renderComponent(<FeedLayout mode="blogs" />);

    expect(container.querySelector('[data-testid="source-picker"]')).toBeTruthy();
  });

  it('a premium NEWS feed being enabled does not satisfy the blogs picker gate', () => {
    premiumState = {
      feeds: [{ id: 'p1', kind: 'news' }],
      enabledIds: ['p1'],
    };

    const { container } = renderComponent(<FeedLayout mode="blogs" />);

    expect(container.querySelector('[data-testid="source-picker"]')).toBeTruthy();
  });

  it('a regular blog source alone (no premium) already shows the feed surface', () => {
    settingsState.getEffectiveSourcesByKind = (kind) => (kind === 'blog' ? [{ id: 'b1' }] : []);

    const { container } = renderComponent(<FeedLayout mode="blogs" />);

    expect(container.querySelector('[data-testid="feed-page"]')).toBeTruthy();
  });
});
