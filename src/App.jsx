import { Routes, Route } from 'react-router-dom';
import { useEffect, useState } from 'react';
import BottomTabBar from './components/BottomTabBar';
import PageTransition from './components/PageTransition';
import ErrorBoundary from './components/ErrorBoundary';
import FeedLayout from './pages/FeedLayout';
import ReaderPage from './pages/ReaderPage';
import SavedPage from './pages/SavedPage';
import SavePage from './pages/SavePage';
import HistoryPage from './pages/HistoryPage';
import SettingsPage from './pages/SettingsPage';
import InboxPage from './pages/InboxPage';
import OnboardingPage from './pages/OnboardingPage';
import useSettingsStore from './stores/settingsStore';
import useAuthStore from './stores/authStore';
import { processPendingSaves } from './lib/library';

export default function App() {
  const initFromStorage = useSettingsStore((s) => s.initFromStorage);
  const initAuth = useAuthStore((s) => s.initAuth);
  const isAuthInitialized = useAuthStore((s) => s.isInitialized);
  const user = useAuthStore((s) => s.user);
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('masthead-onboarded') === 'true');

  useEffect(() => {
    // Expose setter so OnboardingPage can trigger re-render without full reload
    window.__mastheadCompleteOnboarding = () => setOnboarded(true);
    initFromStorage();
    initAuth();
  }, []);

  // Drain share-target URLs stashed while the app was gated (spec §5).
  useEffect(() => {
    if (isAuthInitialized && (onboarded || user)) {
      processPendingSaves().catch(() => {});
    }
  }, [isAuthInitialized, onboarded, user]);

  const isShareTarget = window.location.pathname === '/save';

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

  // Show onboarding for first-time visitors who aren't signed in — but never
  // swallow a share-target navigation: /save stashes first (spec §5).
  if (!onboarded && !user && !isShareTarget) {
    return <OnboardingPage />;
  }

  return (
    <div className="flex flex-col min-h-screen pb-16">
      <main className="flex-1">
        <PageTransition>
          <Routes>
            <Route path="/" element={<FeedLayout mode="news" />} />
            <Route path="/blogs" element={<FeedLayout mode="blogs" />} />
            <Route path="/article/:id" element={<ErrorBoundary><ReaderPage /></ErrorBoundary>} />
            <Route path="/favorites" element={<SavedPage />} />
            <Route path="/save" element={<SavePage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/inbox" element={<InboxPage />} />
          </Routes>
        </PageTransition>
      </main>
      <BottomTabBar />
    </div>
  );
}
