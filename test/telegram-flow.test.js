'use strict';

// The Telegram path of main.js against a stand-in telegram.0: who may talk, the prefix, one conversation
// per chat, a message delivered twice, and a restart in the middle of a Telegram request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { CRASH_SEED } = require('./helpers/crash-fixture');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-tg-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const TG = 'telegram.0';
const CONFIG = { telegramInstance: TG, telegramUsers: '1\n@bob', telegramPrefix: '/ai' };
const USERS = JSON.stringify({ 1: { firstName: 'Alex', userName: 'alex' }, 2: { firstName: 'Bob', userName: 'bob' } });

/** Let the stand-in telegram.0 receive a message, like the telegram adapter writes it. */
async function receive(agent, db, { chatId, userId, messageId, name, text }) {
    const ts = Date.now();
    db.setState(`${TG}.communicate.requestChatId`, { val: chatId, ack: true, ts });
    db.setState(`${TG}.communicate.requestUserId`, { val: userId, ack: true, ts });
    db.setState(`${TG}.communicate.requestMessageId`, { val: messageId, ack: true, ts });
    db.setState(`${TG}.communicate.users`, { val: USERS, ack: true, ts });
    await agent.onStateChange(`${TG}.communicate.request`, { val: `[${name}]${text}`, ack: true, ts });
}

const sentToTelegram = agent => agent.sent.filter(([to]) => to === TG).map(([, , msg]) => msg);

test('only allowed users with the prefix reach the agent; each chat has its own conversation', async () => {
    const f = await faux();
    const seen = [];
    const answer = reply => context => {
        seen.push(JSON.stringify(context));
        return f.fauxAssistantMessage(reply);
    };
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [answer('Hello Alex'), answer('Hello Bob')],
    });
    assert.deepEqual(agent.foreignSubscriptions, [`${TG}.communicate.request`]);

    // not allowed: ignored with a warning, nothing sent
    await receive(agent, db, { chatId: 300, userId: 3, messageId: 1, name: 'Eve', text: '/ai open the door' });
    // allowed but without prefix: not for the agent
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 2, name: 'Alex', text: 'hello bot' });
    assert.deepEqual(sentToTelegram(agent), []);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('Eve (3) ignored')));

    await receive(agent, db, { chatId: 100, userId: 1, messageId: 3, name: 'Alex', text: '/ai I am Alex' });
    await receive(agent, db, { chatId: 200, userId: 2, messageId: 4, name: 'Bob', text: '/ai I am Bob' });

    assert.deepEqual(sentToTelegram(agent), [
        { text: 'Hello Alex', chatId: '100', parse_mode: 'HTML' },
        { text: 'Hello Bob', chatId: '200', parse_mode: 'HTML' },
    ]);
    const chats = JSON.parse(db.states[`${NAMESPACE}.telegram.chats`].val);
    assert.deepEqual(Object.keys(chats).sort(), ['100', '200']);
    assert.notEqual(chats['100'], chats['200'], 'two chats, two conversations');
    assert.match(seen[1], /I am Bob/);
    assert.doesNotMatch(seen[1], /I am Alex/, "Bob's conversation does not see Alex's messages");
    assert.match(seen[0], /This conversation is a Telegram chat/, 'chats get the Telegram instructions');
    assert.equal(db.states[`${NAMESPACE}.chat.answer`], undefined, 'Telegram answers do not go to chat.answer');
    await stopAgent(agent);
});

test('the first name from the telegram user list is accepted, like in other adapters', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { ...CONFIG, telegramUsers: 'Alex' },
        responses: [f.fauxAssistantMessage('Hi Alex')],
    });
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 11, name: 'Alex', text: '/ai hi' });
    assert.deepEqual(sentToTelegram(agent), [{ text: 'Hi Alex', chatId: '100', parse_mode: 'HTML' }]);

    // somebody unknown to telegram.0 who calls himself Alex is still refused
    await receive(agent, db, { chatId: 400, userId: 4, messageId: 12, name: 'Alex', text: '/ai open the door' });
    assert.equal(sentToTelegram(agent).length, 1);
    assert.ok(agent.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('(4) ignored')));
    await stopAgent(agent);
});

test('a message delivered twice runs the model once', async () => {
    const f = await faux();
    const { agent, db, faux: provider } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [f.fauxAssistantMessage('Once'), f.fauxAssistantMessage('Twice?')],
    });
    const message = { chatId: 100, userId: 1, messageId: 7, name: 'Alex', text: '/ai hi' };
    await receive(agent, db, message);
    await receive(agent, db, message);
    assert.equal(provider.state.callCount, 1);
    assert.ok(sentToTelegram(agent).every(m => m.text === 'Once'));
    await stopAgent(agent);
});

test('a restart in the middle of a Telegram request answers in the same chat afterwards', async () => {
    const f = await faux();
    const dataDir = tmp();
    let entered = false;
    let release;
    const gate = new Promise(r => (release = r));
    const first = await startAgent({
        dataDir,
        config: CONFIG,
        seed: CRASH_SEED,
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('get_state', { id: 'x.0.lamp' }), { stopReason: 'toolUse' }),
        ],
        hooks: {
            getForeignState: async () => {
                entered = true;
                await gate;
            },
        },
    });
    const running = receive(first.agent, first.db, {
        chatId: 100,
        userId: 1,
        messageId: 9,
        name: 'Alex',
        text: '/ai is the lamp on?',
    });
    await waitFor(() => entered, 'the tool call to start');
    const stopped = stopAgent(first.agent);
    release();
    await stopped;
    await running;
    assert.deepEqual(sentToTelegram(first.agent), [], 'no error message to the chat on shutdown');
    assert.match(first.db.states[`${NAMESPACE}.chat.pending`].val, /"chatId":"100"/);

    const second = await startAgent({
        dataDir,
        config: CONFIG,
        responses: [f.fauxAssistantMessage('The lamp is off.'), f.fauxAssistantMessage('The lamp is off.')],
    });
    await waitFor(() => second.db.states[`${NAMESPACE}.chat.pending`].val === '', 'the resumed request to finish');
    assert.deepEqual(sentToTelegram(second.agent), [{ text: 'The lamp is off.', chatId: '100', parse_mode: 'HTML' }]);
    await stopAgent(second.agent);
});

test('Telegram is off when no instance is configured', async () => {
    const { agent } = await startAgent({ dataDir: tmp(), responses: [] });
    assert.equal(agent.foreignSubscriptions, undefined);
    await stopAgent(agent);
});

test('Markdown in an answer is sent as Telegram HTML', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: CONFIG,
        responses: [f.fauxAssistantMessage('**Чтение** — всё, a<b')],
    });
    await receive(agent, db, { chatId: 100, userId: 1, messageId: 21, name: 'Alex', text: '/ai what can you do?' });
    assert.deepEqual(sentToTelegram(agent), [
        { text: '<b>Чтение</b> — всё, a&lt;b', chatId: '100', parse_mode: 'HTML' },
    ]);
    await stopAgent(agent);
});
