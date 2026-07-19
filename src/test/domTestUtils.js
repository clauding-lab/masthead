// Minimal hand-rolled React render harness for component tests.
//
// @testing-library/react is NOT a dependency of this repo, and adding new
// dependencies is out-of-scope without sign-off (AGENTS.md). Everything here
// is built on `react` + `react-dom`, both already installed. Covers exactly
// what AddSourceModal.test.jsx / PremiumSourceRow.test.jsx need: mount,
// unmount, click, type, blur.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot } from 'react-dom/client';

const mountedRoots = [];

export function renderComponent(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push({ root, container });
  return {
    container,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

// Call from afterEach so a failing test doesn't leak a mounted tree into the
// next one (two AddSourceModal mounts in the same test file must stay
// isolated for the randomized-name assertion).
export function cleanupRendered() {
  while (mountedRoots.length) {
    const { root, container } = mountedRoots.pop();
    act(() => {
      root.unmount();
    });
    container.remove();
  }
}

function nativeValueSetter(el) {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value').set;
}

// Simulates typing: sets the value via the native setter (bypassing React's
// tracked-value shortcut) then dispatches 'input', which is what React's
// controlled-input onChange actually listens for.
export function fireChange(el, value) {
  act(() => {
    nativeValueSetter(el).call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Works for buttons, checkboxes, and role="switch"/"radio" buttons: native
// .click() toggles checkbox state per the HTML spec before dispatch, and
// React's synthetic onChange for checkboxes listens on the click event.
export function fireClick(el) {
  act(() => {
    el.click();
  });
}

// Async variant for handlers that kick off a promise (e.g. addFeed) so the
// state update after the awaited promise settles is flushed before we assert.
export async function fireClickAsync(el) {
  await act(async () => {
    el.click();
  });
}

// blur/focus don't bubble, but React listens for the bubbling 'focusout'
// equivalent to implement onBlur — dispatching plain 'blur' does not reach
// the root listener in this hand-rolled harness.
export function fireBlur(el) {
  act(() => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}
