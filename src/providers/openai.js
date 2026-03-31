/**
 * OpenAI provider — model registry + API key configuration.
 * Execution is handled by OpenCode CLI runtime, not by this provider.
 */
export class OpenAIProvider {
  constructor() {
    this.name = 'openai';
    this.label = 'OpenAI';
    this.settingsKey = 'openai_api_key';
  }

  listModels() {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai' },
      { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'openai' },
      { id: 'o3-mini', name: 'o3 Mini', provider: 'openai' },
      { id: 'o4-mini', name: 'o4 Mini', provider: 'openai' },
    ];
  }
}
