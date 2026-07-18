const BLOG_HOST_SUFFIXES = ['substack.com', 'ghost.io', 'beehiiv.com', 'medium.com', 'buttondown.email'];

// Domain-based default for the Add Source modal (2D spec §4.5).
// Total function: any unparseable input just suggests 'news'.
export function suggestKind(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return 'news';
  try {
    const withScheme = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return BLOG_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`)) ? 'blog' : 'news';
  } catch {
    return 'news';
  }
}
