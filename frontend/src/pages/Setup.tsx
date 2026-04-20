import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { getLoginUrl, completeSetup, getRuntimes, detectRuntimes, createAdmin, getSetupStatus, RuntimeInfo, listTemplates, TemplateSummary } from '../api/client';

type Step = 'auth' | 'runtimes' | 'template' | 'complete';

interface Props {
  initialStep?: Step;
  onComplete: () => void;
}

export default function Setup({ initialStep = 'auth', onComplete }: Props) {
  const [step, setStep] = useState<Step>(initialStep);
  const [error, setError] = useState('');
  const { user, refresh } = useAuth();
  const { reportError } = useToast();
  const [authProvider, setAuthProvider] = useState<'local' | 'enigma'>('local');

  // Step 1 (local): Admin account form
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminName, setAdminName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [creating, setCreating] = useState(false);

  // Step 2: Runtimes
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [defaultRuntime, setDefaultRuntime] = useState('');

  // Step 3: Template
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('starter');
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Step 4: Completing
  const [completing, setCompleting] = useState(false);

  const steps: { key: Step; label: string }[] = [
    { key: 'auth', label: authProvider === 'enigma' ? 'Sign In' : 'Admin Account' },
    { key: 'runtimes', label: 'Runtimes' },
    { key: 'template', label: 'Template' },
    { key: 'complete', label: 'Launch' },
  ];
  const currentStepIndex = steps.findIndex(s => s.key === step);
  const availableRuntimes = runtimes.filter(r => r.available);

  useEffect(() => {
    getSetupStatus().then(s => setAuthProvider(s.authProvider)).catch(e => reportError(e, 'Failed to check setup status'));
  }, [reportError]);

  // Auto-detect runtimes when entering step 2
  useEffect(() => {
    if (step === 'runtimes') {
      setDetecting(true);
      getRuntimes()
        .then(r => {
          setRuntimes(r.runtimes);
          setDefaultRuntime(r.default);
        })
        .catch(e => reportError(e, 'Failed to detect runtimes'))
        .finally(() => setDetecting(false));
    }
  }, [step, reportError]);

  // Load templates when entering step 3
  useEffect(() => {
    if (step === 'template') {
      setLoadingTemplates(true);
      listTemplates()
        .then(t => setTemplates(t))
        .catch(e => reportError(e, 'Failed to load templates'))
        .finally(() => setLoadingTemplates(false));
    }
  }, [step, reportError]);

  // --- Sign in with Platform (enigma) ---
  const [loginLoading, setLoginLoading] = useState(false);
  const handlePlatformLogin = async () => {
    setLoginLoading(true);
    setError('');
    try {
      const data = await getLoginUrl();
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message);
      setLoginLoading(false);
    }
  };

  // --- Create local admin ---
  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      await createAdmin(adminEmail, adminPassword, adminName, orgName || undefined);
      await refresh();
      setStep('runtimes');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  // --- Complete setup ---
  const handleComplete = async () => {
    setCompleting(true);
    setError('');
    try {
      const settings: Record<string, string> = {};
      if (defaultRuntime) settings.default_runtime = defaultRuntime;
      await completeSetup({ settings, templateId: selectedTemplate || undefined });
      onComplete();
    } catch (err: any) {
      setError(err.message);
      setCompleting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[100dvh] bg-nebula-bg px-4 py-8">
      <div className="w-full max-w-lg">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-nebula-accent to-nebula-gold-dim flex items-center justify-center shadow-glow-lg">
            <span className="text-2xl font-bold text-nebula-bg">N</span>
          </div>
        </div>

        <h1 className="text-xl font-semibold text-center mb-1">Set up Nebula</h1>
        <p className="text-nebula-muted text-sm text-center mb-6">Configure your instance to get started</p>

        {/* Stepper */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors ${
                i < currentStepIndex ? 'bg-nebula-green text-nebula-bg'
                  : step === s.key ? 'bg-nebula-accent text-nebula-bg'
                    : 'bg-nebula-surface-2 text-nebula-muted'
              }`}>
                {i < currentStepIndex ? '\u2713' : i + 1}
              </div>
              <span className={`text-[12px] ${step === s.key ? 'text-nebula-text font-medium' : 'text-nebula-muted'}`}>
                {s.label}
              </span>
              {i < steps.length - 1 && <div className="w-8 h-px bg-nebula-border" />}
            </div>
          ))}
        </div>

        <div className="p-6 sm:p-8 bg-nebula-surface rounded-2xl border border-nebula-border">
          {error && <p role="alert" className="text-nebula-red text-sm mb-4">{error}</p>}

          {/* Step 1: Auth */}
          {step === 'auth' && authProvider === 'enigma' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-medium mb-1">Sign in with Enigma</h2>
                <p className="text-nebula-muted text-xs mb-4">
                  Sign in or create an account on the Enigma Platform.
                  Your license is linked to your account — no key entry needed.
                </p>
              </div>
              <button
                onClick={handlePlatformLogin}
                disabled={loginLoading}
                className="w-full py-3 text-sm bg-nebula-accent text-nebula-bg rounded-xl font-semibold hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
              >
                {loginLoading ? 'Redirecting...' : 'Sign in with Enigma'}
              </button>
            </div>
          )}

          {step === 'auth' && authProvider === 'local' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-medium mb-1">Create Admin Account</h2>
                <p className="text-nebula-muted text-xs mb-4">
                  Set up the first admin account for your Nebula instance.
                </p>
              </div>
              <form onSubmit={handleCreateAdmin} className="space-y-3">
                <input
                  type="text"
                  placeholder="Name"
                  value={adminName}
                  onChange={e => setAdminName(e.target.value)}
                  autoFocus
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <input
                  type="email"
                  placeholder="Email"
                  value={adminEmail}
                  onChange={e => setAdminEmail(e.target.value)}
                  required
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <div>
                  <input
                    type="text"
                    placeholder={`${adminName || 'Your'}'s Organization`}
                    value={orgName}
                    onChange={e => setOrgName(e.target.value)}
                    className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                  />
                  <p className="text-[10px] text-nebula-muted mt-1 ml-1">Organization name (optional)</p>
                </div>
                <input
                  type="password"
                  placeholder="Password (min 8 characters)"
                  value={adminPassword}
                  onChange={e => setAdminPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full p-3 bg-nebula-bg border border-nebula-border rounded-xl text-sm text-nebula-text placeholder:text-nebula-muted focus:outline-none focus:border-nebula-accent/50"
                />
                <button
                  type="submit"
                  disabled={creating}
                  className="w-full py-3 text-sm bg-nebula-accent text-nebula-bg rounded-xl font-semibold hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
                >
                  {creating ? 'Creating...' : 'Create Account'}
                </button>
              </form>
            </div>
          )}

          {/* Step 2: Runtimes */}
          {step === 'runtimes' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-medium mb-1">CLI Runtimes</h2>
                <p className="text-nebula-muted text-xs mb-3">
                  Nebula needs at least one CLI runtime to execute agents. Each CLI manages its own authentication.
                </p>
              </div>

              {detecting ? (
                <div className="flex items-center justify-center py-6">
                  <p className="text-sm text-nebula-muted">Detecting installed CLIs...</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {runtimes.map(rt => (
                    <div
                      key={rt.id}
                      onClick={() => rt.available && setDefaultRuntime(rt.id)}
                      className={`p-3 rounded-xl border transition-colors ${
                        rt.available
                          ? defaultRuntime === rt.id
                            ? 'border-nebula-accent/30 bg-nebula-accent/5 cursor-pointer'
                            : 'border-nebula-border hover:border-nebula-accent/20 cursor-pointer'
                          : 'border-nebula-border/50'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${rt.available ? 'bg-green-400' : 'bg-red-400'}`} />
                        <span className="text-sm font-medium">{rt.name}</span>
                        {rt.available && rt.version && (
                          <span className="text-[10px] text-nebula-muted font-mono">{rt.version}</span>
                        )}
                        {defaultRuntime === rt.id && rt.available && (
                          <span className="text-[10px] bg-nebula-accent/10 text-nebula-accent px-2 py-0.5 rounded ml-auto">default</span>
                        )}
                      </div>

                      {rt.available ? (
                        <div className="mt-1.5 space-y-0.5">
                          <p className="text-[11px] text-nebula-muted font-mono">{rt.binaryPath}</p>
                          <p className="text-[11px]">
                            <span className={rt.auth.ok ? 'text-green-400' : 'text-red-400'}>
                              {rt.auth.ok ? 'Authenticated' : rt.auth.error || 'Auth needed'}
                            </span>
                            {!rt.auth.ok && rt.authGuide.command && (
                              <span className="text-nebula-muted"> — run: <code className="bg-nebula-bg px-1 rounded font-mono select-all">{rt.authGuide.dockerCommand || rt.authGuide.command}</code></span>
                            )}
                          </p>
                        </div>
                      ) : (
                        <div className="mt-2 bg-nebula-bg rounded-lg p-2 space-y-1">
                          <p className="text-[11px] text-nebula-muted">Install:</p>
                          <code className="block text-[11px] text-nebula-text px-1.5 py-0.5 rounded font-mono select-all">{rt.install.command}</code>
                          {rt.authGuide.command && (
                            <>
                              <p className="text-[11px] text-nebula-muted mt-1">Then authenticate:</p>
                              <code className="block text-[11px] text-nebula-text px-1.5 py-0.5 rounded font-mono select-all">{rt.authGuide.dockerCommand || rt.authGuide.command}</code>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  <button
                    onClick={async () => {
                      setDetecting(true);
                      try {
                        await detectRuntimes();
                        const r = await getRuntimes();
                        setRuntimes(r.runtimes);
                        setDefaultRuntime(r.default);
                      } catch {}
                      setDetecting(false);
                    }}
                    className="text-xs text-nebula-muted hover:text-nebula-accent transition-colors"
                  >
                    Re-scan after installing
                  </button>
                </div>
              )}

              <button
                onClick={() => { setError(''); setStep('template'); }}
                disabled={availableRuntimes.length === 0}
                className="w-full py-2.5 text-sm bg-nebula-accent text-nebula-bg rounded-xl font-semibold hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
              >
                {availableRuntimes.length === 0 ? 'Install a runtime to continue' : 'Next'}
              </button>
            </div>
          )}

          {/* Step 3: Template */}
          {step === 'template' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-medium mb-1">Choose a Template</h2>
                <p className="text-nebula-muted text-xs mb-3">
                  Pick a starting template for your organization. You can customize agents, skills, and tasks later.
                </p>
              </div>

              {loadingTemplates ? (
                <div className="flex items-center justify-center py-6">
                  <p className="text-sm text-nebula-muted">Loading templates...</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {templates.map(t => (
                    <div
                      key={t.id}
                      onClick={() => setSelectedTemplate(t.id)}
                      className={`p-3 rounded-xl border transition-colors cursor-pointer ${
                        selectedTemplate === t.id
                          ? 'border-nebula-accent/30 bg-nebula-accent/5'
                          : 'border-nebula-border hover:border-nebula-accent/20'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-base">{t.icon}</span>
                        <span className="text-sm font-medium">{t.name}</span>
                        <span className="text-[10px] text-nebula-muted ml-auto">
                          {t.agents} agent{t.agents !== 1 ? 's' : ''}
                          {t.skills > 0 && ` · ${t.skills} skill${t.skills !== 1 ? 's' : ''}`}
                          {t.tasks > 0 && ` · ${t.tasks} task${t.tasks !== 1 ? 's' : ''}`}
                        </span>
                      </div>
                      <p className="text-[11px] text-nebula-muted mt-1 line-clamp-2">{t.description}</p>
                    </div>
                  ))}
                  {templates.length === 0 && (
                    <p className="text-sm text-nebula-muted text-center py-4">No templates found. A default agent will be created.</p>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => { setError(''); setStep('runtimes'); }}
                  className="flex-1 py-2.5 text-sm bg-nebula-surface border border-nebula-border rounded-xl hover:bg-nebula-hover transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={() => { setError(''); setStep('complete'); }}
                  className="flex-1 py-2.5 text-sm bg-nebula-accent text-nebula-bg rounded-xl font-semibold hover:brightness-110 transition-all shadow-glow"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Complete */}
          {step === 'complete' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-medium mb-1">Ready to Launch</h2>
                <p className="text-nebula-muted text-xs mb-4">Review your configuration and launch Nebula.</p>
              </div>

              <div className="space-y-2 bg-nebula-bg rounded-xl p-4 border border-nebula-border">
                <div className="flex justify-between text-sm">
                  <span className="text-nebula-muted">Account</span>
                  <span className="text-nebula-text">{user?.email || 'Authenticated'}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-nebula-muted">Runtimes</span>
                  <span className="text-nebula-text">
                    {availableRuntimes.map(r => r.name).join(', ') || 'None detected'}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-nebula-muted">Default Runtime</span>
                  <span className="text-nebula-text">
                    {runtimes.find(r => r.id === defaultRuntime)?.name || defaultRuntime || 'Auto'}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-nebula-muted">Template</span>
                  <span className="text-nebula-text">
                    {templates.find(t => t.id === selectedTemplate)?.name || selectedTemplate || 'Starter'}
                  </span>
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  onClick={() => { setError(''); setStep('template'); }}
                  disabled={completing}
                  className="flex-1 py-2.5 text-sm bg-nebula-surface border border-nebula-border rounded-xl hover:bg-nebula-hover disabled:opacity-30 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleComplete}
                  disabled={completing}
                  className="flex-1 py-2.5 text-sm bg-nebula-accent text-nebula-bg rounded-xl font-semibold hover:brightness-110 disabled:opacity-50 transition-all shadow-glow"
                >
                  {completing ? 'Setting up...' : 'Launch Nebula'}
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="text-nebula-muted text-xs text-center mt-4">
          Nebula
        </p>
      </div>
    </div>
  );
}
