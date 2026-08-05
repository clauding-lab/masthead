// src/lib/emailImages.js — post-processes ALREADY-SANITIZED email HTML (a
// string, output of sanitizeEmailHtml) to neutralize remote image requests
// before the HTML ever renders. Security carry-forward from the 3A final
// review: a remote image is a tracking-pixel / read-receipt vector — the
// sender learns the message was opened the instant the browser fetches it.
// Blocking only `img[src]` is NOT enough: `img[srcset]` and `<source
// src|srcset>` inside `<picture>` are two more ways the same browser can be
// made to fetch a remote URL, and any one left unblocked defeats blocking
// by default. `data:` URIs are left untouched — they embed the image bytes
// inline and never generate a network request.
//
// Deliberately does NOT touch `style="background-image:url(...)"` — that is
// a known, out-of-scope residual vector for this task (see
// InboxMessagePage's usage site comment); only the three vectors named
// above are in scope here.
const PLACEHOLDER_SRC =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22%3E%3C/svg%3E';

function hasRemoteRef(value) {
  return typeof value === 'string' && /https?:/i.test(value);
}

/**
 * @param {string} html sanitized email HTML (already run through
 *   sanitizeEmailHtml)
 * @returns {{ html: string, blockedCount: number }} `blockedCount` is the
 *   number of <img> elements that had a remote src and/or srcset
 *   neutralized — the user-facing "N" for a "Load images (N)" control.
 */
export function blockRemoteImages(html) {
  if (!html) return { html: '', blockedCount: 0 };

  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  let blockedCount = 0;

  doc.querySelectorAll('img').forEach((img) => {
    let blockedThisImg = false;

    const src = img.getAttribute('src');
    if (hasRemoteRef(src)) {
      img.setAttribute('data-masthead-src', src);
      img.setAttribute('src', PLACEHOLDER_SRC);
      blockedThisImg = true;
    }

    const srcset = img.getAttribute('srcset');
    if (hasRemoteRef(srcset)) {
      img.setAttribute('data-masthead-srcset', srcset);
      img.removeAttribute('srcset');
      blockedThisImg = true;
    }

    if (blockedThisImg) blockedCount += 1;
  });

  // <picture><source> is a THIRD vector: a browser can pick a <source>'s
  // srcset (or src) over the fallback <img> entirely, so blocking the <img>
  // alone still lets the <source> fire.
  doc.querySelectorAll('picture source').forEach((source) => {
    const srcset = source.getAttribute('srcset');
    if (hasRemoteRef(srcset)) {
      source.setAttribute('data-masthead-srcset', srcset);
      source.removeAttribute('srcset');
    }

    const src = source.getAttribute('src');
    if (hasRemoteRef(src)) {
      source.setAttribute('data-masthead-src', src);
      source.removeAttribute('src');
    }
  });

  return { html: doc.body.innerHTML, blockedCount };
}
