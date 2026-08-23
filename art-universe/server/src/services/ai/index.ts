import { LocalAiProvider } from './local.js';
import { AnthropicAiProvider } from './anthropic.js';
import type { AiProvider } from './types.js';

export * from './types.js';
export * from './embeddings.js';
export { detectPii } from './pii.js';
export { readIntent, expand } from './lexicon.js';
export { LocalAiProvider, AnthropicAiProvider };

export function createAiProvider(opts: {
  anthropicApiKey: string | null;
  anthropicModel: string;
}): AiProvider {
  if (opts.anthropicApiKey) {
    return new AnthropicAiProvider(opts.anthropicApiKey, opts.anthropicModel);
  }
  return new LocalAiProvider();
}
