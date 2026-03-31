import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getAuthMe, refreshToken as apiRefreshToken, logout as apiLogout, type User, type Org, type License } from '../api/client';

interface AuthContextType {
  user: User | null;
  orgs: Org[];
  currentOrg: Org | null;
  platformUrl: string | null;
  license: License | null;
  loading: boolean;
  switchOrg: (orgId: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setAuth: (user: User, orgs: Org[], currentOrgId: string) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [platformUrl, setPlatformUrl] = useState<string | null>(null);
  const [license, setLicense] = useState<License | null>(null);
  const [loading, setLoading] = useState(true);

  const currentOrg = orgs.find(o => o.id === currentOrgId) || null;

  const refresh = useCallback(async () => {
    try {
      const data = await getAuthMe();
      if (data.user) {
        setUser(data.user);
        setOrgs(data.orgs);
        setCurrentOrgId(data.currentOrgId);
        if (data.platformUrl) setPlatformUrl(data.platformUrl);
        setLicense(data.license || null);
      } else {
        setUser(null);
        setOrgs([]);
        setCurrentOrgId(null);
      }
    } catch {
      setUser(null);
      setOrgs([]);
      setCurrentOrgId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const setAuth = useCallback((user: User, orgs: Org[], currentOrgId: string) => {
    setUser(user);
    setOrgs(orgs);
    setCurrentOrgId(currentOrgId);
    setLoading(false);
  }, []);

  const switchOrg = useCallback(async (orgId: string) => {
    const data = await apiRefreshToken(orgId);
    setUser(data.user);
    setOrgs(data.orgs);
    setCurrentOrgId(data.currentOrgId);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setOrgs([]);
    setCurrentOrgId(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, orgs, currentOrg, platformUrl, license, loading, switchOrg, logout, refresh, setAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
