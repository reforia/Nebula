import { OpenRouterProvider } from './openrouter.js';
import { OpenAIProvider } from './openai.js';

const providers = {
  openrouter: new OpenRouterProvider(),
  openai: new OpenAIProvider(),
};

export function getProvider(name) {
  return providers[name] || null;
}

export function listProviders() {
  return Object.values(providers);
}

export function listProviderModels() {
  const models = [];
  for (const provider of Object.values(providers)) {
    models.push(...provider.listModels());
  }
  return models;
}
