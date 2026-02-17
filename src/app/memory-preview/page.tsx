'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import MemoryPreviewCanvas from '@/components/MemoryPreviewCanvas';

export default function MemoryPreviewPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [datasetHint, setDatasetHint] = useState('Kobe dataset');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const init = async () => {
      try {
        const resp = await fetch('/api/memory-auth/status', { credentials: 'include' });
        const json = (await resp.json().catch(() => ({}))) as { authenticated?: boolean };
        setIsUnlocked(!!json.authenticated);
      } finally {
        setCheckingSession(false);
      }
    };
    init();
  }, []);

  const handleUnlock = useCallback(async () => {
    if (!password.trim()) {
      setError('Enter password');
      return;
    }
    setBusy(true);
    const resp = await fetch('/api/memory-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password: password.trim() }),
    });
    setBusy(false);
    if (!resp.ok) {
      setError('Wrong password');
      return;
    }
    setError('');
    setIsUnlocked(true);
    setReloadKey((v) => v + 1);
  }, [password]);

  const handleLogout = useCallback(async () => {
    await fetch('/api/memory-auth/logout', { method: 'POST', credentials: 'include' });
    setIsUnlocked(false);
    setPassword('');
  }, []);

  const handleUseKobe = useCallback(async () => {
    setBusy(true);
    const resp = await fetch('/api/memory/use-kobe', { method: 'POST', credentials: 'include' });
    setBusy(false);
    if (!resp.ok) {
      setError('Failed to switch to Kobe dataset');
      return;
    }
    setDatasetHint('Kobe dataset');
    setReloadKey((v) => v + 1);
  }, []);

  const handleFileSelected = useCallback(async (file: File | null) => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('name', file.name.replace(/\.csv$/i, '').trim() || 'Imported dataset');
    setBusy(true);
    const resp = await fetch('/api/memory/import-csv', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const json = (await resp.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!resp.ok) {
      setError(json.error || 'CSV import failed');
      return;
    }
    setError('');
    setDatasetHint(file.name);
    setReloadKey((v) => v + 1);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  if (checkingSession) {
    return (
      <div className="memory-gate-screen">
        <div className="memory-gate-card">
          <h1>Memory Preview</h1>
          <p>Checking access...</p>
        </div>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="memory-gate-screen">
        <div className="memory-gate-card">
          <h1>Memory Preview</h1>
          <p>Enter password to access Kobe memory data and import your own CSV.</p>
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
            <button className="memory-submit-btn" onClick={handleUnlock} disabled={busy}>
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
        <div className="memory-page-title">
          <h1>Memory Preview</h1>
          <p>Dataset: {datasetHint}</p>
        </div>
        <div className="memory-page-actions">
          <button className="memory-cancel-btn" onClick={handleUseKobe} disabled={busy}>
            Use Kobe CSV
          </button>
          <label className="memory-submit-btn" style={{ display: 'inline-flex', alignItems: 'center' }}>
            Import CSV
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
              style={{ display: 'none' }}
            />
          </label>
          <button className="memory-cancel-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>
      {error && <div className="memory-modal-error" style={{ padding: '8px 16px' }}>{error}</div>}
      <MemoryPreviewCanvas reloadKey={reloadKey} />
    </div>
  );
}
