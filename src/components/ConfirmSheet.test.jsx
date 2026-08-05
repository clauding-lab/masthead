// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import ConfirmSheet from './ConfirmSheet';
import { renderComponent, cleanupRendered, fireClick } from '../test/domTestUtils';

afterEach(() => {
  cleanupRendered();
  vi.restoreAllMocks();
});

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

const PROPS = {
  open: true,
  title: 'Regenerate address?',
  message: 'This permanently stops mail sent to the old address — update your subscriptions after.',
  confirmLabel: 'Regenerate',
};

describe('ConfirmSheet — landmine 22 (never window.confirm)', () => {
  it('renders nothing when closed', () => {
    const { container } = renderComponent(
      <ConfirmSheet {...PROPS} open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    expect(container.textContent).toBe('');
  });

  it('renders the title, message, and confirmLabel when open', () => {
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(container.textContent).toContain('Regenerate address?');
    expect(container.textContent).toContain('update your subscriptions after');
    expect(findButtonByText(container, 'Regenerate')).toBeTruthy();
  });

  it('clicking the confirm button fires onConfirm and never onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={onConfirm} onCancel={onCancel} />);

    fireClick(findButtonByText(container, 'Regenerate'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('clicking Cancel fires onCancel only — onConfirm is never called', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={onConfirm} onCancel={onCancel} />);

    fireClick(findButtonByText(container, 'Cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('clicking the backdrop fires onCancel only, consistent with AddSourceModal’s backdrop-click-to-close', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={onConfirm} onCancel={onCancel} />);

    fireClick(container.querySelector('.bg-black\\/40'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('pressing Escape fires onCancel only, never onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderComponent(<ConfirmSheet {...PROPS} onConfirm={onConfirm} onCancel={onCancel} />);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('focuses the Cancel button (the safe default) on open', () => {
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(document.activeElement).toBe(findButtonByText(container, 'Cancel'));
  });

  it('traps Tab focus: Tab from Confirm wraps back to Cancel', () => {
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const cancelBtn = findButtonByText(container, 'Cancel');
    const confirmBtn = findButtonByText(container, 'Regenerate');

    confirmBtn.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

    expect(document.activeElement).toBe(cancelBtn);
  });

  it('traps Tab focus: Shift+Tab from Cancel wraps forward to Confirm', () => {
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const cancelBtn = findButtonByText(container, 'Cancel');
    const confirmBtn = findButtonByText(container, 'Regenerate');

    cancelBtn.focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    );

    expect(document.activeElement).toBe(confirmBtn);
  });

  it('danger styles the confirm button distinctly from the default accent styling', () => {
    const { container: normal } = renderComponent(
      <ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    const normalConfirm = findButtonByText(normal, 'Regenerate');

    const { container: dangerContainer } = renderComponent(
      <ConfirmSheet {...PROPS} danger onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    const dangerConfirm = findButtonByText(dangerContainer, 'Regenerate');

    expect(dangerConfirm.style.backgroundColor).not.toBe(normalConfirm.style.backgroundColor);
  });

  it('is presented as an alertdialog with an accessible name from the title', () => {
    const { container } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('never calls window.confirm anywhere in its own source (landmine 22 grep pin)', () => {
    const src = fs.readFileSync(path.join(globalThis.process.cwd(), 'src/components/ConfirmSheet.jsx'), 'utf8');
    expect(src).not.toContain('window.confirm(');
  });

  // F2 (Opus fix round 1, MEDIUM a11y — WCAG 2.4.3): closing the sheet must
  // return focus to whatever triggered it, not leave activeElement on a
  // button that's about to unmount/detach (browsers silently drop that to
  // <body>).
  it('restores focus to the trigger element when the sheet closes', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open sheet';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = renderComponent(
      <ConfirmSheet {...PROPS} open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />
    );
    // Opening captures whatever was focused (the trigger) BEFORE moving
    // focus into the sheet.
    rerender(<ConfirmSheet {...PROPS} open onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement).not.toBe(trigger);

    // Closing (open flips back to false, mirroring what a real parent does
    // on Escape/backdrop/Cancel/Confirm) restores focus to the trigger.
    rerender(<ConfirmSheet {...PROPS} open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement).toBe(trigger);

    trigger.remove();
  });

  // F3 (Opus fix round 1, MEDIUM a11y — reachable today via SettingsPage,
  // which subscribes to the whole inbox store and re-renders when its
  // mount-effect quota GET resolves while a sheet is open). A parent
  // re-render that hands ConfirmSheet a brand-new onCancel FUNCTION
  // IDENTITY (same open=true, same everything else) must never steal focus
  // away from wherever the keyboard user currently is.
  it('a fresh onCancel identity on re-render does not steal focus back to Cancel', () => {
    const { container, rerender } = renderComponent(
      <ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={() => {}} />
    );
    const confirmBtn = findButtonByText(container, 'Regenerate');
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);

    // A brand-new onCancel closure every time, same as a parent component
    // re-rendering with `onCancel={() => setX(null)}` inline.
    rerender(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={() => {}} />);
    rerender(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={() => {}} />);

    expect(document.activeElement).toBe(confirmBtn);
  });

  // F3, other half: the Escape/Tab-trap listener must still work with
  // whichever onCancel identity is CURRENT at the time of the keypress —
  // splitting the effects must not leave a stale closure wired to document.
  it('Escape still fires the CURRENT onCancel after a re-render with a fresh identity', () => {
    const firstOnCancel = vi.fn();
    const secondOnCancel = vi.fn();
    const { rerender } = renderComponent(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={firstOnCancel} />);

    rerender(<ConfirmSheet {...PROPS} onConfirm={vi.fn()} onCancel={secondOnCancel} />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(secondOnCancel).toHaveBeenCalledTimes(1);
    expect(firstOnCancel).not.toHaveBeenCalled();
  });
});
