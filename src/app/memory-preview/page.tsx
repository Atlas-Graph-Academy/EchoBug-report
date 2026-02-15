'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import MemoryPreviewCanvas from '@/components/MemoryPreviewCanvas';

const MEMORY_PASSWORD = '888';
const MEMORY_UNLOCK_KEY = 'memory_preview_unlocked';

export default function MemoryPreviewPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(MEMORY_UNLOCK_KEY) === '1';
  });

  const handleUnlock = useCallback(() => {
    if (password.trim() !== MEMORY_PASSWORD) {
      setError('Wrong password');
      return;
    }

    sessionStorage.setItem(MEMORY_UNLOCK_KEY, '1');
    setError('');
    setIsUnlocked(true);
  }, [password]);

  if (!isUnlocked) {
    return (
      <div className="memory-gate-screen">
        <div className="memory-gate-card">
          <h1>Memory Preview</h1>
          <p>Enter password to access memory canvas.</p>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleUnlock();
            }}
            placeholder="Password"
            autoFocus
          />
          {error && <span className="memory-modal-error">{error}</span>}
          <div className="memory-gate-actions">
            <button className="memory-cancel-btn" onClick={() => router.push('/')}>
              Back
            </button>
            <button className="memory-submit-btn" onClick={handleUnlock}>
              Open Canvas
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="memory-page">
      <div className="memory-page-header">
        <button className="memory-cancel-btn" onClick={() => router.push('/')}>
          Back
        </button>
        <h1>Memory Preview</h1>
      </div>
      <MemoryPreviewCanvas />
    </div>
  );
}
