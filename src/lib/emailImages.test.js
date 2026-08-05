// @vitest-environment jsdom
//
// Security carry-forward from the 3A final review, extended by Opus fix
// round 1 (F1/F1b) on Task 16's first pass. blockRemoteImages must
// neutralize every remote-fetch vector an already-sanitized message body
// can carry — img[src], img[srcset], <source> (anywhere — picture, audio,
// video), video[poster], track[src], and the legacy background attribute
// on table/td/th/tr — using an INVERTED test (remote unless provably safe:
// data: or same-origin), not a scheme allowlist that a protocol-relative
// URL (`//host/x.jpg`) sails straight through.
import { describe, it, expect } from 'vitest';
import { blockRemoteImages } from './emailImages.js';

function remoteRefs(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const refs = [];
  doc.querySelectorAll('img, source, video, track, table, td, th, tr').forEach((el) => {
    ['src', 'srcset', 'poster', 'background'].forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value && /(^|[/:])t\.test/i.test(value)) refs.push(value);
    });
  });
  return refs;
}

describe('blockRemoteImages — img[src] / img[srcset]', () => {
  it('neutralizes img[src], stashing the original under data-masthead-src', () => {
    const { html } = blockRemoteImages('<img src="https://t.test/photo.jpg" alt="">');
    expect(remoteRefs(html)).toHaveLength(0);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('img').getAttribute('data-masthead-src')).toBe('https://t.test/photo.jpg');
  });

  it('neutralizes img[srcset], stashing the original under data-masthead-srcset', () => {
    const { html } = blockRemoteImages('<img src="https://t.test/a.jpg" srcset="https://t.test/a-2x.jpg 2x">');
    expect(remoteRefs(html)).toHaveLength(0);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('img').getAttribute('data-masthead-srcset')).toBe('https://t.test/a-2x.jpg 2x');
  });

  it('counts one blocked image even when both src and srcset were neutralized on the same <img>', () => {
    const { blockedCount } = blockRemoteImages(
      '<img src="https://t.test/a.jpg" srcset="https://t.test/a-2x.jpg 2x">'
    );
    expect(blockedCount).toBe(1);
  });
});

describe('blockRemoteImages — F1: protocol-relative URLs blocked in every vector', () => {
  // `//host/path` has NO scheme — the pre-fix `/https?:/i` test matched
  // neither `http:` nor `https:` and let it straight through, yet on an
  // https page it resolves to a live https request. Every vector must
  // catch it.
  const CASES = [
    ['img src', '<img src="//t.test/beacon.jpg">', 'img', 'src'],
    ['img srcset', '<img src="a.jpg" srcset="//t.test/beacon-2x.jpg 2x">', 'img', 'srcset'],
    ['picture>source srcset', '<picture><source srcset="//t.test/beacon.jpg"><img src="a.jpg"></picture>', 'source', 'srcset'],
    ['audio>source src (not inside picture)', '<audio><source src="//t.test/beacon.mp3"></audio>', 'source', 'src'],
    ['video poster', '<video poster="//t.test/beacon.jpg"></video>', 'video', 'poster'],
    ['track src', '<video><track src="//t.test/beacon.vtt" kind="captions"></video>', 'track', 'src'],
    ['table background', '<table background="//t.test/beacon.jpg"><tr><td>x</td></tr></table>', 'table', 'background'],
  ];

  it.each(CASES)('%s', (_label, fixture, tag, attr) => {
    const { html, blockedCount } = blockRemoteImages(fixture);
    expect(remoteRefs(html)).toHaveLength(0);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector(tag);
    // The blocked attribute is either replaced (img[src] → placeholder) or
    // removed entirely (everything else) — getAttribute() returns null in
    // the removed case, so normalize to '' before the string assertion.
    expect(el.getAttribute(attr) || '').not.toContain('t.test');
    expect(el.getAttribute(`data-masthead-${attr}`)).toContain('t.test');
    expect(blockedCount).toBeGreaterThan(0);
  });

  it('neutralizes the legacy background attribute on td/th/tr too, not just table', () => {
    const { html } = blockRemoteImages(
      '<table><tr background="//t.test/row.jpg"><td background="//t.test/cell.jpg">x</td></tr></table>'
    );
    expect(remoteRefs(html)).toHaveLength(0);
  });
});

describe('blockRemoteImages — F1: case and whitespace cannot smuggle a remote URL past the check', () => {
  it('blocks an uppercase-scheme, whitespace-padded remote URL', () => {
    const { html } = blockRemoteImages('<img src="  HTTPS://T.TEST/Beacon.JPG  ">');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    expect(img.getAttribute('src')).not.toContain('T.TEST');
    expect(img.getAttribute('data-masthead-src')).toContain('T.TEST');
  });

  it('splits srcset on commas and blocks a remote candidate after a leading data: one', () => {
    const dataUri = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const { html } = blockRemoteImages(`<img src="${dataUri}" srcset="${dataUri} 1x, //t.test/x-2x.jpg 2x">`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    expect(img.getAttribute('srcset')).toBeNull();
    expect(img.getAttribute('data-masthead-srcset')).toContain('t.test');
  });
});

describe('blockRemoteImages — F1b: blockedCount counts any neutralized element, not just <img>', () => {
  it('a bare picture>source with no fallback <img> still gets a nonzero blockedCount', () => {
    const { blockedCount, html } = blockRemoteImages('<picture><source srcset="https://t.test/wide.jpg"></picture>');
    expect(blockedCount).toBeGreaterThan(0);
    expect(remoteRefs(html)).toHaveLength(0);
  });

  it('combined img[src] + img[srcset] + picture>source payload: zero live refs, blockedCount covers every element', () => {
    const { html, blockedCount } = blockRemoteImages(
      '<img src="https://t.test/plain.jpg">' +
      '<img src="https://t.test/a.jpg" srcset="https://t.test/a-2x.jpg 2x">' +
      '<picture><source srcset="https://t.test/wide.jpg"><img src="https://t.test/inpic.jpg"></picture>'
    );
    expect(remoteRefs(html)).toHaveLength(0);
    // 3 <img> elements + 1 <source> element = 4.
    expect(blockedCount).toBe(4);
  });
});

describe('blockRemoteImages — safe values are left alone', () => {
  it('leaves data: URIs alone — they carry no remote request', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const { html, blockedCount } = blockRemoteImages(`<img src="${dataUri}">`);
    expect(html).toContain(dataUri);
    expect(blockedCount).toBe(0);
  });

  it('does not block a same-origin absolute reference', () => {
    const sameOrigin = `${window.location.origin}/icons/masthead.svg`;
    const { html, blockedCount } = blockRemoteImages(`<img src="${sameOrigin}">`);
    expect(html).toContain(sameOrigin);
    expect(blockedCount).toBe(0);
  });

  it('is a no-op on html with no images', () => {
    const { html, blockedCount } = blockRemoteImages('<p>plain text</p>');
    expect(html).toContain('plain text');
    expect(blockedCount).toBe(0);
  });

  it('returns empty output for null/empty input without throwing', () => {
    expect(blockRemoteImages(null)).toEqual({ html: '', blockedCount: 0 });
    expect(blockRemoteImages('')).toEqual({ html: '', blockedCount: 0 });
  });
});
