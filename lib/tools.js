'use strict';

const { isWriteAllowed } = require('./guard');

const MAX_RESULTS = 50;

/**
 * Plain text of an ioBroker name, which may be a translated object.
 *
 * @param {unknown} name common.name
 * @returns {string} name in English, else the first language
 */
function nameText(name) {
	if (name && typeof name === 'object') {
		const map = /** @type {Record<string, string>} */ (name);
		return map.en || Object.values(map)[0] || '';
	}
	return String(name ?? '');
}

/**
 * Convert the value of a tool call to the type the state declares.
 *
 * @param {string|number|boolean} val value from the model
 * @param {string|undefined} type common.type of the state
 * @returns {string|number|boolean} converted value
 */
function coerce(val, type) {
	if (type === 'boolean') {
		return typeof val === 'string' ? val.toLowerCase() === 'true' : Boolean(val);
	}
	if (type === 'number') {
		const n = Number(val);
		if (Number.isNaN(n)) {
			throw new Error(`Value "${val}" is not a number`);
		}
		return n;
	}
	if (type === 'string') {
		return String(val);
	}
	return val;
}

const text = t => ({ output: [{ type: 'text', text: t }] });

/**
 * Case-insensitive regular expression for a glob with "*".
 *
 * @param {string} glob pattern
 * @returns {RegExp} anchored expression
 */
function globToRegExp(glob) {
	const body = glob
		.split('*')
		.map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*');
	return new RegExp(`^${body}$`, 'i');
}

/**
 * Short, single-line rendering of tool arguments for the log.
 *
 * @param {unknown} args tool arguments
 * @param {number} [max] maximum length
 * @returns {string} shortened JSON
 */
