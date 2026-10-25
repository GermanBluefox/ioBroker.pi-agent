'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDERS, loadProvider } = require('../lib/providers');

for (const name of Object.keys(PROVIDERS)) {
	test(`provider ${name}: loads, id matches, default model is in the catalog`, async () => {
		const { createModels } = await import('@earendil-works/pi-ai/models');
		const { spec, provider } = await loadProvider(name);
		assert.equal(provider.id, name);
		const models = createModels();
		models.setProvider(provider);
		const model = models.getModel(name, spec.defaultModel);
		assert.ok(model, `${spec.defaultModel} not found; known: ${models.getModels(name).map(m => m.id).join(', ')}`);
	});
}

test('unknown provider is refused', async () => {
	await assert.rejects(loadProvider('nope'), /Unknown provider/);
});
