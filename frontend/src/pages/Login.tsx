import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLoginUrl, login as apiLogin, getSetupStatus } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [authProvider, setAuthProvider] = useState<'local' | 'enigma' | null>(null);
  const [platformUrl, setPlatformUrl] = useState('');
  const [searchParams] = useSearchParams();
  const { refresh } = useAuth();

  // Local auth form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const resolveAuthError = (code: string): string => {
    switch (code) {
      case 'state_mismatch': return t('auth.errors.state_mismatch');
      case 'exchange_failed': return t('auth.errors.exchange_failed');
      case 'authentication_failed': return t('auth.errors.authentication_failed');
      case 'invalid_userinfo': return t('auth.errors.invalid_userinfo');
      case 'access_denied': return t('auth.errors.access_denied');
      default: return t('auth.errors.generic', { code });
    }
  };

  useEffect(() => {
    const errorCode = searchParams.get('error');
    if (errorCode) {
      setError(resolveAuthError(errorCode));
    }
    getSetupStatus().then(s => setAuthProvider(s.authProvider)).catch(() => setAuthProvider('local'));
  }, [searchParams, t]);

  const handleOAuthLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getLoginUrl();
      setPlatformUrl(data.platformUrl);
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || t('auth.initiateFailed'));
      setLoading(false);
    }
  };

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await apiLogin(email, password);
      await refresh();
    } catch (err: any) {
      setError(err.message || t('auth.loginFailed'));
      setLoading(false);
    }
  };

  if (!authProvider) return null;

  return (
    <div className="flex items-center justify-center min-h-[100dvh] bg-nebula-bg px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-nebula-accent to-nebula-gold-dim flex items-center justify-center shadow-glow-lg">
            <span className="text-2xl font-bold text-nebula-bg">N</span>
          </div>
        </div>
        <div className="p-6 sm:p-8 bg-nebula-surface rounded-2xl border border-nebula-border">
          <h1 className="text-xl font-semibold mb-1 text-center">{t('auth.signInTitle')}</h1>

          {authProvider === 'enigma' ? (
            <>
              <p className="text-nebula-muted text-sm mb-6 text-center">
                {t('auth.useEnigmaAccount')}
              </p>

              {error && <p role="alert" className="text-nebula-red text-sm mb-4 text-center">{error}</p>}

              <button
                onClick={handleOAuthLogin}
                disabled={loading}
                className="w-full p-3 bg-nebula-accent text-nebula-bg rounded-xl font-semibold text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
              >
                {loading ? t('auth.redirecting') : t('auth.signInWithEnigma')}
              </button>

              <p className="text-nebula-muted text-sm mt-4 text-center">
                {t('auth.noAccount')}{' '}
                <a
                  href={platformUrl ? `${platformUrl}/auth/register` : '#'}
                  onClick={async (e) => {
                    if (!platformUrl) {
                      e.preventDefault();
                      try {
                        const data = await getLoginUrl();
                        window.open(`${data.platformUrl}/auth/register`, '_blank');
                      } catch {}
                    }
                  }}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-nebula-accent hover:underline"
                >
                  {t('auth.createAccount')}
                </a>
              </p>
            </>
          ) : (
            <>
              <p className="text-nebula-muted text-sm mb-6 text-center">
                {t('auth.enterCredentials')}
              </p>

              {error && <p role="alert" className="text-nebula-red text-sm mb-4 text-center">{error}</p>}

              <form onSubmit={handleLocalLogin} className="space-y-3">
                <input
                  type="email"
                  placeholder={t('auth.email')}
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <input
                  type="password"
                  placeholder={t('auth.password')}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full p-3 bg-nebula-accent text-nebula-bg rounded-xl font-semibold text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
                >
                  {loading ? t('auth.signingIn') : t('auth.signIn')}
                </button>
              </form>

              <p className="text-nebula-muted text-sm mt-4 text-center">
                {t('auth.noAccount')}{' '}
                <Link to="/register" className="text-nebula-accent hover:underline">
                  {t('auth.createAccount')}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
