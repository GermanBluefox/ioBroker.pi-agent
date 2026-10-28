'use strict';

// 0.6.0: the tool restart_instance ("Restart allowed" in the write permissions, always confirmed) and the long-term
// memory (tools remember and forget, state memory.list, part of the backups), through the real main.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAgent, stopAgent, waitFor, NAMESPACE } = require('./helpers/agent-harness');
const { parseWriteRules } = require('../lib/guard');
const { parseFacts, MAX_FACT_LENGTH } = require('../lib/memory');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-060-'));
const faux = () => import('@earendil-works/pi-ai/providers/faux');
const TELEGRAM = 'system.adapter.telegram.0';

/** Send a message like the admin page or a script does and return the answer. */
function call(agent, command, message = {}, extra = {}) {
    return new Promise(resolve => {
        const sendTo = agent.sendTo.bind(agent);
        agent.sendTo = (to, cmd, answer) => {
            agent.sendTo = sendTo;
            resolve(answer);
        };
        agent.onMessage({
            command,
            message,
            user: 'system.user.admin',
            from: 'system.adapter.admin.0',
            callback: { id: 1 },
            ...extra,
        });
    });
}

/** The result text of the last call of a tool in the admin chat. */
async function lastToolResult(agent, name) {
    const history = await call(agent, 'chatHistory');
    const calls = history.entries.filter(e => e.role === 'tool' && e.detail?.name === name);
    return String(calls.at(-1)?.detail?.result ?? '');
}

/** Wait for the admin chat to finish its request. */
function settled(agent) {
    return waitFor(async () => !(await call(agent, 'chatHistory')).busy, 'the answer');
}

test('write rules: "Restart allowed" only for a whole instance, never pi-agent or admin', () => {
    const rows = [
        { scope: 'telegram.0', restart: true },
        { scope: 'Hm-Rpc.1', write: true, restart: true },
        { scope: 'hue.0.*.on', write: true, restart: true },
        { scope: '0_userdata.0.agent', restart: true },
        { scope: 'pi-agent.0', restart: true },
        { scope: 'admin.0', restart: true },
        { scope: 'zigbee.0', write: true },
    ];
    assert.deepEqual(parseWriteRules(rows).restart, ['telegram.0', 'hm-rpc.1']);
});

test('restart_instance: asked in the admin chat, the instance is restarted and runs again', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'telegram.0', write: false, confirm: false, restart: true }] },
        seed: { objects: { [TELEGRAM]: { _id: TELEGRAM, type: 'instance', common: { enabled: true, mode: 'daemon' } } } },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('restart_instance', { instance: 'telegram.0' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Telegram runs again.'),
        ],
    });
    agent.restartWaitMs = 10_000;
    const writes = [];
    const extend = agent.extendForeignObjectAsync.bind(agent);
    agent.extendForeignObjectAsync = (id, obj) => (writes.push([id, obj]), extend(id, obj));
    await call(agent, 'chatSend', { text: 'restart telegram' });
    let question;
    await waitFor(async () => (question = (await call(agent, 'chatHistory')).question), 'the question');
    assert.equal(question.action, 'restart');
    assert.equal(question.id, 'telegram.0');
    assert.deepEqual(writes, [], 'nothing happens before the answer');

    await call(agent, 'chatConfirm', { nonce: question.nonce, answer: 'yes' });
    // js-controller restarts the instance when its object is written: the new process reports alive, uptime 0
    await waitFor(async () => writes.length === 1, 'the write of the instance object');
    assert.deepEqual(writes[0], [TELEGRAM, { common: { enabled: true } }]);
    db.setState(`${TELEGRAM}.alive`, { val: true, ack: true });
    db.setState(`${TELEGRAM}.uptime`, { val: 0, ack: true });
    await settled(agent);
    assert.match(await lastToolResult(agent, 'restart_instance'), /telegram\.0 was restarted and runs again/);
    await stopAgent(agent);
});

