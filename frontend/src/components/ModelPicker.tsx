import { useState, useMemo, useEffect, useRef } from 'react';
import { useModels } from '../hooks/useModels';
import { useRuntimeInfo, useRuntimes } from './RuntimeSelector';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  google: 'Google',
  deepseek: 'DeepSeek',
};

interface Props {
  model: string;
  onChange: (model: string) => void;
  runtimeId?: string;
  className?: string;
}

export default function ModelPicker({ model, onChange, runtimeId, className }: Props) {
  const allModels = useModels();
  const { loading: runtimesLoading } = useRuntimes();
  const rtInfo = useRuntimeInfo(runtimeId || '');
  const [customMode, setCustomMode] = useState(false);
  const prevRuntimeRef = useRef(runtimeId);

  const runtimeModels = rtInfo?.models ?? [];
  const prefixes = rtInfo?.supportedModelPrefixes ?? [];
  const acceptsAnyModel = prefixes.length === 0;

  // Build filtered model list for this runtime
  const models = useMemo(() => {
    if (runtimeModels.length > 0) return runtimeModels;
    if (prefixes.length > 0) {
      return allModels.filter(m => prefixes.some(p => m.id.startsWith(p)));
    }
    // Runtime loaded with no models and no prefixes — accepts any model via text input
    if (runtimeId && rtInfo) return [];
    // Runtime not loaded yet — show nothing until we know
    if (runtimeId && !rtInfo) return [];
    // No runtime selected — show all
    return allModels;
  }, [allModels, runtimeModels, prefixes, runtimeId, rtInfo]);

  // When runtime changes, reset to a valid model for the new runtime
  useEffect(() => {
    if (prevRuntimeRef.current !== runtimeId) {
      prevRuntimeRef.current = runtimeId;
      setCustomMode(false);
      // Auto-select first model only on runtime change
      if (models.length > 0 && !models.some(m => m.id === model)) {
        onChange(models[0].id);
      }
    }
  }, [runtimeId, models]);

  // If the loaded model isn't in the dropdown, drop into custom-input mode so
  // the picker shows the real value instead of silently swapping to the first
  // known option.
  useEffect(() => {
    if (model && models.length > 0 && !models.some(m => m.id === model)) {
      setCustomMode(true);
    }
  }, [model, models]);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof models> = {};
    for (const m of models) {
      const provider = m.provider || 'other';
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(m);
    }
    return groups;
  }, [models]);

  const hasModels = models.length > 0;
  const inputClass = className || "w-full px-3 py-2 bg-nebula-bg border border-nebula-border rounded text-sm text-nebula-text focus:outline-none focus:border-nebula-accent";

  // Show skeleton while runtime info is loading
  if (!rtInfo && (runtimesLoading || runtimeId)) {
    return <div className={`${inputClass} animate-pulse h-[38px]`} />;
  }

  // Custom text input mode (user explicitly chose "Enter model ID..." or runtime has no known list)
  if (customMode || (!hasModels && acceptsAnyModel && rtInfo)) {
    const hint = prefixes.length > 0
      ? `Model ID (must start with ${prefixes.join(' / ')})`
      : 'e.g. anthropic/claude-sonnet-4-6 or openrouter/deepseek/deepseek-v3.2';
    return (
      <div>
        <input
          type="text"
          value={model}
          onChange={e => onChange(e.target.value)}
          placeholder={hint}
          className={inputClass}
        />
        {hasModels && (
          <button
            type="button"
            onClick={() => { setCustomMode(false); if (!models.some(m => m.id === model) && models[0]) onChange(models[0].id); }}
            className="text-[10px] text-nebula-muted hover:text-nebula-accent mt-0.5"
          >
            Pick from list
          </button>
        )}
      </div>
    );
  }

  // Dropdown mode
  return (
    <select
      value={models.some(m => m.id === model) ? model : ''}
      onChange={e => {
        if (e.target.value === '__custom__') { setCustomMode(true); return; }
        onChange(e.target.value);
      }}
      className={inputClass}
    >
      {!models.some(m => m.id === model) && (
        <option value="" disabled>Select a model...</option>
      )}
      {Object.entries(grouped).map(([provider, providerModels]) => (
        <optgroup key={provider} label={PROVIDER_LABELS[provider] || provider}>
          {providerModels.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </optgroup>
      ))}
      <optgroup label="Custom">
        <option value="__custom__">Enter model ID…</option>
      </optgroup>
    </select>
  );
}
