// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AddSourceModal from './AddSourceModal';
import useAuthStore from '../stores/authStore';
import usePremiumStore from '../stores/premiumStore';
import { renderComponent, cleanupRendered, fireChange, fireClick, fireClickAsync, fireBlur } from '../test/domTestUtils';

vi.mock('../stores/authStore', () => ({ default: vi.fn() }));
vi.mock('../stores/premiumStore', () => ({ default: { getState: vi.fn() } }));

function textContains(container, text) {
  return container.textContent.includes(text);
}

function queryByText(container, text) {
  return Array.from(container.querySelectorAll('button, p, span, label')).find(
    (el) => el.textContent.trim() === text
  );
}

function getCheckbox(container) {
  return container.querySelector('input[type="checkbox"]');
}

// The hardened premium URL input is the only <input> carrying autocomplete="off".
function getPremiumUrlInput(container) {
  return container.querySelector('input[autocomplete="off"]');
}

describe('AddSourceModal — premium path (2E)', () => {
  let addFeed;

  beforeEach(() => {
    addFeed = vi.fn();
    usePremiumStore.getState.mockReturnValue({ addFeed });
    useAuthStore.mockReturnValue({ user: null });
  });

  afterEach(() => {
    cleanupRendered();
    vi.restoreAllMocks();
  });

  it('premium checkbox unchecked leaves the existing discovery flow untouched', () => {
    const onAdd = vi.fn();
    const { container } = renderComponent(<AddSourceModal onAdd={onAdd} onClose={vi.fn()} />);

    expect(queryByText(container, 'Find')).toBeTruthy();
    expect(getCheckbox(container).checked).toBe(false);
    expect(usePremiumStore.getState).not.toHaveBeenCalled();
  });

  it('always explains the premium URL should be treated like a password', () => {
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    expect(textContains(container, 'like a password')).toBe(true);
  });

  it('checking premium while signed out shows a sign-in prompt with no submit control', () => {
    useAuthStore.mockReturnValue({ user: null });
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);

    fireClick(getCheckbox(container));

    expect(textContains(container, 'Sign in')).toBe(true);
    expect(queryByText(container, 'Add')).toBeFalsy();
    expect(queryByText(container, 'Find')).toBeFalsy();
  });

  it('checking premium while signed in swaps to a hardened, autofill-resistant URL input', () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);

    fireClick(getCheckbox(container));
    const input = getPremiumUrlInput(container);

    expect(input).toBeTruthy();
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(queryByText(container, 'Add')).toBeTruthy();
    expect(queryByText(container, 'Find')).toBeFalsy();
  });

  it('randomizes the hardened input name/id on every mount (anti-autofill)', () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });

    const first = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    fireClick(getCheckbox(first.container));
    const firstInput = getPremiumUrlInput(first.container);

    const second = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    fireClick(getCheckbox(second.container));
    const secondInput = getPremiumUrlInput(second.container);

    expect(firstInput.name).toBeTruthy();
    expect(secondInput.name).toBeTruthy();
    expect(firstInput.name).not.toBe(secondInput.name);
    expect(firstInput.id).toBe(firstInput.name);
  });

  it('submitting calls premiumStore.addFeed and renders a masked confirmation, leaking no URL into the DOM', async () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    addFeed.mockResolvedValue({ id: 'p1', label: 'FT Premium', hostHint: 'ft.com', kind: 'news', category: 'custom' });

    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    fireClick(getCheckbox(container));

    const secretUrl = 'https://ft.com/rss?token=SUPERSECRET123';
    fireChange(getPremiumUrlInput(container), secretUrl);

    await fireClickAsync(queryByText(container, 'Add'));

    expect(addFeed).toHaveBeenCalledWith({ url: secretUrl, kind: 'news', label: undefined, category: 'custom' });
    expect(textContains(container, 'FT Premium')).toBe(true);
    expect(textContains(container, 'ft.com')).toBe(true);
    expect(container.innerHTML.includes(secretUrl)).toBe(false);
    expect(container.innerHTML.includes('SUPERSECRET123')).toBe(false);
    expect(container.querySelector('input[autocomplete="off"]')).toBeFalsy();

    const lockIcon = container.querySelector('svg[aria-label="Premium feed added"]');
    expect(lockIcon).toBeTruthy();
    expect(lockIcon.hasAttribute('aria-hidden')).toBe(false);
  });

  it('surfaces the server error message when addFeed rejects', async () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    addFeed.mockRejectedValue(new Error('Premium feed limit reached (5)'));

    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    fireClick(getCheckbox(container));
    fireChange(getPremiumUrlInput(container), 'https://example.com/feed');

    await fireClickAsync(queryByText(container, 'Add'));

    expect(textContains(container, 'Premium feed limit reached (5)')).toBe(true);
  });

  it('clears the URL and any premium error when the premium checkbox is toggled off (no custody leak into the unauthenticated discovery input)', () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);

    const checkbox = getCheckbox(container);
    fireClick(checkbox);

    const secretUrl = 'https://ft.com/rss?token=SUPERSECRET456';
    fireChange(getPremiumUrlInput(container), secretUrl);

    fireClick(checkbox); // uncheck — back to the plain, non-hardened discovery input

    const discoveryInput = container.querySelector('input[type="text"]');
    expect(discoveryInput).toBeTruthy();
    expect(discoveryInput.value).toBe('');
    expect(container.innerHTML.includes(secretUrl)).toBe(false);
    expect(container.innerHTML.includes('SUPERSECRET456')).toBe(false);
  });

  it('suggestKind on blur pre-picks the kind in premium mode too', () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    fireClick(getCheckbox(container));

    // Default kind is 'news'; a substack.com host is one of suggestKind's
    // real BLOG_HOST_SUFFIXES, so blurring should flip the radio to 'blog'.
    const input = getPremiumUrlInput(container);
    fireChange(input, 'https://writer.substack.com/feed');
    fireBlur(input);

    const blogRadio = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (r) => r.textContent.trim() === 'Blogs & Newsletters'
    );
    const newsRadio = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (r) => r.textContent.trim() === 'News feed'
    );
    expect(blogRadio.getAttribute('aria-checked')).toBe('true');
    expect(newsRadio.getAttribute('aria-checked')).toBe('false');
  });

  it('an explicit kind choice survives premium URL blur', () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);
    fireClick(getCheckbox(container));

    const findRadio = (label) =>
      Array.from(container.querySelectorAll('[role="radio"]')).find(
        (r) => r.textContent.trim() === label
      );

    fireClick(findRadio('Blogs & Newsletters'));

    // construction-physics.com is a Substack on a custom domain, so suggestKind
    // has no way to know and defaults to 'news'. The explicit pick outranks it.
    const input = getPremiumUrlInput(container);
    fireChange(input, 'https://www.construction-physics.com/feed');
    fireBlur(input);

    expect(findRadio('Blogs & Newsletters').getAttribute('aria-checked')).toBe('true');
    expect(findRadio('News feed').getAttribute('aria-checked')).toBe('false');
  });

  it('the kind radiogroup only ever offers news/blog — social never appears, checked or not', () => {
    useAuthStore.mockReturnValue({ user: { id: 'u1' } });
    const { container } = renderComponent(<AddSourceModal onAdd={vi.fn()} onClose={vi.fn()} />);

    expect(container.querySelectorAll('[role="radio"]').length).toBe(2);
    expect(textContains(container, 'Social')).toBe(false);

    fireClick(getCheckbox(container));

    expect(container.querySelectorAll('[role="radio"]').length).toBe(2);
    expect(textContains(container, 'Social')).toBe(false);
  });
});
