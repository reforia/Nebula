import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { getSetupStatus } from './api/client';
import Login from './pages/Login';
import Register from './pages/Register';
import AppShell from './pages/AppShell';
import Setup from './pages/Setup';

export default function App() {
  const { user, loading, logout } = useAuth();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [setupIncomplete, setSetupIncomplete] = useState(false);

  useEffect(() => {
    getSetupStatus()
      .then(data => {
        setNeedsSetup(data.needsSetup);
        setSetupIncomplete(data.setupIncomplete ?? false);
      })
      .catch(() => setNeedsSetup(false));
  }, []);

  if (loading || needsSetup === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-nebula-bg">
        <div className="text-nebula-muted text-lg">Loading...</div>
      </div>
    );
  }

  // First boot — no users at all, show setup wizard starting at auth step
  if (needsSetup) {
    return <Setup initialStep="auth" onComplete={() => { setNeedsSetup(false); setSetupIncomplete(false); }} />;
  }

  // User exists but setup not finished (came back from OAuth, needs runtimes + template)
  if (setupIncomplete && user) {
    return <Setup initialStep="runtimes" onComplete={() => setSetupIncomplete(false)} />;
  }

  const isAuthenticated = !!user;

  return (
    <Routes>
      <Route path="/login" element={
        !isAuthenticated ? <Login /> : <Navigate to="/" />
      } />
      <Route path="/register" element={
        !isAuthenticated ? <Register /> : <Navigate to="/" />
      } />
      <Route path="/*" element={
        isAuthenticated
          ? <AppShell onLogout={logout} />
          : <Navigate to="/login" />
      } />
    </Routes>
  );
}
