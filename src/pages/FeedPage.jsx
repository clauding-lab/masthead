import { useEffect } from 'react';
import useFeedStore from '../stores/feedStore';
import HeadlineCard from '../components/HeadlineCard';
import SkeletonCard from '../components/SkeletonCard';
import EmptyState from '../components/EmptyState';
import PullToRefresh from '../components/PullToRefresh';

export default function FeedPage() {
  const { headlines, isLoading, error, fetchFeeds, refresh } = useFeedStore();

  useEffect(() => {
    if (headlines.length === 0) {
      fetchFeeds();
    }
  }, []);

  if (error && headlines.length === 0) {
    return (
      <EmptyState
        title="Something went wrong"
        message={error}
        action="Try Again"
        onAction={fetchFeeds}
      />
    );
  }

  if (isLoading && headlines.length === 0) {
    return (
      <div>
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (!isLoading && headlines.length === 0) {
    return (
      <EmptyState
        title="No headlines yet"
        message="Tap refresh to load the latest news from your sources."
        action="Load Headlines"
        onAction={fetchFeeds}
      />
    );
  }

  return (
    <PullToRefresh onRefresh={refresh}>
      <div className="pb-2">
        {headlines.map((headline) => (
          <HeadlineCard key={headline.id} headline={headline} />
        ))}
      </div>
    </PullToRefresh>
  );
}
