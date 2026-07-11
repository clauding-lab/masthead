import { NavLink } from 'react-router-dom';
import Icon from './ui/Icon';

const tabs = [
  { to: '/', label: 'Feed', icon: 'feed' },
  { to: '/favorites', label: 'Favorites', icon: 'bookmark' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export default function BottomTabBar() {
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
            className="flex flex-col items-center gap-0 py-0.5 px-3"
          >
            {({ isActive }) => (
              <>
                <Icon
                  name={tab.icon}
                  size={22}
                  style={{ color: isActive ? 'var(--accent)' : 'var(--text-tertiary)' }}
                />
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
