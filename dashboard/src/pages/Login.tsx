import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import './Login.css';

interface LoginProps {
  onLogin: (apiKey: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) {
      setError('API key is required');
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      // Validate API key with backend
      const response = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
      });

      if (response.ok) {
        onLogin(apiKey);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.message || 'Invalid API key');
      }
    } catch {
      setError('Unable to connect to server. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src="/openwa_logo.webp" alt="OpenWA" className="logo-icon" />
          <span className="version-info">
            v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleDateString()}
          </span>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <label htmlFor="apiKey">API Key</label>
            <div className="input-wrapper">
              <input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Enter your API key"
                className={error ? 'error' : ''}
              />
              <button type="button" className="toggle-visibility" onClick={() => setShowKey(!showKey)}>
                {showKey ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && <span className="error-message">{error}</span>}
          </div>

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? 'Connecting...' : 'Connect'}
          </button>
        </form>

        <p className="login-help">
          Need help?{' '}
          <a
            href="https://github.com/ziyadfazyan/OpenWA/blob/main/docs/01-project-overview.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            View Documentation
          </a>
        </p>
      </div>
    </div>
  );
}
