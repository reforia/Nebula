/**
 * OpenRouter provider — model registry + API key configuration.
 * Execution is handled by OpenCode CLI runtime, not by this provider.
 */
export class OpenRouterProvider {
  constructor() {
    this.name = 'openrouter';
    this.label = 'OpenRouter';
    this.settingsKey = 'openrouter_api_key';
  }

  listModels() {
    return [
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'openrouter' },
      { id: 'anthropic/claude-haiku-4', name: 'Claude Haiku 4', provider: 'openrouter' },
      { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openrouter' },
      { id: 'openai/o3-mini', name: 'o3 Mini', provider: 'openrouter' },
      { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', provider: 'openrouter' },
      { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', provider: 'openrouter' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', provider: 'openrouter' },
      { id: 'deepseek/deepseek-chat-v3', name: 'DeepSeek V3', provider: 'openrouter' },
      { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', provider: 'openrouter' },
      { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout', provider: 'openrouter' },
      { id: 'mistralai/mistral-large-2', name: 'Mistral Large 2', provider: 'openrouter' },
      { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B', provider: 'openrouter' },
    ];
  }
}
