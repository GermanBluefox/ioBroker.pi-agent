'use strict';

/**
 * Supported model providers. Each pi-ai provider reads its key from the named environment variable.
 * The key of this table is also the provider id pi-ai uses in model references.
 */
const PROVIDERS = {
	anthropic: {
		module: '@earendil-works/pi-ai/providers/anthropic',
		factory: 'anthropicProvider',
		env: 'ANTHROPIC_API_KEY',
		defaultModel: 'claude-sonnet-5-5',
	},
	openai: {
		module: '@earendil-works/pi-ai/providers/openai',
		factory: 'openaiProvider',
		env: 'OPENAI_API_KEY',
		defaultModel: 'gpt-6-sol',
	},
	deepseek: {
		module: '@earendil-works/pi-ai/providers/deepseek',
		factory: 'deepseekProvider',
		env: 'DEEPSEEK_API_KEY',
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

module.exports = { PROVIDERS, loadProvider };
