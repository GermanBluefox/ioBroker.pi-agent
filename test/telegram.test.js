'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseAllowedUsers,
    isAllowedUser,
    parseRequest,
    stripPrefix,
    telegramRequestId,
    splitMessage,
} = require('../lib/telegram');

test('allowed users: ids and names, "@" and case ignored, comments skipped', () => {
    const allowed = parseAllowedUsers('753441\n@Alex1808\n# comment\n\n');
    assert.equal(allowed.size, 2);
    assert.ok(isAllowedUser({ userId: 753441 }, allowed));
    assert.ok(isAllowedUser({ userName: 'alex1808' }, allowed));
    assert.ok(!isAllowedUser({ userId: 1, userName: 'someone' }, allowed));
    assert.ok(!isAllowedUser({}, allowed));
});

test('allowed users: the first name counts only for a sender the telegram adapter knows', () => {
    const allowed = parseAllowedUsers('Alex');
    assert.ok(isAllowedUser({ userId: '753441', userName: 'Alex1808', firstName: 'Alex', known: true }, allowed));
    assert.ok(isAllowedUser({ userId: 1, firstName: 'alex', known: true }, allowed), 'case does not matter');
    assert.ok(!isAllowedUser({ userId: 2, firstName: 'Alex', known: false }, allowed), 'a stranger named Alex');
    assert.ok(!isAllowedUser({ userId: 2, firstName: 'Alex' }, allowed));
});

test('allowed users: an empty list allows nobody', () => {
    assert.ok(!isAllowedUser({ userId: 753441, userName: 'alex1808' }, parseAllowedUsers('')));
});

test('request value "[name]text" is split, multi-line text kept', () => {
    assert.deepEqual(parseRequest('[Alex]Ist das Licht an?'), { name: 'Alex', text: 'Ist das Licht an?' });
    assert.deepEqual(parseRequest('[Alex]line 1\nline 2'), { name: 'Alex', text: 'line 1\nline 2' });
    assert.deepEqual(parseRequest('plain'), { name: '', text: 'plain' });
});

test('prefix: required when set, case-insensitive, stripped; empty prefix passes everything', () => {
    assert.equal(stripPrefix('/ai Licht an?', '/ai'), 'Licht an?');
    assert.equal(stripPrefix('/AI Licht an?', '/ai'), 'Licht an?');
    assert.equal(stripPrefix('Licht an?', '/ai'), null);
    assert.equal(stripPrefix('/ai', '/ai'), null);
    assert.equal(stripPrefix('Licht an?', ''), 'Licht an?');
    assert.equal(stripPrefix('', ''), null);
});

test('prefix: a word prefix does not catch longer words, but allows punctuation after it', () => {
    assert.equal(stripPrefix('Pi какой вопрос я задавал?', 'pi'), 'какой вопрос я задавал?');
    assert.equal(stripPrefix('pi, wie warm ist es?', 'pi'), 'wie warm ist es?');
    assert.equal(stripPrefix('pi: Licht an', 'pi'), 'Licht an');
    assert.equal(stripPrefix('pizza bestellen', 'pi'), null);
    assert.equal(stripPrefix('ping', 'pi'), null);
    assert.equal(stripPrefix('/ai2 test', '/ai'), null);
});

test('request id is stable per chat and message', () => {
    assert.equal(telegramRequestId(753441, 12), 'tg-753441-12');
});

test('long answers are split into Telegram-sized parts, preferring line breaks', () => {
    assert.deepEqual(splitMessage('short'), ['short']);
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}`;
    assert.deepEqual(splitMessage(text, 40), ['a'.repeat(30), 'b'.repeat(30)]);
    const parts = splitMessage('x'.repeat(95), 40);
    assert.deepEqual(parts.map(p => p.length), [40, 40, 15]);
});
