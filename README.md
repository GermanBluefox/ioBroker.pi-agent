![Logo](admin/pi-agent.png)

# ioBroker.pi-agent

[![NPM version](https://img.shields.io/npm/v/iobroker.pi-agent.svg)](https://www.npmjs.com/package/iobroker.pi-agent)
[![Downloads](https://img.shields.io/npm/dm/iobroker.pi-agent.svg)](https://www.npmjs.com/package/iobroker.pi-agent)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.pi-agent.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.pi-agent.png?downloads=true)](https://nodei.co/npm/iobroker.pi-agent/)

![Test and Release](https://github.com/sadam6752-tech/ioBroker.pi-agent/workflows/Test%20and%20Release/badge.svg)

A language model agent for ioBroker that survives restarts and crashes. It is built on
[Pi Durable](https://earendil.com/posts/pi-durable/): every model call and tool call is stored as a checkpoint
before it runs, so an interrupted request continues after the adapter starts again instead of starting over.

## What it does

- Reads and searches states through the tools `search_objects`, `get_state` (one id or a `*` pattern) and
  `list_instances`. These tools may be repeated safely.
- `list_instances` starts from the instance objects and reads `alive` and `connected` of each instance by its exact id.
  A `*` pattern only finds states that have an object, so a stale `alive` value of an instance whose state object is
  gone is missing from a pattern query but not from `list_instances`.
- Logs every tool call as one line: `Tool <name> <arguments> -> <outcome>` (blocked writes as a warning).
- Writes states through `set_state`. This tool is **never repeated** after an interruption: the model is told that the
  call was interrupted and checks the actual value first. A light cannot be switched twice by a restart.
- Writes only to states on the **write allowlist**. Everything else is blocked before it runs.
- Answers each request exactly once. The request id is derived from the triggering state, so a repeated trigger finds the
  original request.

## Requirements

- Node.js 22.19.0 or newer, js-controller 6.0.11 or newer, admin 7.6.20 or newer.
- An API key of the chosen provider: Anthropic, OpenAI or DeepSeek.
- The adapter runs as its own process (not in compact mode). It keeps long-running model requests and a conversation
  store open, and its dependencies are large; running it apart keeps a fault or a memory peak away from other adapters.
  The API key is kept in memory of this instance only and is never put into the process environment.

## Configuration

| Setting         | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| Provider, Model | The language model. The model field lists the models of the chosen provider (the instance must be running for the list); any other model ID can be typed in. Empty: the default of the provider (`claude-sonnet-5-5`, `gpt-6-sol`, `deepseek-flash`). |
| API key         | Stored encrypted.                                                                |
| Dry run         | On by default. Write requests are logged and answered, but not executed.         |
| Write allowlist | One regular expression per line. Empty means the agent cannot write anything.   |
| Confirmation required | One regular expression per line. A write to a matching state is done only after the user confirms it with a button in Telegram. |
| Time zone       | IANA name such as `Europe/Berlin` for reminders, `get_time` and history times. Empty: the time zone of the ioBroker server. |
| History instance | `history`, `sql` or `influxdb` instance for `get_history`. Empty: the default history of the system settings. |
| Instructions    | Text appended to the system prompt, for example room names and house rules.     |
| Telegram instance | A `telegram` instance whose bot talks to the agent. Empty: Telegram is not used. |
| Prefix          | Only messages that start with it go to the agent, e.g. `/ai`. Empty: every message of an allowed user. |
| Allowed Telegram users | Telegram user ID, user name or first name (as in the telegram adapter), one per line. Messages from anyone else are ignored. |

Example allowlist:

```
^hm-rpc\.0\.Wohnzimmer\.
^javascript\.0\.agent\.
```

Start with dry run on, watch the log, and only then switch it off.

## Usage

Write a text to `pi-agent.0.chat.input`. The answer appears in `pi-agent.0.chat.answer`. From a script:

```js
sendTo('pi-agent.0', 'ask', { text: 'Is the living room light on?' }, result => log(result.answer));
```

The answer of a `sendTo` request comes back only through the callback (`result.answer`, or `result.error`); it is not
written to `chat.answer`.

`pi-agent.0.chat.pending` lists the requests that were accepted but not answered yet. If the adapter stops in the
middle, they continue on the next start. The answer of a request from `chat.input` or `sendTo` is then written to
`chat.answer` (the `sendTo` caller is no longer waiting), the answer of a Telegram request goes to its chat. A
`sendTo` caller that was interrupted gets `{ error: "Interrupted by shutdown; the request continues after the next start" }`.

### Confirmation, reminders, history, usage

- **Confirmation:** a write to a state on the "Confirmation required" list is asked in the Telegram chat of the
  conversation with ✅/❌ buttons. Only "Yes" lets it happen; "No", no answer, or a request that did not come from
  Telegram blocks it. The answer is stored with the call, so a restart does not ask twice. In dry run nothing is
  written, so nothing is asked.
- **Reminders:** `remind_me` sends a message later (at most 7 days ahead) to the chat of the conversation, or to
  `chat.answer`. The reminder waits in the conversation store and survives restarts.
- **History:** `get_history` reads past values (up to 31 days, averaged to at most 200 values) from the history
  instance.
- **Usage:** `pi-agent.0.usage.*` shows input, output and total tokens and the cost in USD over all conversations
  (the cost needs prices in the model catalog; it can stay 0 for a provider without them), `usage.json` per model.

### Telegram

Select a `telegram` instance, enter the allowed users and, if the bot also serves other scripts, a prefix such as
`/ai`. Then write to the bot: `/ai Is the living room light on?`

- Every chat has its own conversation with its own history; `pi-agent.0.telegram.chats` maps chat ids to them.
- Messages from users who are not on the list are ignored and logged as a warning. An empty list allows nobody.
- A first name such as `Alex` counts only for users the telegram adapter knows (authenticated there), because anybody
  can choose any first name in Telegram. Two known users with the same first name are both allowed; use the user name
  or the ID to tell them apart.
- A message that the telegram adapter delivers twice is answered once.
- Long answers are split into several messages.

### DeepSeek

Select **DeepSeek** as provider and enter a key from the DeepSeek platform. Available models: `deepseek-flash`
(default, fast) and `deepseek-v4-pro`. Requests go to `https://api.deepseek.com`.

## Security

- The model decides which tools to call. The allowlist and the dry run are your protection, not the prompt.
- The text of your requests and the values the agent reads are sent to the provider. Do not give it access to states
  that contain secrets.
- The conversations are stored unencrypted in the instance data directory (`session.sqlite`, SQLite built into
  Node.js). An installation that still has the JSONL store of version 0.0.1/0.0.2 (folder `session`) switches to
  SQLite at the first start without pending requests; the old folder is renamed to `session.jsonl-<date>` and kept.
  Earlier history is not carried over, and the Telegram chats start new conversations.

## Changelog

### 0.0.5 (2026-10-26)

- Model field: a list of the models of the chosen provider, a model ID can still be typed in
- Fix: sendTo (e.g. `ask` from scripts, the model list) never reached the adapter, because `supportedMessages: {custom: false}` switched the message box off; the outdated key is removed from the instance at the first start, which restarts the instance once

### 0.0.4 (2026-10-26)

- Writes can require a confirmation with buttons in Telegram ("Confirmation required")
- New tool `remind_me`: reminders that survive restarts
- New tool `get_history`: past values from the history, sql or influxdb instance
- Token use and cost in `usage.*`
- Time zone setting: `remind_me` reads local times ("18:00", "27.10. 18:00"), answers and history are in local time, new tool `get_time`

### 0.0.3 (2026-10-26)

- Conversations are stored in SQLite instead of JSONL, which kept the whole history in memory
- Every conversation has its own queue: Telegram chats no longer wait for each other
- An answer that would give broken HTML is sent to Telegram as plain text; a quote in a link URL is escaped

### 0.0.2 (2026-10-25)

- Telegram answers keep their formatting: Markdown of the model is sent as Telegram HTML (bold, italic, code, links;
  tables as a monospace block), and Telegram chats are asked for short answers without tables
- Released through the CI workflow with npm provenance (trusted publishing)

### 0.0.1 (2026-10-25)

- Initial version: durable agent with the tools `search_objects`, `get_state`, `list_instances` and `set_state`
- Write allowlist and dry run; an interrupted write is never repeated; requests continue after a restart
- Telegram: talk to the agent through a telegram instance, with allowed users, prefix and one conversation per chat
- Providers: Anthropic, OpenAI, DeepSeek; every tool call is logged

## License

MIT License

Copyright (c) 2026 Alex <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to
whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
