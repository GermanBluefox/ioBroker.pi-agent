'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseAllowlist, isWriteAllowed, requestIdFor } = require('../lib/guard');
const { coerce, nameText } = require('../lib/tools');

test('allowlist: empty list denies everything', () => {
	assert.equal(isWriteAllowed('hm-rpc.0.Licht', parseAllowlist('')), false);
});

test('allowlist: matches, comments, blank lines', () => {
	const list = parseAllowlist('# rooms\n^hm-rpc\\.0\\.Wohnzimmer\\.\n\n^javascript\\.0\\.agent\\.');
	assert.equal(list.length, 2);
	assert.equal(isWriteAllowed('hm-rpc.0.Wohnzimmer.Licht', list), true);
	assert.equal(isWriteAllowed('hm-rpc.0.Haustuer.Schloss', list), false);
});

test('allowlist: a broken line is reported and skipped, never opens the list', () => {
	const bad = [];
	const list = parseAllowlist('(unclosed\n^ok\\.', (line, msg) => bad.push([line, msg]));
	assert.equal(list.length, 1);
	assert.equal(bad.length, 1);
	assert.equal(isWriteAllowed('anything', list), false);
});

test('requestId: same trigger gives the same id, another value another id', () => {
	assert.equal(requestIdFor(crypto, 1, 'a'), requestIdFor(crypto, 1, 'a'));
	assert.notEqual(requestIdFor(crypto, 1, 'a'), requestIdFor(crypto, 1, 'b'));
});

test('coerce: converts to the declared state type', () => {
	assert.equal(coerce('true', 'boolean'), true);
	assert.equal(coerce('false', 'boolean'), false);
	assert.equal(coerce('21.5', 'number'), 21.5);
	assert.equal(coerce(5, 'string'), '5');
	assert.throws(() => coerce('abc', 'number'));
});

test('nameText: handles translated names', () => {
	assert.equal(nameText({ en: 'Light', de: 'Licht' }), 'Light');
	assert.equal(nameText('Plain'), 'Plain');
	assert.equal(nameText(undefined), '');
});

test('io-package: the API key is declared encrypted and protected at the top level', () => {
	const io = require('../io-package.json');
	// js-controller reads these two lists from the top level only; inside "common" they are ignored.
	assert.deepEqual(io.encryptedNative, ['apiKey']);
	assert.deepEqual(io.protectedNative, ['apiKey']);
	assert.equal('encryptedNative' in io.common, false);
	assert.equal('protectedNative' in io.common, false);
});

test('jsonConfig: only component types the admin knows', () => {
	const config = require('../admin/jsonConfig.json');
	const known = new Set(['text', 'password', 'number', 'checkbox', 'select']);
	for (const [key, item] of Object.entries(config.items)) {
		assert.ok(known.has(item.type), `${key} uses unknown type "${item.type}"`);
	}
});
