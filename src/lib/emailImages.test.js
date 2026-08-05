// @vitest-environment jsdom
//
// Security carry-forward from the 3A final review (AGENTS.md is silent on
// this one specifically because it's new in Task 16): remote images inside
// a sanitised newsletter body are a tracking-pixel / read-receipt vector.
// blockRemoteImages must neutralize ALL THREE vectors an <img>/<picture>
// pair can carry a remote URL through — img[src], img[srcset], and
// <source>[src|srcset] inside <picture> — not just the first one found.
import { describe, it, expect } from 'vitest';
import { blockRemoteImages } from './emailImages.js';

function remoteRefs(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const refs = [];
  doc.querySelectorAll('img, source').forEach((el) => {
    const src = el.getAttribute('src');
    const srcset = el.getAttribute('srcset');
    if (src && /^https?:/i.test(src)) refs.push(src);
    if (srcset && /https?:/i.test(srcset)) refs.push(srcset);
  });
  return refs;
}

describe('blockRemoteImages', () => {
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
    const img = doc.querySelector('img');
    expect(img.getAttribute('data-masthead-srcset')).toBe('https://t.test/a-2x.jpg 2x');
  });

  it('neutralizes <source> src AND srcset inside <picture> — the vector img[src]-only blocking misses', () => {
    const { html } = blockRemoteImages(
      '<picture><source srcset="https://t.test/wide.jpg" media="(min-width:600px)"><source src="https://t.test/fallback.jpg"><img src="https://t.test/base.jpg"></picture>'
    );
    expect(remoteRefs(html)).toHaveLength(0);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const sources = doc.querySelectorAll('source');
    expect(sources[0].getAttribute('data-masthead-srcset')).toBe('https://t.test/wide.jpg');
    expect(sources[1].getAttribute('data-masthead-src')).toBe('https://t.test/fallback.jpg');
  });

  it('shows ZERO live remote references across a combined img[src]+img[srcset]+picture>source payload', () => {
    const { html, blockedCount } = blockRemoteImages(
      '<img src="https://t.test/plain.jpg">' +
      '<img src="https://t.test/a.jpg" srcset="https://t.test/a-2x.jpg 2x, https://t.test/a-3x.jpg 3x">' +
      '<picture><source srcset="https://t.test/wide.jpg"><img src="https://t.test/inpicture.jpg"></picture>'
    );
    expect(remoteRefs(html)).toHaveLength(0);
    expect(blockedCount).toBeGreaterThan(0);
  });

  it('leaves data: URIs alone — they carry no remote request', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const { html, blockedCount } = blockRemoteImages(`<img src="${dataUri}">`);
    expect(html).toContain(dataUri);
    expect(blockedCount).toBe(0);
  });

  it('counts one blocked image even when both src and srcset were neutralized on the same <img>', () => {
    const { blockedCount } = blockRemoteImages(
      '<img src="https://t.test/a.jpg" srcset="https://t.test/a-2x.jpg 2x">'
    );
    expect(blockedCount).toBe(1);
  });

  it('returns empty output for null/empty input without throwing', () => {
    expect(blockRemoteImages(null)).toEqual({ html: '', blockedCount: 0 });
    expect(blockRemoteImages('')).toEqual({ html: '', blockedCount: 0 });
  });

  it('is a no-op on html with no images', () => {
    const { html, blockedCount } = blockRemoteImages('<p>plain text</p>');
    expect(html).toContain('plain text');
    expect(blockedCount).toBe(0);
  });
});
