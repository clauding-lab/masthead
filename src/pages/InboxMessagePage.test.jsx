// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import fs from 'fs';
import path from 'path';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, cleanupRendered, fireClick, fireClickAsync } from '../test/domTestUtils';

// Real inboxStore (not mocked) — same convention as inboxStore.test.js and
// BottomTabBar.test.jsx's "Fix round 1, F12" precedent: this page leans on
// openMessage's exact business rules (tombstone/PGRST116 handling, the
// unreadCount decrement gate), which are already correct and tested at the
// store layer — re-deriving them via a hand-rolled mock here would just
// duplicate that logic and risk drifting from it. Only the I/O boundary
// (lib/inboxData) and its sibling (lib/premiumApi, imported by the store)
// are mocked, exactly as inboxStore.test.js does it.
vi.mock('../lib/inboxData', () => ({
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  markRead: vi.fn(),
  removeMessage: vi.fn(),
  clearRead: vi.fn(),
  unreadCount: vi.fn(),
}));
vi.mock('../lib/premiumApi', () => ({
  getAccessToken: vi.fn(),
  authed: vi.fn(),
}));

let settingsState;
vi.mock('../stores/settingsStore', () => ({
  default: (selector) => selector(settingsState),
}));

import * as inboxData from '../lib/inboxData';
import useInboxStore from '../stores/inboxStore';
import InboxMessagePage from './InboxMessagePage';

const MESSAGE_ID = 'a1b2c3d4-1111-4111-8111-000000000001';

const BASE_MESSAGE = {
  id: MESSAGE_ID,
  from_email: 'news@overhead.example',
  from_name: 'The Overhead',
  subject: 'Weekly markets digest',
  html_body: null,
  text_body: null,
  excerpt: 'Rates, reserves, and remittances this week.',
  received_at: '2026-08-01T09:00:00.000Z',
  read_at: null,
  web_url: 'https://overhead.example/issues/42',
  unsubscribe_url: null,
  deleted_at: null,
};

