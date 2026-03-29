import { Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
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
import useFeedStore from './stores/feedStore';
import useSettingsStore from './stores/settingsStore';

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

  useEffect(() => {
    initFromStorage();
  }, []);

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
