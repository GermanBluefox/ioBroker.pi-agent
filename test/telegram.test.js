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
    markdownToTelegramHtml,
    isWellFormedHtml,
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
    assert.equal(telegramRequestId('telegram.0', 753441, 12), 'tg-telegram.0-753441-12');
});

test('long answers are split into Telegram-sized parts, preferring line breaks', () => {
    assert.deepEqual(splitMessage('short'), ['short']);
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}`;
    assert.deepEqual(splitMessage(text, 40), ['a'.repeat(30), 'b'.repeat(30)]);
    const parts = splitMessage('x'.repeat(95), 40);
    assert.deepEqual(parts.map(p => p.length), [40, 40, 15]);
});

test('Markdown becomes Telegram HTML; everything else is escaped', () => {
    const h = markdownToTelegramHtml;
    assert.equal(h('**test**'), '<b>test</b>');
    assert.equal(h('*kursiv* und `hm-rpc.0.x`'), '<i>kursiv</i> und <code>hm-rpc.0.x</code>');
    assert.equal(h('a<b & c>d'), 'a&lt;b &amp; c&gt;d');
    assert.equal(h('## Titel\n- eins\n* zwei'), '<b>Titel</b>\n• eins\n• zwei');
    assert.equal(h('[Link](https://example.com)'), '<a href="https://example.com">Link</a>');
    assert.equal(h('```js\nlet a = 1 < 2;\n```'), '<pre>let a = 1 &lt; 2;</pre>');
    assert.equal(h('| a | b |\n|---|---|\n| 1 | 2 |\nweiter'), '<pre>| a | b |\n| 1 | 2 |</pre>\nweiter');
});

test('Markdown conversion leaves ids and arithmetic alone', () => {
    const h = markdownToTelegramHtml;
    assert.equal(h('2*3*4'), '2*3*4');
    assert.equal(h('hm_rpc_0__x__y'), 'hm_rpc_0__x__y');
    assert.equal(h('`a<b`'), '<code>a&lt;b</code>');
});

test('HTML check: overlapping tags from Markdown are detected, normal answers pass', () => {
    assert.equal(isWellFormedHtml(markdownToTelegramHtml('**fett** und *kursiv*')), true);
    assert.equal(isWellFormedHtml(markdownToTelegramHtml('**fett *kursiv** text*')), false);
    assert.equal(isWellFormedHtml('<b>offen'), false);
    assert.equal(isWellFormedHtml('a &lt;b&gt; c'), true);
});

test('a quote in a link URL cannot break the href attribute', () => {
    assert.equal(markdownToTelegramHtml('[a](https://x.de/?q="1")'), '<a href="https://x.de/?q=&quot;1&quot;">a</a>');
});

const { channelsFromConfig, chatKey, parseChatKey, migrateChats } = require('../lib/channels');

test('allowed users can also be separated by commas (one table cell)', () => {
    const allowed = parseAllowedUsers('753441, @Alex1808; Bob');
    assert.deepEqual([...allowed].sort(), ['753441', 'alex1808', 'bob']);
});

test('channels: table rows, disabled and duplicate rows skipped, single fields of 0.0.5 as fallback', () => {
    const table = channelsFromConfig({
        messengers: [
            { enabled: true, instance: ' telegram.0 ', users: '1, 2', prefix: ' /ai ' },
            { enabled: false, instance: 'telegram.1', users: '1', prefix: '' },
            { enabled: true, instance: 'telegram.0', users: '3', prefix: '' },
            { enabled: true, instance: '', users: '3', prefix: '' },
        ],
        telegramInstance: 'telegram.9',
    });
    assert.deepEqual(
        table.map(c => [c.instance, [...c.allowed], c.prefix]),
        [['telegram.0', ['1', '2'], '/ai']],
    );
    const legacy = channelsFromConfig({ messengers: [], telegramInstance: 'telegram.0', telegramUsers: '1\n2' });
    assert.deepEqual(legacy.map(c => [c.instance, [...c.allowed], c.prefix]), [['telegram.0', ['1', '2'], '']]);
    assert.deepEqual(channelsFromConfig({}), []);
});

test('chat keys carry the instance; keys of 0.0.5 belong to the first instance', () => {
    assert.equal(chatKey('telegram.0', 100), 'telegram.0/100');
    assert.deepEqual(parseChatKey('telegram.1/-100', 'telegram.0'), { instance: 'telegram.1', chatId: '-100' });
    assert.deepEqual(parseChatKey('100', 'telegram.0'), { instance: 'telegram.0', chatId: '100' });
    assert.deepEqual(migrateChats({ 100: 'a', 'telegram.1/5': 'b' }, 'telegram.0'), {
        chats: { 'telegram.0/100': 'a', 'telegram.1/5': 'b' },
        changed: true,
    });
    assert.equal(migrateChats({ 'telegram.0/100': 'a' }, 'telegram.0').changed, false);
});
