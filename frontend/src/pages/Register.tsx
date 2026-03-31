import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getLoginUrl, register as apiRegister, getSetupStatus } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

export default function Register() {
  const [authProvider, setAuthProvider] = useState<'local' | 'enigma' | null>(null);
  const [platformUrl, setPlatformUrl] = useState('');
  const { refresh } = useAuth();

  // Local registration form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getSetupStatus().then(s => setAuthProvider(s.authProvider)).catch(() => setAuthProvider('local'));
  }, []);

  const handleOAuthRegister = async () => {
    try {
      const data = await getLoginUrl();
      setPlatformUrl(data.platformUrl);
      window.open(`${data.platformUrl}/auth/register`, '_blank');
    } catch {}
  };

  const handleLocalRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await apiRegister(email, password, name);
      await refresh();
    } catch (err: any) {
      setError(err.message || 'Registration failed');
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
          <h1 className="text-xl font-semibold mb-1 text-center">Create Account</h1>

          {authProvider === 'enigma' ? (
            <>
              <p className="text-nebula-muted text-sm mb-6 text-center">
                Nebula accounts are managed by the Enigma Platform
              </p>
              <button
                onClick={handleOAuthRegister}
                className="w-full p-3 bg-nebula-accent text-nebula-bg rounded-xl font-semibold text-sm hover:brightness-110 transition-all shadow-glow"
              >
                Create account on Enigma
              </button>
            </>
          ) : (
            <>
              <p className="text-nebula-muted text-sm mb-6 text-center">
                Create a new Nebula account
              </p>

              {error && <p role="alert" className="text-nebula-red text-sm mb-4 text-center">{error}</p>}

              <form onSubmit={handleLocalRegister} className="space-y-3">
                <input
                  type="text"
                  placeholder="Name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  autoFocus
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <input
                  type="password"
                  placeholder="Password (min 8 characters)"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full p-3 bg-nebula-accent text-nebula-bg rounded-xl font-semibold text-sm hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
                >
                  {loading ? 'Creating account...' : 'Create Account'}
                </button>
              </form>
            </>
          )}

          <p className="text-nebula-muted text-sm mt-4 text-center">
            Already have an account?{' '}
            <Link to="/login" className="text-nebula-accent hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
