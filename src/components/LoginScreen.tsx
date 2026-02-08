'use client';

interface LoginScreenProps {
  onLogin: () => void;
  error: string | null;
  isLoading: boolean;
}

export default function LoginScreen({ onLogin, error, isLoading }: LoginScreenProps) {
  return (
    <div className="login-screen">
      <div className="login-logo">
        <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="1.8">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </div>
      <h1>EchoBug</h1>
      <p>Photo reporter for your team. Log in with your Linear account to get started.</p>
      <button className="login-btn" onClick={onLogin} disabled={isLoading}>
        {isLoading ? (
          <>
            <div className="login-spinner" /> Logging in...
          </>
        ) : (
          <>
            <svg width="20" height="20" viewBox="0 0 100 100" fill="currentColor">
              <path d="M50 0C22.4 0 0 22.4 0 50s22.4 50 50 50 50-22.4 50-50S77.6 0 50 0zm21.3 71.4H28.7V28.6h42.6v42.8z" />
            </svg>
            Log in with Linear
          </>
        )}
      </button>
      {error && <div className="login-error">{error}</div>}
    </div>
  );
}
