'use strict';

// Child process for the crash test: asks the agent to switch a lamp and dies the hard way
// (exit 137, no unload) right after the write reached the state, before the tool result is stored.

const { startAgent, NAMESPACE } = require('./agent-harness');
const { CRASH_SEED, CRASH_CONFIG } = require('./crash-fixture');

async function main() {
    const dataDir = process.argv[2];
    const faux = await import('@earendil-works/pi-ai/providers/faux');
    const { agent } = await startAgent({
        dataDir,
        config: CRASH_CONFIG,
        seed: CRASH_SEED,
        responses: [
            faux.fauxAssistantMessage(faux.fauxToolCall('set_state', { id: 'x.0.lamp', val: true }), {
                stopReason: 'toolUse',
            }),
        ],
        hooks: {
            setForeignState: () => process.exit(137),
        },
    });
    agent.emit('stateChange', `${NAMESPACE}.chat.input`, { val: 'Switch the lamp on', ack: false, ts: 1 });
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
