// @vitest-environment jsdom
//
// Security review fix round 1, F1 (HIGH): confirms the History-shaped entry
// point the finding describes genuinely reaches extractArticle unguarded —
// HistoryCard.jsx links to /article/:id with state.url set and NO
// fromFavorites, so ReaderPage's plain `else if (url)` branch runs
// (resolveReaderSource's inbox guard, which only fires on the fromFavorites
// path, never gets a chance to run). The refusal itself is unit-pinned at
// the funnel in api.test.js; this test proves the chain up to that funnel
// is real, not just described.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, cleanupRendered } from '../test/domTestUtils';

vi.mock('../lib/api', () => ({
  extractArticle: vi.fn(),
}));

import { extractArticle } from '../lib/api';
import useArticleStore from '../stores/articleStore';
import ReaderPage from './ReaderPage';

const PERMALINK = 'https://masthead.example/inbox/message/a1b2c3d4-1111-4111-8111-000000000001';

function renderReader(state) {
  return renderComponent(
    <MemoryRouter initialEntries={[{ pathname: '/article/someid', state }]}>
      <Routes>
        <Route path="/article/:id" element={<ReaderPage />} />
      </Routes>
    </MemoryRouter>
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useArticleStore.setState({ article: null, isLoading: false, error: null });
});

afterEach(() => {
  cleanupRendered();
});

describe('ReaderPage — History-shaped path (state.url set, no fromFavorites)', () => {
  it('calls extractArticle with the raw permalink — this path is NOT gated by resolveReaderSource', async () => {
    extractArticle.mockRejectedValueOnce(new Error('Inbox messages are not extractable'));

    renderReader({ url: PERMALINK, sourceId: null });
    await flush();

    expect(extractArticle).toHaveBeenCalledWith(PERMALINK, null);
    expect(useArticleStore.getState().error).toBe('Inbox messages are not extractable');
  });

  it('a normal saved-article url still resolves live extraction the same way (regression guard)', async () => {
    extractArticle.mockResolvedValueOnce({ title: 'T', content: '<p>x</p>' });

    renderReader({ url: 'https://news.example/a', sourceId: 'src1' });
    await flush();

    expect(extractArticle).toHaveBeenCalledWith('https://news.example/a', 'src1');
    expect(useArticleStore.getState().article).toEqual({ title: 'T', content: '<p>x</p>' });
  });
});