function renderMessagePage(id = MESSAGE_ID) {
  return renderComponent(
    <MemoryRouter initialEntries={[`/inbox/message/${id}`]}>
      <Routes>
        <Route path="/inbox/message/:id" element={<InboxMessagePage />} />
        <Route path="/inbox" element={<div data-testid="inbox-landing">Inbox landing</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// openMessage's promise chain has multiple await hops (getMessage, then
// markRead) before the component's own .then() sets local state — a single
// microtask flush isn't reliably enough. A macrotask tick (setTimeout 0)
// guarantees every pending microtask has drained first.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAndFlush(id = MESSAGE_ID) {
  const rendered = renderMessagePage(id);
  await flush();
  return rendered;
}

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

function findLinkByText(container, text) {
  return Array.from(container.querySelectorAll('a')).find((a) => a.textContent.trim() === text);
}

beforeEach(() => {
  vi.clearAllMocks();
  useInboxStore.setState({
    address: null, bytesUsed: 0, messageCount: 0, overQuotaSince: null, deferredCount: 0,
    messages: [], unreadCount: 0, isLoading: false, error: null, errorCode: null, addressLoaded: false,
  });
  settingsState = { alwaysLoadRemoteImages: false };
  inboxData.markRead.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanupRendered();
});

describe('InboxMessagePage — rendering sanitised html', () => {
  it('renders sanitised html_body, stripping XSS vectors', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: '<p>Hello <strong>world</strong></p><script>alert(1)</script>',
    });

    const { container } = await renderAndFlush();

    const content = container.querySelector('.email-content');
    expect(content).toBeTruthy();
    expect(content.innerHTML).toContain('<strong>world</strong>');
    expect(container.innerHTML).not.toContain('<script');
    expect(container.textContent).not.toContain('alert(1)');
  });

  it('shows sender, date, and a View original link', async () => {
    inboxData.getMessage.mockResolvedValueOnce({ ...BASE_MESSAGE, html_body: '<p>body</p>' });

    const { container } = await renderAndFlush();

    expect(container.textContent).toContain('The Overhead');
    expect(container.textContent).toContain('August 1, 2026');
    const link = findLinkByText(container, 'View original');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe(BASE_MESSAGE.web_url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('InboxMessagePage — remote image blocking', () => {
  it('blocks a remote image by default and shows a "Load images (N)" button', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: '<img src="https://t.test/photo.jpg" alt="">',
    });

    const { container } = await renderAndFlush();

    const img = container.querySelector('.email-content img');
    expect(img.getAttribute('src')).not.toMatch(/^https?:/i);
    expect(img.getAttribute('data-masthead-src')).toBe('https://t.test/photo.jpg');
    expect(findButtonByText(container, 'Load images (1)')).toBeTruthy();
  });

  it('clicking "Load images" reveals the previously blocked image', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: '<img src="https://t.test/photo.jpg" alt="">',
    });

    const { container } = await renderAndFlush();
    fireClick(findButtonByText(container, 'Load images (1)'));

    const img = container.querySelector('.email-content img');
    expect(img.getAttribute('src')).toBe('https://t.test/photo.jpg');
    expect(img.hasAttribute('data-masthead-src')).toBe(false);
  });

  it('settings alwaysLoadRemoteImages=true skips blocking from the start (no Load images button)', async () => {
    settingsState = { alwaysLoadRemoteImages: true };
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: '<img src="https://t.test/photo.jpg" alt="">',
    });

    const { container } = await renderAndFlush();

    const img = container.querySelector('.email-content img');
    expect(img.getAttribute('src')).toBe('https://t.test/photo.jpg');
    expect(container.textContent).not.toContain('Load images');
  });

  // Mandatory pin (3A carry-forward): img[src], img[srcset], AND
  // picture>source[srcset] must ALL be neutralized — stripping only
  // img[src] leaves a tracking-pixel hole via srcset/<picture> fallback.
  it('shows ZERO live remote references across img[src] + img[srcset] + picture>source while blocked, and "Load images" restores all three', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body:
        '<img src="https://t.test/plain.jpg">' +
        '<img src="https://t.test/a.jpg" srcset="https://t.test/a-2x.jpg 2x">' +
        '<picture><source srcset="https://t.test/wide.jpg"><img src="https://t.test/inpic.jpg"></picture>',
    });

    const { container } = await renderAndFlush();

    const blockedEls = container.querySelectorAll('.email-content img, .email-content source');
    expect(blockedEls.length).toBeGreaterThan(0);
    blockedEls.forEach((el) => {
      expect(el.getAttribute('src') || '').not.toMatch(/^https?:/i);
      expect(el.getAttribute('srcset') || '').not.toMatch(/https?:/i);
    });

    // 3 <img> elements + 1 <source> element = 4 (F1b: blockedCount counts
    // any neutralized element, not just <img> — see emailImages.test.js).
    fireClick(findButtonByText(container, 'Load images (4)'));

    const restoredEls = container.querySelectorAll('.email-content img, .email-content source');
    const restoredRefs = Array.from(restoredEls).flatMap((el) => [el.getAttribute('src'), el.getAttribute('srcset')]).filter(Boolean);
    expect(restoredRefs.some((v) => /^https?:/i.test(v) || /https?:/i.test(v))).toBe(true);
    restoredEls.forEach((el) => {
      expect(el.hasAttribute('data-masthead-src')).toBe(false);
      expect(el.hasAttribute('data-masthead-srcset')).toBe(false);
    });
  });
});

describe('InboxMessagePage — fallback chain', () => {
  it('falls back to text_body in a <pre> when html_body is absent', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: null,
      text_body: 'Plain text newsletter body.\n\nSecond paragraph.',
    });

    const { container } = await renderAndFlush();

    const pre = container.querySelector('pre.whitespace-pre-wrap');
    expect(pre).toBeTruthy();
    expect(pre.textContent).toContain('Plain text newsletter body.');
    expect(container.querySelector('.email-content')).toBeFalsy();
  });

  it('falls back to excerpt + View original link when neither html_body nor text_body is present', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: null,
      text_body: null,
      excerpt: 'A short teaser of the message.',
    });

    const { container } = await renderAndFlush();

    expect(container.textContent).toContain('A short teaser of the message.');
    const links = Array.from(container.querySelectorAll('a')).filter((a) => a.textContent.trim() === 'View original');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute('href')).toBe(BASE_MESSAGE.web_url);
  });

  // F6 (Opus fix round 1, one-char fix): `blocked` is null whenever
  // `sanitized` is falsy (including '' — sanitizeEmailHtml stripped
  // html_body down to nothing, e.g. a bare <script> tag). The pre-fix
  // `blocked.html` (no optional chaining) threw a TypeError in that
  // specific case, since `sanitized == null` is false for '' — it should
  // fall through to the excerpt fallback instead of crashing.
  it('does not crash when html_body sanitizes to an empty string — falls through to the fallback chain', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: '<script>alert(1)</script>',
      text_body: null,
      excerpt: 'Fallback excerpt text.',
    });

    const { container } = await renderAndFlush();

    expect(container.querySelector('.email-content')).toBeFalsy();
    expect(container.textContent).toContain('Fallback excerpt text.');
  });
});

