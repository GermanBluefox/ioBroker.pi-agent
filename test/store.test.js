'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');
const { startAgent, stopAgent, NAMESPACE } = require('./helpers/agent-harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-store-'));
const log = () => {
    const lines = [];
    return { lines, info: m => lines.push(m) };
};

/** A JSONL store as version 0.0.1/0.0.2 left it. */
async function makeJsonlStore(dir) {
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const jsonl = await import('@earendil-works/pi-durable/storage/jsonl/node');
    const storage = await jsonl.openNodeJsonlStorage(path.join(dir, 'session'), context);
    await storage.close?.(context);
}

test('a new instance starts on SQLite', async () => {
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const dir = tmp();
    const l = log();
    const { storage, kind, migrated } = await openStore(dir, context, { pendingCount: 0, log: l });
    assert.equal(kind, 'sqlite');
    assert.equal(migrated, false);
    assert.ok(fs.existsSync(path.join(dir, 'session.sqlite')));
    await storage.close?.(context);
});

test('an old JSONL store is moved aside, not deleted, and SQLite takes over', async () => {
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const dir = tmp();
    await makeJsonlStore(dir);
    const l = log();
    const { storage, kind, migrated } = await openStore(dir, context, { pendingCount: 0, log: l });
    assert.equal(kind, 'sqlite');
    assert.equal(migrated, true);
    assert.ok(!fs.existsSync(path.join(dir, 'session')), 'old folder renamed');
    assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('session.jsonl-')).length, 1, 'backup kept');
    assert.match(l.lines.join('\n'), /moved to SQLite/);
    await storage.close?.(context);
});

test('pending requests keep the JSONL store for one more start', async () => {
    const { BACKGROUND_CONTEXT: context } = await import('@earendil-works/chord/context');
    const dir = tmp();
    await makeJsonlStore(dir);
    const l = log();
    const { storage, kind, migrated } = await openStore(dir, context, { pendingCount: 2, log: l });
    assert.equal(kind, 'jsonl');
    assert.equal(migrated, false);
    assert.ok(fs.existsSync(path.join(dir, 'session')));
    assert.ok(!fs.existsSync(path.join(dir, 'session.sqlite')));
    assert.match(l.lines.join('\n'), /2 request\(s\) still pending/);
    await storage.close?.(context);
});

test('after the switch the Telegram chat mapping of the old store is cleared', async () => {
    const dataDir = tmp();
    await makeJsonlStore(dataDir);
    const { agent, db } = await startAgent({
        dataDir,
        responses: [],
        seed: { states: { [`${NAMESPACE}.telegram.chats`]: { val: '{"100":7}', ack: true, ts: 1 } } },
    });
    assert.equal(db.states[`${NAMESPACE}.telegram.chats`].val, '');
    await stopAgent(agent);
});
