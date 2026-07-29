import { useEffect, useMemo, useState } from 'react';
import TopBar from '../components/TopBar';
import CategoryTabs from '../components/CategoryTabs';
import FeedPage from './FeedPage';
import SourcePickerEmptyState from '../components/SourcePickerEmptyState';
import { useNewsFeedStore, useBlogsFeedStore } from '../stores/feedStore';
import useSettingsStore from '../stores/settingsStore';
import usePremiumStore from '../stores/premiumStore';
import { newsTabCategories, blogsTabCategories } from '../lib/feedCategories';
import sourcesData from '../../lib/sources.json';

const MODES = {
  news: { store: useNewsFeedStore, tabs: newsTabCategories },
  blogs: { store: useBlogsFeedStore, tabs: blogsTabCategories },
};

export default function FeedLayout({ mode }) {
  const { store, tabs } = MODES[mode];
  const { fetchedAt, isLoading, selectedCategory, setCategory, refresh, premiumIssues } = store();
  const selectedSourceIds = useSettingsStore((s) => s.selectedSourceIds);
  const customSources = useSettingsStore((s) => s.customSources);
  const getEffectiveSourcesByKind = useSettingsStore((s) => s.getEffectiveSourcesByKind);
  // Reactive selectors (final-review Critical 2): a .getState() snapshot
  // would miss the picker-gate update that must happen the instant
  // addFeed/loadFeeds/removeFeed changes what's enabled for this kind.
  const premiumFeeds = usePremiumStore((s) => s.feeds);
  const premiumEnabledIds = usePremiumStore((s) => s.enabledIds);

  // Each fresh fetch's premiumIssues is a new array (2D/2E: filtered off the
  // response), so a dismissal shouldn't stick past a refresh that re-reports
  // trouble. Adjusted during render (React's documented pattern for
  // resetting state when a prop/value changes) rather than in an effect —
  // avoids a synchronous setState-in-effect render cascade.
  const [prevPremiumIssues, setPrevPremiumIssues] = useState(premiumIssues);
  const [issuesDismissed, setIssuesDismissed] = useState(false);
  if (premiumIssues !== prevPremiumIssues) {
    setPrevPremiumIssues(premiumIssues);
    setIssuesDismissed(false);
  }

  const categories = useMemo(() => {
    const idSet = new Set(selectedSourceIds);
    const active = [...sourcesData.sources, ...customSources].filter((s) => idSet.has(s.id));
    return tabs(active);
  }, [selectedSourceIds, customSources, tabs]);

  useEffect(() => {
    refresh();
  }, [selectedCategory]);

  const isSocialChip = mode === 'news' && selectedCategory === 'social';
  const pickerKind = mode === 'blogs' ? 'blog' : isSocialChip ? 'social' : null;
  // A premium-only kind (e.g. the user's only blog source is a paid feed)
  // must not be trapped behind the "follow some sources" empty state
  // (final-review Critical 2).
  const hasEnabledPremiumForKind = !!pickerKind && premiumFeeds.some(
    (f) => f.kind === pickerKind && premiumEnabledIds.includes(f.id)
  );
  const needsPicker = pickerKind && getEffectiveSourcesByKind(pickerKind).length === 0 && !hasEnabledPremiumForKind;

  return (
    <>
      <TopBar fetchedAt={fetchedAt} isLoading={isLoading} onRefresh={refresh} />
      <CategoryTabs categories={categories} selected={selectedCategory} onSelect={setCategory} />
      {premiumIssues.length > 0 && !issuesDismissed && (
        <div
          role="status"
          className="mx-4 my-2 px-3 py-2 rounded-lg flex items-start gap-2 font-ui text-xs"
          style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        >
          <span className="flex-1">
            {premiumIssues.some((i) => i.reason === 'rejected')
              ? 'A premium feed was rejected by its publisher — its token may have expired. Re-add the URL from your subscription page (Settings).'
              : 'A premium feed is temporarily unavailable — its articles will return on a later refresh.'}
          </span>
          <button onClick={() => setIssuesDismissed(true)} aria-label="Dismiss" style={{ color: 'var(--text-tertiary)' }}>✕</button>
        </div>
      )}
      {needsPicker ? (
        <SourcePickerEmptyState
          kind={pickerKind}
          title={pickerKind === 'blog' ? 'Follow some blogs' : 'Follow social accounts'}
          message={
            pickerKind === 'blog'
              ? 'Pick a few blogs and newsletters to build this feed.'
              : 'Follow news outlets on Bluesky and Mastodon.'
          }
        />
      ) : (
        <FeedPage store={store} linkOut={isSocialChip} />
      )}
    </>
  );
}