describe('InboxMessagePage — unsubscribe', () => {
  it('labels an https unsubscribe_url with the target hostname', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      unsubscribe_url: 'https://mail.overhead.example/unsub?token=abc',
    });

    const { container } = await renderAndFlush();

    const link = findLinkByText(container, 'Unsubscribe (mail.overhead.example)');
    expect(link).toBeTruthy();
    // Never auto-fired: a plain declarative <a>, not a click handler that
    // fetches/navigates during render.
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://mail.overhead.example/unsub?token=abc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('labels a mailto: unsubscribe_url as "mail app"', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      unsubscribe_url: 'mailto:unsubscribe@overhead.example',
    });

    const { container } = await renderAndFlush();

    expect(findLinkByText(container, 'Unsubscribe (mail app)')).toBeTruthy();
  });

  it('renders no Unsubscribe control when unsubscribe_url is absent', async () => {
    inboxData.getMessage.mockResolvedValueOnce({ ...BASE_MESSAGE, unsubscribe_url: null });

    const { container } = await renderAndFlush();

    expect(container.textContent).not.toContain('Unsubscribe');
  });
});

describe('InboxMessagePage — mark-read on mount', () => {
  it('marks the message read exactly once via openMessage, decrementing unreadCount without any list refetch', async () => {
    useInboxStore.setState({ unreadCount: 5, messages: [{ id: MESSAGE_ID, read_at: null }] });
    inboxData.getMessage.mockResolvedValueOnce({ ...BASE_MESSAGE, read_at: null });

    await renderAndFlush();

    expect(inboxData.markRead).toHaveBeenCalledTimes(1);
    expect(inboxData.markRead).toHaveBeenCalledWith(MESSAGE_ID);
    expect(useInboxStore.getState().unreadCount).toBe(4);
    expect(inboxData.listMessages).not.toHaveBeenCalled();
  });
});

describe('InboxMessagePage — tombstone / removed state', () => {
  it('renders "This message was removed" when the resolved message has deleted_at set — never the normal reader', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      deleted_at: '2026-08-01T10:00:00.000Z',
      html_body: '<p>should never render</p>',
    });

    const { container } = await renderAndFlush();

    expect(container.textContent).toContain('This message was removed');
    expect(container.textContent).not.toContain('should never render');
    expect(container.querySelector('.email-content')).toBeFalsy();
  });

  it('renders the same removed state for a getMessage miss (purged/foreign id, PGRST116)', async () => {
    inboxData.getMessage.mockRejectedValueOnce({
      message: 'JSON object requested, multiple (or no) rows returned',
      code: 'PGRST116',
    });

    const { container } = await renderAndFlush();

    expect(container.textContent).toContain('This message was removed');
  });
});

