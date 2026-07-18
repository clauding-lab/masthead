import { useEffect, useMemo } from 'react';
import TopBar from '../components/TopBar';
import CategoryTabs from '../components/CategoryTabs';
import FeedPage from './FeedPage';
import SourcePickerEmptyState from '../components/SourcePickerEmptyState';
import { useNewsFeedStore, useBlogsFeedStore } from '../stores/feedStore';
import useSettingsStore from '../stores/settingsStore';
import { newsTabCategories, blogsTabCategories } from '../lib/feedCategories';
import sourcesData from '../../lib/sources.json';

const MODES = {
  news: { store: useNewsFeedStore, tabs: newsTabCategories },
  blogs: { store: useBlogsFeedStore, tabs: blogsTabCategories },
};

export default function FeedLayout({ mode }) {
  const { store, tabs } = MODES[mode];
  const { fetchedAt, isLoading, selectedCategory, setCategory, refresh } = store();
  const selectedSourceIds = useSettingsStore((s) => s.selectedSourceIds);
  const customSources = useSettingsStore((s) => s.customSources);
  const getEffectiveSourcesByKind = useSettingsStore((s) => s.getEffectiveSourcesByKind);

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
  const needsPicker = pickerKind && getEffectiveSourcesByKind(pickerKind).length === 0;

  return (
    <>
      <TopBar fetchedAt={fetchedAt} isLoading={isLoading} onRefresh={refresh} />
      <CategoryTabs categories={categories} selected={selectedCategory} onSelect={setCategory} />
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
