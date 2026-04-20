import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'error' | 'success' | 'info';
interface Toast { id: number; kind: ToastKind; message: string }

interface ToastContextType {
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  showInfo: (message: string) => void;
  reportError: (err: unknown, fallback: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts(prev => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);

  const showError = useCallback((m: string) => push('error', m), [push]);
  const showSuccess = useCallback((m: string) => push('success', m), [push]);
  const showInfo = useCallback((m: string) => push('info', m), [push]);

  const reportError = useCallback((err: unknown, fallback: string) => {
    const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : fallback);
    console.warn('[toast]', fallback, err);
    push('error', msg || fallback);
  }, [push]);

  return (
    <ToastContext.Provider value={{ showError, showSuccess, showInfo, reportError }}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none" role="region" aria-label="Notifications">
      {toasts.map(t => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto px-4 py-3 rounded shadow-lg text-sm max-w-sm border
            ${t.kind === 'error' ? 'bg-red-900/90 border-red-700 text-red-50'
              : t.kind === 'success' ? 'bg-emerald-900/90 border-emerald-700 text-emerald-50'
              : 'bg-nebula-surface border-nebula-border text-nebula-text'}`}
          onClick={() => onDismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

/**
 * Module-level escape hatch for code that runs outside React (e.g. inside an
 * API client wrapper). Components should prefer useToast(). The provider wires
 * itself here on mount; if no provider is mounted, calls fall back to console.
 */
let globalReporter: ((err: unknown, fallback: string) => void) | null = null;
export function setGlobalErrorReporter(fn: typeof globalReporter) { globalReporter = fn; }
export function reportErrorGlobal(err: unknown, fallback: string) {
  if (globalReporter) globalReporter(err, fallback);
  else console.warn('[toast/global]', fallback, err);
}

export function ToastBridge() {
  const { reportError } = useToast();
  useEffect(() => {
    setGlobalErrorReporter(reportError);
    return () => setGlobalErrorReporter(null);
  }, [reportError]);
  return null;
}
