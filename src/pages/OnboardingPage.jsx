import { useState } from 'react';
import sourcesData from '../../lib/sources.json';
import SourceSelectGrid from '../components/SourceSelectGrid';
import useAuthStore from '../stores/authStore';
import { supabase } from '../lib/supabase';

const ALL_SOURCE_IDS = new Set(sourcesData.sources.map((s) => s.id));

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [selectedIds, setSelectedIds] = useState(new Set(ALL_SOURCE_IDS));
  const [isSigningIn, setIsSigningIn] = useState(false);
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle);

  const handleToggle = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCookieAccept = () => {
    localStorage.setItem('masthead-cookieConsent', 'true');
    setStep(3);
  };

  const handleCookieDecline = () => {
    localStorage.setItem('masthead-cookieConsent', 'false');
    setStep(3);
  };

  const finishOnboarding = async (withAuth = false) => {
    const ids = [...selectedIds];
    localStorage.setItem('masthead-selectedSources', JSON.stringify(ids));
    localStorage.setItem('masthead-onboarded', 'true');

    if (withAuth && supabase) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          // Bulk insert selected default sources
          const rows = sourcesData.sources
            .filter((s) => selectedIds.has(s.id))
            .map((s) => ({
              user_id: user.id,
              source_id: s.id,
              name: s.name,
              short_name: s.shortName,
              url: s.url,
              feed_url: s.feedUrl,
              category: s.category,
              color: s.color,
              is_default: true,
              is_enabled: true,
            }));
          await supabase.from('user_sources').upsert(rows, { onConflict: 'user_id,source_id' });
          await supabase.from('profiles').update({ onboarding_completed: true }).eq('id', user.id);
        }
      } catch (err) {
        console.error('Failed to sync onboarding sources:', err);
      }
    }

    // Trigger App re-render to exit onboarding
    if (window.__mastheadCompleteOnboarding) {
      window.__mastheadCompleteOnboarding();
    } else {
      window.location.reload();
    }
  };

  const [signInError, setSignInError] = useState(null);

  const handleGoogleSignIn = async () => {
    if (!supabase) {
      setSignInError('Sign-in is not available yet. Tap "Skip for now" to continue.');
      return;
    }
    setIsSigningIn(true);
    setSignInError(null);
    const { error } = await signInWithGoogle();
    if (error) {
      setIsSigningIn(false);
      setSignInError(error.message || 'Sign-in failed. Try again or skip for now.');
      console.error('Sign-in failed:', error);
    }
  };

  const handleSkipSignIn = () => {
    finishOnboarding(false);
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="text-center pt-12 pb-6 px-6">
        <h1 className="font-display text-3xl font-bold mb-1" style={{ color: 'var(--accent)' }}>
          MASTHEAD
        </h1>
        <p className="font-ui text-sm" style={{ color: 'var(--text-secondary)' }}>
          Your personal news reader
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex justify-center gap-2 mb-6">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className="h-1.5 rounded-full transition-all"
            style={{
              width: s === step ? 24 : 8,
              backgroundColor: s === step ? 'var(--accent)' : s < step ? 'var(--accent)' : 'var(--border)',
            }}
          />
        ))}
      </div>

      <div className="flex-1 px-5 pb-8">
        {/* Step 1: Source Selection */}
        {step === 1 && (
          <div>
            <h2 className="font-display text-xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
              Choose your sources
            </h2>
            <p className="font-ui text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
              Select at least one news source to get started. You can change this later in Settings.
            </p>
            <SourceSelectGrid
              sources={sourcesData.sources}
              selectedIds={selectedIds}
              onToggle={handleToggle}
              minRequired={1}
            />
            <div className="sticky bottom-0 pt-4 pb-2" style={{ backgroundColor: 'var(--bg-primary)' }}>
              <button
                onClick={() => setStep(2)}
                disabled={selectedIds.size === 0}
                className="w-full py-3 rounded-xl font-ui text-base font-semibold transition-opacity"
                style={{
                  backgroundColor: 'var(--accent)',
                  color: '#fff',
                  opacity: selectedIds.size === 0 ? 0.5 : 1,
                }}
              >
                Continue ({selectedIds.size} selected)
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Cookie Consent */}
        {step === 2 && (
          <div className="flex flex-col items-center text-center max-w-sm mx-auto pt-8">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6"
              style={{ backgroundColor: 'var(--bg-surface)' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <h2 className="font-display text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Stay signed in
            </h2>
            <p className="font-ui text-sm mb-8 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              We use cookies to keep you signed in between visits. Your data stays private and is never shared with advertisers.
            </p>
            <button
              onClick={handleCookieAccept}
              className="w-full py-3 rounded-xl font-ui text-base font-semibold mb-3"
              style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
            >
              Accept Cookies
            </button>
            <button
              onClick={handleCookieDecline}
              className="w-full py-3 rounded-xl font-ui text-sm"
              style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-surface)' }}
            >
              Continue without cookies
            </button>
          </div>
        )}

        {/* Step 3: Google Sign-In */}
        {step === 3 && (
          <div className="flex flex-col items-center text-center max-w-sm mx-auto pt-8">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6"
              style={{ backgroundColor: 'var(--bg-surface)' }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
            <h2 className="font-display text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Sync across devices
            </h2>
            <p className="font-ui text-sm mb-8 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Sign in with Google to save your sources, favorites, and reading history across all your devices.
            </p>
            <button
              onClick={handleGoogleSignIn}
              disabled={isSigningIn}
              className="w-full py-3 rounded-xl font-ui text-base font-semibold mb-3 flex items-center justify-center gap-3"
              style={{ backgroundColor: '#fff', color: '#333', border: '1px solid var(--border)' }}
            >
              {isSigningIn ? (
                <span>Redirecting...</span>
              ) : (
                <>
                  {/* Google G logo */}
                  <svg width="20" height="20" viewBox="0 0 48 48">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                  </svg>
                  Sign in with Google
                </>
              )}
            </button>
            {signInError && (
              <p className="font-ui text-xs text-center py-2" style={{ color: 'var(--accent)' }}>
                {signInError}
              </p>
            )}
            <button
              onClick={handleSkipSignIn}
              className="w-full py-3 font-ui text-sm"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