describe('InboxMessagePage — F3 (Opus fix round 1): transient errors are retryable, not "removed"', () => {
  it('a transient failure (no error code — e.g. a network blip) shows a retryable error state, NOT "This message was removed"', async () => {
    inboxData.getMessage.mockRejectedValueOnce({ message: 'Failed to fetch' });

    const { container } = await renderAndFlush();

    expect(container.textContent).not.toContain('This message was removed');
    expect(container.textContent).toContain('Failed to fetch');
    expect(findButtonByText(container, 'Retry')).toBeTruthy();
  });

  it('clicking Retry re-fires openMessage for the same id', async () => {
    inboxData.getMessage
      .mockRejectedValueOnce({ message: 'Failed to fetch' })
      .mockResolvedValueOnce({ ...BASE_MESSAGE, html_body: '<p>recovered</p>' });

    const { container } = await renderAndFlush();
    expect(inboxData.getMessage).toHaveBeenCalledTimes(1);

    await fireClickAsync(findButtonByText(container, 'Retry'));

    expect(inboxData.getMessage).toHaveBeenCalledTimes(2);
    expect(inboxData.getMessage).toHaveBeenNthCalledWith(2, MESSAGE_ID);
    expect(container.textContent).toContain('recovered');
    expect(container.textContent).not.toContain('Failed to fetch');
  });

  it('a genuine PGRST116 miss still shows "removed", with no Retry button', async () => {
    inboxData.getMessage.mockRejectedValueOnce({
      message: 'JSON object requested, multiple (or no) rows returned',
      code: 'PGRST116',
    });

    const { container } = await renderAndFlush();

    expect(container.textContent).toContain('This message was removed');
    expect(findButtonByText(container, 'Retry')).toBeFalsy();
  });
});

describe('InboxMessagePage — delete', () => {
  it('Delete calls store.remove(id) with no confirm, then navigates back to /inbox', async () => {
    inboxData.getMessage.mockResolvedValueOnce({ ...BASE_MESSAGE });
    inboxData.removeMessage.mockResolvedValueOnce(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');

    const { container } = await renderAndFlush();
    await fireClickAsync(container.querySelector('[aria-label="Delete message"]'));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(inboxData.removeMessage).toHaveBeenCalledWith(MESSAGE_ID);
    expect(container.querySelector('[data-testid="inbox-landing"]')).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it('still issues the server tombstone even when the message is absent from the local list (deep link)', async () => {
    useInboxStore.setState({ messages: [] });
    inboxData.getMessage.mockResolvedValueOnce({ ...BASE_MESSAGE });
    inboxData.removeMessage.mockResolvedValueOnce(undefined);

    const { container } = await renderAndFlush();
    await fireClickAsync(container.querySelector('[aria-label="Delete message"]'));

    expect(inboxData.removeMessage).toHaveBeenCalledWith(MESSAGE_ID);
  });
});

describe('InboxMessagePage — clickjacking containment', () => {
  // Controller ruling (3A final-review carry-forward): the style ATTRIBUTE
  // survives sanitizeEmailHtml, so hostile email CSS (position, negative
  // margin, huge z-index) could try to overlay app chrome. `isolation`
  // gives the container its own stacking context (z-index can't escape
  // upward — genuinely load-bearing, verified). F4 (Opus fix round 1):
  // `position:relative` + `overflow:hidden` alone do NOT stop a
  // `position:fixed` descendant from escaping the box — only
  // `transform`/`filter`/`perspective`/`contain` create a new containing
  // block for fixed descendants. `contain: layout paint` is the property
  // that actually does that job, so THAT is what gets pinned here (not
  // `overflow`, which the pre-fix test asserted for the wrong reason).
  it('the email content container carries the containment class, whose stylesheet declares isolation + contain (the property that actually traps position:fixed descendants)', async () => {
    inboxData.getMessage.mockResolvedValueOnce({
      ...BASE_MESSAGE,
      html_body: '<div style="position:fixed;z-index:9999">x</div>',
    });

    const { container } = await renderAndFlush();

    const el = container.querySelector('.email-content');
    expect(el).toBeTruthy();

    // globalThis.process (not a bare `process` reference): this file's
    // no-undef scope is globals.browser (src/**), which doesn't declare
    // Node's `process` — the runtime object is still there (vitest runs on
    // Node regardless of jsdom's simulated window/document), only the
    // static "is this identifier declared" check needs the indirection.
    const cssPath = path.join(globalThis.process.cwd(), 'src/styles/email-content.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    expect(css).toMatch(/\.email-content\s*{[^}]*isolation\s*:\s*isolate/s);
    expect(css).toMatch(/\.email-content\s*{[^}]*contain\s*:\s*layout paint/s);
  });
});

describe('InboxMessagePage — loading state', () => {
  it('shows a loading skeleton while the fetch is in flight', () => {
    inboxData.getMessage.mockReturnValue(new Promise(() => {})); // never resolves in this test

    const { container } = renderMessagePage();

    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });
});