function shortArgs(args, max = 160) {
	const s = JSON.stringify(args ?? {});
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Build the ioBroker extension: tools, system prompt section and the write guard.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter running adapter
 * @param {object} rt loaded pi-durable runtime ({ Type, defineExtension, defineTool, hook, section, ToolTask })
 * @param {() => { allowlist: RegExp[], dryRun: boolean, instructions: string }} policy live policy
 * @returns {object} extension for the registry
 */
function createIoBrokerExtension(adapter, rt, policy) {
	const { Type, defineExtension, defineTool, hook, section, ToolTask } = rt;
	const logCall = (name, args, outcome) => adapter.log.info(`Tool ${name} ${shortArgs(args)} -> ${outcome}`);

	/**
	 * State objects whose id (or name) matches a pattern. The object view is read from the literal prefix
	 * of the pattern and filtered here, because a pattern starting with "*" finds nothing through
	 * getForeignObjects on a real installation.
	 *
	 * @param {string} pattern glob with "*", or a plain word (then searched anywhere, case-insensitive)
	 * @returns {Promise<Record<string, ioBroker.Object>>} matching objects by id, sorted
	 */
	async function findStateObjects(pattern) {
		const glob = pattern.includes('*') ? pattern : `*${pattern}*`;
		const prefix = glob.slice(0, glob.indexOf('*'));
		const re = globToRegExp(glob);
		const view = await adapter.getObjectViewAsync('system', 'state', { startkey: prefix, endkey: `${prefix}香` });
		const result = {};
		for (const { id, value } of view?.rows || []) {
			if (value && (re.test(id) || re.test(nameText(value.common?.name)))) {
				result[id] = value;
			}
		}
		return result;
	}

	const searchObjects = defineTool({
		name: 'search_objects',
		description: `Find ioBroker states by ID pattern or name, e.g. "hm-rpc.0.*", "*Licht*" or just "Licht" (case-insensitive, also matches the name). Returns at most ${MAX_RESULTS} entries with id, name, role, type, unit and whether it is writable.`,
		parameters: Type.Object({ pattern: Type.String() }),
		replay: 'safe',
		execute: async args => {
			const objects = await findStateObjects(args.pattern);
			const ids = Object.keys(objects).sort();
			const rows = ids.slice(0, MAX_RESULTS).map(id => {
				const c = objects[id].common || {};
				return {
					id,
					name: nameText(c.name),
					role: c.role,
					type: c.type,
					unit: c.unit,
					write: c.write !== false,
				};
			});
			logCall('search_objects', args, `${ids.length} objects${ids.length > rows.length ? `, ${rows.length} shown` : ''}`);
			return text(JSON.stringify({ total: ids.length, shown: rows.length, rows }));
		},
	});

	const getState = defineTool({
		name: 'get_state',
		description: `Read the current value of one ioBroker state, or of all states matching a pattern with "*" (at most ${MAX_RESULTS}). A pattern only finds states that have an object; for adapter instances use list_instances.`,
		parameters: Type.Object({ id: Type.String() }),
		replay: 'safe',
		execute: async args => {
			if (args.id.includes('*')) {
				const found = Object.keys(await findStateObjects(args.id));
				const states = found.length ? (await adapter.getForeignStatesAsync(found)) || {} : {};
				const ids = found.filter(id => states[id]);
				const rows = ids.slice(0, MAX_RESULTS).map(id => ({ id, val: states[id].val, ack: states[id].ack, ts: states[id].ts }));
				logCall('get_state', args, `${ids.length} states${ids.length > rows.length ? `, ${rows.length} shown` : ''}`);
				return text(JSON.stringify({ total: ids.length, shown: rows.length, rows }));
			}
			const state = await adapter.getForeignStateAsync(args.id);
			if (!state) {
				logCall('get_state', args, 'no value');
				return text(`State ${args.id} does not exist or has no value.`);
			}
			logCall('get_state', args, `val=${shortArgs(state.val, 60)}`);
			return text(JSON.stringify({ val: state.val, ack: state.ack, ts: state.ts, lc: state.lc }));
		},
	});

	const listInstances = defineTool({
		name: 'list_instances',
		description:
			'List all adapter instances with title, version, mode, whether they are enabled, and their alive/connected state. Instances of mode "once" or "schedule" are not alive between runs; that is normal.',
		parameters: Type.Object({}),
		replay: 'safe',
		execute: async args => {
			// Start from the instance objects and read alive/connected by exact id: a pattern query
			// misses a state whose object is gone (seen with vis.0 on a real installation).
			const view = await adapter.getObjectViewAsync('system', 'instance', {
				startkey: 'system.adapter.',
				endkey: 'system.adapter.香',
			});
			const rows = [];
			for (const { id, value } of view?.rows || []) {
				const c = value?.common || {};
				const [alive, connected] = await Promise.all([
					adapter.getForeignStateAsync(`${id}.alive`),
					adapter.getForeignStateAsync(`${id}.connected`),
				]);
				rows.push({
					instance: id.replace('system.adapter.', ''),
					title: nameText(c.titleLang || c.title),
					version: c.version,
					mode: c.mode,
					enabled: c.enabled === true,
					alive: alive?.val ?? null,
					connected: connected?.val ?? null,
				});
			}
			const running = rows.filter(r => r.alive === true).length;
			logCall('list_instances', args, `${rows.length} instances, ${running} alive`);
			return text(JSON.stringify({ total: rows.length, running, rows }));
		},
	});

	const setState = defineTool({
		name: 'set_state',
		description:
			'Write a command (ack=false) to one ioBroker state. Only states on the write allowlist are accepted. After an interruption the call is NOT repeated: read the state again before trying once more.',
		parameters: Type.Object({
			id: Type.String(),
			val: Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
		}),
		// No replay: "safe" - a half-done write must never run twice after a crash.
		execute: async args => {
			const obj = await adapter.getForeignObjectAsync(args.id);
			if (!obj || obj.type !== 'state') {
				logCall('set_state', args, 'refused: no such state');
				throw new Error(`State ${args.id} does not exist`);
			}
			if (obj.common?.write === false) {
				logCall('set_state', args, 'refused: read-only');
				throw new Error(`State ${args.id} is read-only`);
			}
			const val = coerce(args.val, obj.common?.type);
			if (policy().dryRun) {
				logCall('set_state', args, 'dry run, not written');
				return text(
					`DRY RUN - NOTHING WAS WRITTEN. ${args.id} keeps its old value; it would have been set to ${JSON.stringify(val)}. Tell the user plainly that nothing was changed because dry run is on.`,
				);
			}
			await adapter.setForeignStateAsync(args.id, { val, ack: false });
			logCall('set_state', args, 'written');
			return text(`Command sent: ${args.id} = ${JSON.stringify(val)}`);
		},
	});

	return defineExtension({
		name: 'iobroker',
		sections: [
			section(
				'iobroker',
				() =>
					[
						'You control an ioBroker smart home through tools.',
						'Always look up state IDs with search_objects instead of guessing them.',
						'To read many values at once, call get_state with a "*" pattern. For questions about adapters or instances use list_instances.',
						'Read the current value before you change it. Only write what the user asked for.',
						'If a write was reported as interrupted, read the state first: the command may already have worked.',
						'Never claim that something was switched or changed unless set_state answered "Command sent".',
						policy().instructions,
					]
						.filter(Boolean)
						.join('\n'),
				{ tag: false },
			),
		],
		tools: [searchObjects, getState, listInstances, setState],
		hooks: [
			hook(ToolTask, {
				beforeTool: call => {
					if (call.name !== 'set_state') {
						return undefined;
					}
					const id = String(call.arguments?.id ?? '');
					if (!isWriteAllowed(id, policy().allowlist)) {
						adapter.log.warn(`Tool set_state ${shortArgs(call.arguments)} -> blocked: not on the write allowlist`);
						return { block: `State ${id} is not on the write allowlist. Tell the user instead of retrying.` };
					}
					return undefined;
				},
			}),
		],
	});
}

module.exports = { createIoBrokerExtension, nameText, coerce };
