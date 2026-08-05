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
});
