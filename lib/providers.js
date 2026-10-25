'use strict';

/**
 * Supported model providers. The key of this table is also the provider id pi-ai uses in model
 * references and in its credential store.
 */
const PROVIDERS = {
    anthropic: {
        module: '@earendil-works/pi-ai/providers/anthropic',
        factory: 'anthropicProvider',
        defaultModel: 'claude-sonnet-5-5',
    },
    openai: {
        module: '@earendil-works/pi-ai/providers/openai',
        factory: 'openaiProvider',
        defaultModel: 'gpt-6-sol',
    },
    deepseek: {
        module: '@earendil-works/pi-ai/providers/deepseek',
        factory: 'deepseekProvider',
        defaultModel: 'deepseek-flash',
    },
};

/**
 * Load the pi-ai provider for a configured name.
 *
 * @param {string} name provider name from the configuration
 * @returns {Promise<{ spec: typeof PROVIDERS[keyof typeof PROVIDERS], provider: object }>} spec and provider instance
 */
async function loadProvider(name) {
    const spec = PROVIDERS[name];
    if (!spec) {
        throw new Error(`Unknown provider "${name}"`);
    }
    const mod = await import(spec.module);
    return { spec, provider: mod[spec.factory]() };
}

/**
 * Model collection for one provider whose API key lives in an in-memory credential store.
 * A stored credential takes precedence over environment variables in pi-ai, so the key never
 * has to be put into the environment of the (possibly shared) process.
 *
 * @param {string} name provider name from the configuration
 * @param {string} apiKey API key of that provider
 * @returns {Promise<{ spec: typeof PROVIDERS[keyof typeof PROVIDERS], models: object }>} spec and models
 */
async function createModelsWithKey(name, apiKey) {
    const { spec, provider } = await loadProvider(name);
    const [{ createModels }, { InMemoryCredentialStore }] = await Promise.all([
        import('@earendil-works/pi-ai/models'),
        import('@earendil-works/pi-ai'),
    ]);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(name, async () => ({ type: 'api_key', key: apiKey }));
    const models = createModels({ credentials });
    models.setProvider(provider);
    return { spec, models };
}

module.exports = { PROVIDERS, loadProvider, createModelsWithKey };
