'use strict';

// "New conversation" deletes the old conversation from the store at the next start (lib/purge.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startAgent, stopAgent, waitFor } = require('./helpers/agent-harness');
const { CRASH_SEED } = require('./helpers/crash-fixture');
const { PURGE_FILE, queuedPurges, purgeQueued } = require('../lib/purge');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-purge-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');

/** Send a message like the admin page does and return the answer. */
function call(agent, command, message = {}, user = 'system.user.admin') {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({ command, message, user, from: 'system.adapter.admin.0', callback: { id: 1 } });
    });
}

/** Ask in the admin chat and wait for the answer. */
async function ask(agent, text, user = 'system.user.admin') {
    await call(agent, 'chatSend', { text }, user);
    await waitFor(async () => !(await call(agent, 'chatHistory', {}, user)).busy, 'the answer');
}

/** Rows of a conversation in the store. */
function rowsOf(dataDir, id) {
    const db = new DatabaseSync(path.join(dataDir, 'session.sqlite'), { readOnly: true });
    try {
        const count = sql => Number(Object.values(db.prepare(sql).get(Number(id)))[0]);
        return {
            conversations: count('SELECT count(*) FROM conversations WHERE id = ?'),
            entries: count('SELECT count(*) FROM entries WHERE conversation_id = ?'),
            tasks: count('SELECT count(*) FROM tasks WHERE conversation_id = ?'),
            documents: count("SELECT count(*) FROM documents WHERE scope_kind = 'conversation' AND owner_id = ?"),
            check: Object.values(db.prepare('PRAGMA integrity_check').get())[0],
        };
    } finally {
        db.close();
    }
}

/** Two admin users with a conversation each; alice starts a new one. */
async function twoConversations(dataDir) {
    const f = await faux();
    const { agent } = await startAgent({
        dataDir,
        seed: structuredClone(CRASH_SEED),
        responses: [f.fauxAssistantMessage('Hello Admin'), f.fauxAssistantMessage('Hello Bob')],
    });
    await ask(agent, 'hi');
    await ask(agent, 'hi', 'system.user.bob');
    const old = agent.chats['admin/system.user.admin'];
    const bob = agent.chats['admin/system.user.bob'];
    assert.deepEqual(await call(agent, 'chatNew'), { ok: true });
    assert.deepEqual(queuedPurges(dataDir), [String(old)]);
    await stopAgent(agent);
    return { old, bob };
}

test('New conversation: the old one is deleted at the next start, after a safety copy; the others stay', async () => {
    const dataDir = tmp();
    const { old, bob } = await twoConversations(dataDir);
    assert.equal(rowsOf(dataDir, old).entries > 0, true, 'still there until the restart');

    const f = await faux();
    const { agent } = await startAgent({ dataDir, responses: [f.fauxAssistantMessage('Hello again Bob')] });
    assert.deepEqual(rowsOf(dataDir, old), { conversations: 0, entries: 0, tasks: 0, documents: 0, check: 'ok' });
    assert.ok(rowsOf(dataDir, bob).entries > 0, "bob's conversation is kept");
    assert.equal(fs.existsSync(path.join(dataDir, PURGE_FILE)), false, 'the queue is empty');
    assert.ok(Object.keys(agent.files).some(k => k.includes('pi-agent-prepurge-')), 'safety copy');
    assert.ok(agent.logs.some(([, msg]) => msg.includes('1 old conversation(s) deleted')));

    // the store still works: bob goes on in his conversation
    await ask(agent, 'and now?', 'system.user.bob');
    const history = await call(agent, 'chatHistory', {}, 'system.user.bob');
    assert.deepEqual(
        history.entries.map(e => e.text || e.html),
        ['hi', 'Hello Bob', 'and now?', 'Hello again Bob'],
    );
    await stopAgent(agent);
});

test('purge: another schema version, an open task or a conversation in use are not deleted', async () => {
    const dataDir = tmp();
    const { old } = await twoConversations(dataDir);
    const store = path.join(dataDir, 'session.sqlite');

    // a newer Pi Durable with another schema: nothing is touched, the queue stays
    let db = new DatabaseSync(store);
    db.exec('UPDATE durable_schema SET version = 99');
    db.close();
    assert.match(purgeQueued(dataDir, new Set()).skipped, /schema version 99/);
    assert.equal(rowsOf(dataDir, old).conversations, 1);
    assert.deepEqual(queuedPurges(dataDir), [String(old)]);

    // a reminder that is not due yet: the conversation waits in the queue
    db = new DatabaseSync(store);
    db.exec('UPDATE durable_schema SET version = 2');
    db.prepare("UPDATE tasks SET status = 'sleeping' WHERE id = (SELECT min(id) FROM tasks WHERE conversation_id = ?)").run(
        Number(old),
    );
    db.close();
    assert.deepEqual(purgeQueued(dataDir, new Set(), { check: true }), { deleted: [], waiting: [String(old)] });
    assert.deepEqual(purgeQueued(dataDir, new Set()), { deleted: [], waiting: [String(old)] });
    assert.equal(rowsOf(dataDir, old).conversations, 1);

    // a chat uses it again (e.g. after a restore): it stays and leaves the queue
    assert.deepEqual(purgeQueued(dataDir, new Set([String(old)])), { deleted: [], waiting: [] });
    assert.equal(rowsOf(dataDir, old).conversations, 1);
    assert.deepEqual(queuedPurges(dataDir), []);
});
