'use client';

import type { LinearUser } from '@/lib/types';

interface AppShellProps {
  user: LinearUser;
  photoCount: number;
  onLogout: () => void;
  children: React.ReactNode;
}

export default function AppShell({ user, photoCount, onLogout, children }: AppShellProps) {
  const name = user.displayName || user.name || user.email || 'User';

  return (
    <>
      <header>
        <div className="header-left">
          <h1>EchoBug</h1>
        </div>
        <div className="header-right">
          <div className="user-info">
            <div className="user-avatar">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt={name} />
              ) : (
                name.charAt(0).toUpperCase()
              )}
            </div>
            <span className="user-name">{name}</span>
          </div>
          <span className="photo-count">
            {photoCount} photo{photoCount !== 1 ? 's' : ''}
          </span>
          <button className="logout-btn" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}
