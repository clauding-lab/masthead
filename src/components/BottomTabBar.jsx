import { NavLink } from 'react-router-dom';
import Icon from './ui/Icon';
import useInboxStore from '../stores/inboxStore';

const tabs = [
  { to: '/', label: 'Feed', icon: 'feed' },
  { to: '/blogs', label: 'Blogs', icon: 'blogs' },
  { to: '/favorites', label: 'Saved', icon: 'bookmark' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
];

export default function BottomTabBar() {
  // Reactive selector, not a .getState() snapshot (FeedLayout.jsx line 23's
  // comment applies here too): the badge must update the instant fetchList
  // or bootstrap changes unreadCount, without waiting for an unrelated
  // re-render to happen to pick up a fresh snapshot.
  const unreadCount = useInboxStore((s) => s.unreadCount);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 safe-bottom"
      style={{ backgroundColor: 'var(--bg-surface)', borderTop: '1px solid var(--border)' }}
    >
      <div className="flex items-center justify-around pt-1.5 pb-1 max-w-lg mx-auto">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className="flex flex-col items-center gap-0 py-0.5 px-2"
          >
            {({ isActive }) => (
              <>
                <span className="relative">
                  <Icon
                    name={tab.icon}
                    size={22}
                    style={{ color: isActive ? 'var(--accent)' : 'var(--text-tertiary)' }}
                  />
                  {tab.to === '/inbox' && unreadCount > 0 && (
                    <span
                      role="img"
                      aria-label="Unread messages"
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                      style={{ backgroundColor: 'var(--accent)', border: '1.5px solid var(--bg-surface)' }}
                    />
                  )}
                </span>
                <span
                  className="font-ui text-[10px] font-medium"
                  style={{ color: isActive ? 'var(--accent)' : 'var(--text-tertiary)' }}
                >
                  {tab.label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
