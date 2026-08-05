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
import { saveFavorite, getAllHistory } from '../lib/db';
import { inboxPermalink } from '../lib/inboxPermalink';
import ReaderPage from './ReaderPage';

const PERMALINK = 'https://masthead.example/inbox/message/a1b2c3d4-1111-4111-8111-000000000001';

function renderReader(state, id = 'someid') {
  return renderComponent(
    <MemoryRouter initialEntries={[{ pathname: `/article/${id}`, state }]}>
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

// Fix round 2, N3 (spec §11 does not exclude "inbox reads entering
// History"): a saved inbox record opened via ReaderPage resolves to
// 'stored' (content present) and lands in the "Auto-mark as read in
// history" effect exactly like any other saved article — writing a
// permanently-broken History entry (its own reopen would hit the very
// funnel guard from F1 and show "Inbox messages are not extractable") and,
// for a signed-in user, leaking the inbox permalink into cloud
// user_history. Both tests use the SAME 'stored' resolution path
// (fromFavorites=true, content present via getFavorite/real IndexedDB) so
// the only variable between them is inbox-ness — an apples-to-apples
// regression pin, not two differently-shaped scenarios.
describe('ReaderPage — inbox reads never enter history (fix round 2, N3)', () => {
  it('opening a saved inbox record does not write a history entry', async () => {
    const permalink = inboxPermalink('a1b2c3d4-1111-4111-8111-000000000002');
    await saveFavorite({
      id: 'inboxsavedid1234',
      url: permalink,
      title: 'Newsletter',
      savedVia: 'inbox',
      content: '<p>Hello</p>',
      pendingBody: false,
      bodyFailed: false,
    });

    renderReader({ url: permalink, fromFavorites: true }, 'inboxsavedid1234');
    await flush();

    const history = await getAllHistory();
    expect(history.find((h) => h.url === permalink)).toBeUndefined();
  });

  it('opening a saved ORDINARY article (same stored-resolution path) still records history (regression guard)', async () => {
    const url = 'https://news.example/saved-story';
    await saveFavorite({
      id: 'normalsavedid1234',
      url,
      title: 'Ordinary saved article',
      savedVia: 'feed',
      content: '<p>Hello</p>',
      pendingBody: false,
      bodyFailed: false,
    });

    renderReader({ url, fromFavorites: true }, 'normalsavedid1234');
    await flush();

    const history = await getAllHistory();
    expect(history.find((h) => h.url === url)).toBeTruthy();
  });
});
