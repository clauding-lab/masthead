import { Routes, Route } from 'react-router-dom';
import { useEffect, useState } from 'react';
import TopBar from './components/TopBar';
import BottomTabBar from './components/BottomTabBar';
import CategoryTabs from './components/CategoryTabs';
import PageTransition from './components/PageTransition';
import ErrorBoundary from './components/ErrorBoundary';
import FeedPage from './pages/FeedPage';
import ReaderPage from './pages/ReaderPage';
import FavoritesPage from './pages/FavoritesPage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import OnboardingPage from './pages/OnboardingPage';
import useFeedStore from './stores/feedStore';
import useSettingsStore from './stores/settingsStore';
import useAuthStore from './stores/authStore';

function FeedLayout() {
  const { fetchedAt, isLoading, selectedCategory, setCategory, refresh } = useFeedStore();

  const handleCategoryChange = (cat) => {
    setCategory(cat);
  };

  useEffect(() => {
    refresh();
  }, [selectedCategory]);

  return (
    <>
      <TopBar fetchedAt={fetchedAt} isLoading={isLoading} onRefresh={refresh} />
      <CategoryTabs selected={selectedCategory} onSelect={handleCategoryChange} />
      <FeedPage />
    </>
  );
}

export default function App() {
  const initFromStorage = useSettingsStore((s) => s.initFromStorage);
  const initAuth = useAuthStore((s) => s.initAuth);
  const isAuthInitialized = useAuthStore((s) => s.isInitialized);
  const user = useAuthStore((s) => s.user);
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('masthead-onboarded') === 'true');

  // Expose setter so OnboardingPage can trigger re-render without full reload
  window.__mastheadCompleteOnboarding = () => setOnboarded(true);

  useEffect(() => {
    initFromStorage();
    initAuth();
  }, []);

  // Show nothing until auth state is known
  if (!isAuthInitialized) {
    return (
      <div className="flex items-center justify-center min-h-screen" style={{ backgroundColor: 'var(--bg-primary)' }}>
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold" style={{ color: 'var(--accent)' }}>MASTHEAD</h1>
        </div>
      </div>
    );
  }

  // Show onboarding for first-time visitors who aren't signed in
  if (!onboarded && !user) {
    return <OnboardingPage />;
  }

  return (
    <div className="flex flex-col min-h-screen pb-16">
      <main className="flex-1">
        <PageTransition>
          <Routes>
            <Route path="/" element={<FeedLayout />} />
            <Route path="/article/:id" element={<ErrorBoundary><ReaderPage /></ErrorBoundary>} />
            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </PageTransition>
      </main>
      <BottomTabBar />
    </div>
  );
}