test('restart_instance: not allowed, pi-agent itself, and from a sendTo caller (nobody to confirm) are blocked', async () => {
    const f = await faux();
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        config: { dryRun: false, writeRules: [{ scope: 'telegram.0', restart: true }] },
        seed: { objects: { [TELEGRAM]: { _id: TELEGRAM, type: 'instance', common: { enabled: true, mode: 'daemon' } } } },
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('restart_instance', { instance: 'hm-rpc.0' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('not allowed'),
            f.fauxAssistantMessage(f.fauxToolCall('restart_instance', { instance: 'pi-agent.0' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('never'),
            f.fauxAssistantMessage(f.fauxToolCall('restart_instance', { instance: 'telegram.0' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('could not confirm'),
        ],
    });
    for (const text of ['restart hm-rpc', 'restart yourself']) {
        await call(agent, 'chatSend', { text });
        await settled(agent);
        assert.match(
            String((await call(agent, 'chatHistory')).entries.findLast(e => e.role === 'tool')?.detail?.result ?? ''),
            /not allowed/,
        );
    }
    // a voice assistant asks: no chat to confirm in, so the restart is refused
    await call(
        agent,
        'ask',
        { text: 'restart telegram', conversation: 'kitchen', requestId: 'r1' },
        { from: 'system.adapter.assistant.0', user: undefined },
    );
    assert.equal(db.objects[TELEGRAM].common.enabled, true);
    assert.ok(agent.logs.some(([, msg]) => msg.includes('restart_instance') && msg.includes('confirmation: unavailable')));
    await stopAgent(agent);
});

test('memory: remember keeps a fact for every conversation, forget removes it, the user may edit the list', async () => {
    const f = await faux();
    const prompts = [];
    const seeing = text => ctx => {
        prompts.push(JSON.stringify(ctx));
        return f.fauxAssistantMessage(text);
    };
    const { agent, db } = await startAgent({
        dataDir: tmp(),
        responses: [
            f.fauxAssistantMessage(f.fauxToolCall('remember', { fact: 'The living room lamp is hue.0.lamp3' }), {
                stopReason: 'toolUse',
            }),
            f.fauxAssistantMessage('Kept.'),
            seeing('I know the lamp.'),
            f.fauxAssistantMessage(f.fauxToolCall('forget', { fact: 'lamp3' }), { stopReason: 'toolUse' }),
            f.fauxAssistantMessage('Forgotten.'),
        ],
    });
    await call(agent, 'chatSend', { text: 'remember the lamp' });
    await settled(agent);
    const facts = JSON.parse(db.states[`${NAMESPACE}.memory.list`].val);
    assert.deepEqual(
        facts.map(fact => fact.text),
        ['The living room lamp is hue.0.lamp3'],
    );
    assert.equal(db.states[`${NAMESPACE}.memory.count`].val, 1);

    // another conversation (a voice assistant) sees the fact in its instructions
    await call(agent, 'ask', { text: 'which lamp?', conversation: 'kitchen' }, { from: 'system.adapter.assistant.0' });
    assert.ok(prompts[0].includes('The living room lamp is hue.0.lamp3'), 'the fact is part of the prompt');

    await call(agent, 'chatSend', { text: 'forget the lamp' });
    await settled(agent);
    assert.deepEqual(JSON.parse(db.states[`${NAMESPACE}.memory.list`].val), []);

    // the user edits memory.list: taken over, invalid entries dropped, confirmed with ack
    await agent.onStateChange(`${NAMESPACE}.memory.list`, {
        val: JSON.stringify([{ text: 'I go to bed at 23:00' }, { nope: 1 }]),
        ack: false,
    });
    assert.deepEqual(
        agent.memory.list().map(fact => fact.text),
        ['I go to bed at 23:00'],
    );
    assert.equal(db.states[`${NAMESPACE}.memory.list`].ack, true);
    await stopAgent(agent);
});

test('memory: switched off it keeps nothing; limits; empty and duplicate facts', async () => {
    const f = await faux();
    const { agent } = await startAgent({ dataDir: tmp(), responses: [f.fauxAssistantMessage('hi')] });
    const memory = agent.memory;
    assert.match(await memory.add('   '), /empty/);
    assert.match(await memory.add('x'.repeat(MAX_FACT_LENGTH + 1)), /at most/);
    assert.match(await memory.add('Coffee at 7'), /Kept as \[m/);
    assert.match(await memory.add('coffee AT 7'), /Already kept/);
    agent.config.longTermMemory = false;
    assert.match(await memory.add('Tea at 8'), /switched off/);
    assert.equal(memory.list().length, 1);
    assert.deepEqual(parseFacts('not json'), []);
    await stopAgent(agent);
});

test('memory: part of a backup and back after the restore', async () => {
    const f = await faux();
    const dataDir = tmp();
    const first = await startAgent({ dataDir, responses: [f.fauxAssistantMessage('hi')] });
    await first.agent.memory.add('Coffee at 7');
    await call(first.agent, 'chatSend', { text: 'hi' }); // a conversation, so there is a store to back up
    await settled(first.agent);
    const created = await call(first.agent, 'createBackup');
    assert.match(created.result, /Backup saved/);
    await first.agent.memory.replace([]);
    const list = await call(first.agent, 'listBackups');
    const manual = list.find(o => /by hand/.test(o.label)).value;
    await call(first.agent, 'restoreBackup', { file: manual });
    await stopAgent(first.agent);

    const second = await startAgent({ dataDir, responses: [f.fauxAssistantMessage('hi')] });
    assert.deepEqual(
        second.agent.memory.list().map(fact => fact.text),
        ['Coffee at 7'],
    );
    await stopAgent(second.agent);
});
