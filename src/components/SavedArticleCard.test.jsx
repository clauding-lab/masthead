// @vitest-environment jsdom
//
// Security review fix round 1, F2 (LOW): a body-less inbox shell's
// bodyFailed stays true forever — retrySave refuses to extract it (the
// extractor-ban seam guard, library.js#isInboxRecord). Showing "Couldn't
// fetch — retry" for that record is a permanent no-op button; the retry
// affordance is suppressed for inbox records specifically, not for
// ordinary bodyFailed shells (which retrySave genuinely can retry).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, cleanupRendered } from '../test/domTestUtils';
import SavedArticleCard from './SavedArticleCard';

afterEach(() => {
  cleanupRendered();
});

function renderCard(article) {
  return renderComponent(
    <MemoryRouter>
      <SavedArticleCard article={article} onRemove={vi.fn()} onRetry={vi.fn()} />
    </MemoryRouter>
  );
}

function findRetryButton(container) {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent.includes("Couldn't fetch")
  );
}

const INBOX_URL = 'https://x.test/inbox/message/a1b2c3d4-1111-4111-8111-000000000001';

describe('SavedArticleCard — retry affordance suppressed for inbox shells', () => {
  it('a body-less inbox record (savedVia "inbox") shows no retry button', () => {
    const { container } = renderCard({
      id: 'inboxid123456789',
      url: INBOX_URL,
      title: 'Newsletter shell',
      savedVia: 'inbox',
      bodyFailed: true,
      pendingBody: false,
      content: undefined,
    });

    expect(findRetryButton(container)).toBeFalsy();
  });

  // The durable half of isInboxRecord (URL shape) must suppress the button
  // too — the same landmine-18-extension guarantee library.test.js pins,
  // exercised here at the display layer.
  it('a body-less record whose savedVia is now "sync" (post cloud round-trip) still shows no retry button, via URL shape alone', () => {
    const { container } = renderCard({
      id: 'inboxid223456789',
      url: INBOX_URL,
      title: 'Newsletter shell',
      savedVia: 'sync',
      bodyFailed: true,
      pendingBody: false,
      content: undefined,
    });

    expect(findRetryButton(container)).toBeFalsy();
  });

  it('a body-less NON-inbox record still shows the retry button (regression guard)', () => {
    const { container } = renderCard({
      id: 'normalid123456789',
      url: 'https://news.example/a',
      title: 'Ordinary article',
      savedVia: 'url',
      bodyFailed: true,
      pendingBody: false,
      content: undefined,
    });

    expect(findRetryButton(container)).toBeTruthy();
  });

  it('clicking the retry button on a non-inbox record still fires onRetry with the article id', () => {
    const onRetry = vi.fn();
    const { container } = renderComponent(
      <MemoryRouter>
        <SavedArticleCard
          article={{
            id: 'normalid223456789',
            url: 'https://news.example/b',
            title: 'Ordinary article',
            savedVia: 'url',
            bodyFailed: true,
            pendingBody: false,
            content: undefined,
          }}
          onRemove={vi.fn()}
          onRetry={onRetry}
        />
      </MemoryRouter>
    );

    findRetryButton(container).click();
    expect(onRetry).toHaveBeenCalledWith('normalid223456789');
  });
});
