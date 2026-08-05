// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { inboxPermalink, isInboxPermalink } from './inboxPermalink.js';

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('inboxPermalink', () => {
  it('mints a URL under the current origin at /inbox/message/<id>', () => {
    expect(inboxPermalink(UUID)).toBe(`${window.location.origin}/inbox/message/${UUID}`);
  });
});

describe('isInboxPermalink', () => {
  it('round-trips: a URL just minted by inboxPermalink is recognised', () => {
    expect(isInboxPermalink(inboxPermalink(UUID))).toBe(true);
  });

  it('is origin-independent — any host with the right path shape matches (Phase-4 domain swap)', () => {
    expect(isInboxPermalink(`https://future-domain.example/inbox/message/${UUID}`)).toBe(true);
    expect(isInboxPermalink(`http://localhost:5173/inbox/message/${UUID}`)).toBe(true);
  });

  it('accepts an uppercase UUID (case-insensitive)', () => {
    expect(isInboxPermalink(`https://x.test/inbox/message/${UUID.toUpperCase()}`)).toBe(true);
  });

  it('rejects a non-uuid final path segment', () => {
    expect(isInboxPermalink('https://evil.test/inbox/message/x')).toBe(false);
  });

  it('rejects query-string smuggling — the uuid path must be the actual pathname, not a query value', () => {
    expect(isInboxPermalink(`https://x.test/a?u=/inbox/message/${UUID}`)).toBe(false);
  });

  it('rejects a path with extra trailing segments (end-anchored)', () => {
    expect(isInboxPermalink(`https://x.test/inbox/message/${UUID}/extra`)).toBe(false);
  });

  it('rejects a path that is missing the /inbox/message/ prefix entirely', () => {
    expect(isInboxPermalink(`https://x.test/${UUID}`)).toBe(false);
  });

  it('rejects non-string and unparseable input without throwing', () => {
    expect(isInboxPermalink(null)).toBe(false);
    expect(isInboxPermalink(undefined)).toBe(false);
    expect(isInboxPermalink('not a url')).toBe(false);
    expect(isInboxPermalink('')).toBe(false);
  });
});
