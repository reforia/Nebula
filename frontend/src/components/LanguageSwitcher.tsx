import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '../i18n';

export default function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { i18n, t } = useTranslation();

  return (
    <label className={`flex items-center gap-2 text-sm text-nebula-muted ${className}`}>
      <span>{t('common.language')}</span>
      <select
        value={i18n.resolvedLanguage || 'en'}
        onChange={e => i18n.changeLanguage(e.target.value)}
        className="bg-nebula-bg border border-nebula-border rounded-lg px-2 py-1 text-nebula-text focus:outline-none focus:border-nebula-accent/50"
      >
        {SUPPORTED_LANGUAGES.map(l => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>
    </label>
  );
}
