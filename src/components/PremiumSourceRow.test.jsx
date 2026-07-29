// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PremiumSourceRow from './PremiumSourceRow';
import usePremiumStore from '../stores/premiumStore';
import { renderComponent, cleanupRendered, fireChange, fireClick, fireClickAsync } from '../test/domTestUtils';

vi.mock('../stores/premiumStore', () => ({ default: vi.fn() }));

// A raw url with a token deliberately sits on the fixture — PremiumSourceRow
// must never render it (spec §5.1: masked display only).
const FEED = {
  id: 'p1',
  label: 'FT Premium',
  hostHint: 'ft.com',
  kind: 'news',
  category: 'macro',
  url: 'https://ft.com/rss?token=SUPERSECRET',
};

function textContains(container, text) {
  return container.textContent.includes(text);
}

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text);
}

describe('PremiumSourceRow (2E)', () => {
  let toggleEnabled;
  let removeFeed;
  let patchFeed;

  beforeEach(() => {
    toggleEnabled = vi.fn();
    removeFeed = vi.fn().mockResolvedValue(undefined);
    patchFeed = vi.fn().mockResolvedValue(undefined);
    usePremiumStore.mockReturnValue({
      enabledIds: ['p1'],
      toggleEnabled,
      removeFeed,
      patchFeed,
    });
  });

  afterEach(() => {
    cleanupRendered();
    vi.restoreAllMocks();
  });

  it('shows only the masked label + hostHint — never a full URL', () => {
    const { container } = renderComponent(<PremiumSourceRow feed={FEED} />);

    expect(textContains(container, 'FT Premium')).toBe(true);
    expect(textContains(container, 'ft.com')).toBe(true);
    expect(container.innerHTML.includes('SUPERSECRET')).toBe(false);
    expect(container.innerHTML.includes('token=')).toBe(false);
    expect(container.innerHTML.includes(FEED.url)).toBe(false);
  });

  it('renders a lock badge marking the feed as premium, exposed to assistive tech (not aria-hidden)', () => {
    const { container } = renderComponent(<PremiumSourceRow feed={FEED} />);
    const lockIcon = container.querySelector('svg[aria-label="Premium feed"]');
    expect(lockIcon).toBeTruthy();
    expect(lockIcon.hasAttribute('aria-hidden')).toBe(false);
  });

  it('the enable toggle is a switch and calls toggleEnabled(id)', () => {
    const { container } = renderComponent(<PremiumSourceRow feed={FEED} />);
    const toggle = container.querySelector('[role="switch"]');

    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireClick(toggle);
    expect(toggleEnabled).toHaveBeenCalledWith('p1');
  });

  it('delete asks for confirmation and only calls removeFeed when confirmed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { container } = renderComponent(<PremiumSourceRow feed={FEED} />);
    const deleteButton = container.querySelector('[aria-label="Remove FT Premium"]');

    await fireClickAsync(deleteButton);
    expect(confirmSpy).toHaveBeenCalled();
    expect(removeFeed).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await fireClickAsync(deleteButton);
    expect(removeFeed).toHaveBeenCalledWith('p1');
  });

  it('expanding edit reveals label input + kind radio + category select, and Save calls patchFeed', async () => {
    const { container } = renderComponent(<PremiumSourceRow feed={FEED} />);
    const editButton = container.querySelector('[aria-label="Edit FT Premium"]');

    fireClick(editButton);

    const labelInput = container.querySelector('[aria-label="Feed label"]');
    expect(labelInput).toBeTruthy();
    expect(labelInput.value).toBe('FT Premium');
    expect(container.querySelectorAll('[role="radio"]').length).toBe(2);
    expect(container.querySelector('[aria-label="Category"]')).toBeTruthy();

    fireChange(labelInput, 'FT Premium Renamed');
    const saveButton = findButtonByText(container, 'Save');
    await fireClickAsync(saveButton);

    expect(patchFeed).toHaveBeenCalledWith('p1', { label: 'FT Premium Renamed', kind: 'news', category: 'macro' });
  });
});
