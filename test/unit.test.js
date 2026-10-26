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
	const known = new Set(['text', 'password', 'number', 'checkbox', 'select', 'instance', 'header', 'autocompleteSendTo']);
	for (const [key, item] of Object.entries(config.items)) {
		assert.ok(known.has(item.type), `${key} uses unknown type "${item.type}"`);
	}
});

/** Brand names that read the same in every language. */
const SAME_IN_ALL_LANGUAGES = new Set(['Telegram']);

test('i18n: eleven languages for instance objects, same admin keys, nothing left in English', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const io = require('../io-package.json');
    const langs = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
    assert.equal('title' in io.common, false, 'common.title is deprecated');
    for (const obj of io.instanceObjects) {
        assert.deepEqual(Object.keys(obj.common.name).sort(), [...langs].sort(), obj._id);
    }
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../admin/i18n/en.json'), 'utf8'));
    for (const lang of langs.filter(l => l !== 'en')) {
        const tr = JSON.parse(fs.readFileSync(path.join(__dirname, `../admin/i18n/${lang}.json`), 'utf8'));
        assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort(), `keys of ${lang}`);
        for (const key of Object.keys(en)) {
            if (!SAME_IN_ALL_LANGUAGES.has(key)) {
                assert.notEqual(tr[key], en[key], `${lang}: "${key}" is still English`);
            }
        }
    }
});

test('jsonConfig: every label, help and header text has a translation key', () => {
    const config = require('../admin/jsonConfig.json');
    const en = require('../admin/i18n/en.json');
    for (const [key, item] of Object.entries(config.items)) {
        for (const field of ['label', 'help', 'text', 'placeholder']) {
            if (item[field]) {
                assert.ok(item[field] in en, `${key}.${field} "${item[field]}" has no translation`);
            }
        }
    }
});

test('objects: instanceObjects keep only info, the rest is created in code with eleven languages', () => {
    const io = require('../io-package.json');
    const { OBJECTS } = require('../lib/objects');
    const names = require('../lib/object-names.json');
    assert.deepEqual(
        io.instanceObjects.map(o => o._id),
        ['info', 'info.connection'],
        'chat.* and telegram.* must not be in instanceObjects (js-controller resets their ACL at start)',
    );
    for (const { id } of OBJECTS) {
        assert.equal(Object.keys(names[id] || {}).length, 11, id);
    }
});

test('io-package: the messagebox is really enabled (sendTo reaches the adapter)', () => {
    const io = require('../io-package.json');
    // js-controller (isMessageboxSupported): when common.supportedMessages exists, common.messagebox is ignored and
    // the adapter subscribes to messages only if one of its values is true. {custom: false} switched sendTo off.
    const supported = io.common.supportedMessages;
    const enabled = supported && typeof supported === 'object'
        ? Object.values(supported).some(v => v !== false)
        : Boolean(io.common.messagebox);
    assert.ok(enabled, 'sendTo would never reach the adapter');
});
