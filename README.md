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
- Writes only to states the **write permissions** allow. Everything else is blocked before it runs.
- Answers each request exactly once. The request id is derived from the triggering state, so a repeated trigger finds the
  original request.

## Requirements

- Node.js 22.19.0 or newer, js-controller 6.0.11 or newer, admin 7.6.20 or newer.
- An API key of the chosen provider: Anthropic, OpenAI or DeepSeek.
- The adapter runs as its own process (not in compact mode). It keeps long-running model requests and a conversation
  store open, and its dependencies are large; running it apart keeps a fault or a memory peak away from other adapters.
  The API key is kept in memory of this instance only and is never put into the process environment.

## Configuration

The settings have three tabs: **General**, **Write permissions** and **Messengers**.

| Setting         | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| Provider, Model | The language model. The model field lists the models of the chosen provider (the instance must be running for the list); any other model ID can be typed in. Empty: the default of the provider (`claude-sonnet-5-5`, `gpt-6-sol`, `deepseek-flash`). |
| API key         | Stored encrypted.                                                                |
| Simulation mode (nothing is switched) | On by default. The agent says what it would switch, but no state is written. |
| Write permissions | Table, one row per scope: an instance or object ID (`hm-rpc.0` covers everything below it) or a pattern with `*` (`hm-rpc.0.*.STATE`), with the checkboxes "Write allowed" and "Confirmation required". **Add installed instances** adds a row for every installed instance that has none, with nothing allowed yet. States that match no row can only be read. |
| Write allowlist, Confirmation required | Under "Advanced": regular expressions, one per line, in addition to the table (the settings of 0.0.5 and earlier keep working). |
| Time zone       | IANA name such as `Europe/Berlin` for reminders, `get_time` and history times. Empty: the time zone of the ioBroker server. |
| History instance | `history`, `sql` or `influxdb` instance for `get_history`. Empty: the default history of the system settings. |
| Instructions    | Text appended to the system prompt, for example room names and house rules.     |
| Messengers      | Table, one row per `telegram` or `max` instance (bot): active, instance, allowed users, prefix. No row: no messenger is used. |
| ↳ Allowed users | User ID, user name or first name (as in the messenger adapter), separated by commas. Messages from anyone else are ignored. |
| ↳ Prefix        | Only messages that start with it go to the agent, e.g. `/ai`. Empty: every message of an allowed user. |

Example of the table "Write permissions":

| Scope                  | Write allowed | Confirmation required |
| ---------------------- | ------------- | --------------------- |
| `hm-rpc.0.Wohnzimmer`  | ✓             |                       |
| `zigbee.0.*.lock`      | ✓             | ✓                     |
| `javascript.0.agent`   | ✓             |                       |

The same as regular expressions under "Advanced":

```
^hm-rpc\.0\.Wohnzimmer\.
^zigbee\.0\..*\.lock$
^javascript\.0\.agent\.
```

Start with simulation mode on, watch the log, and only then switch it off.

## Usage

### Chat in the admin

The menu entry **Pi Agent** on the left side of the admin opens a chat with the agent:

- Every ioBroker user has a conversation of their own; **New conversation** starts over.
- The answer is shown formatted, with the tool calls of the agent above it.
- A write on the "Confirmation required" list is asked in the chat with ✅/❌ buttons.
- A request keeps running when the page is closed; the answer is in the chat when it is opened again.
- Reminders of the conversation appear in the chat (kept until the adapter restarts).

### States and scripts

Write a text to `pi-agent.0.chat.input`. The answer appears in `pi-agent.0.chat.answer`. From a script:

```js
sendTo('pi-agent.0', 'ask', { text: 'Is the living room light on?' }, result => log(result.answer));
```

The answer of a `sendTo` request comes back only through the callback (`result.answer`, or `result.error`); it is not
written to `chat.answer`.

`pi-agent.0.chat.pending` lists the requests that were accepted but not answered yet. If the adapter stops in the
middle, they continue on the next start. The answer of a request from `chat.input` or `sendTo` is then written to
`chat.answer` (the `sendTo` caller is no longer waiting), the answer of a messenger request goes to its chat. A
`sendTo` caller that was interrupted gets `{ error: "Interrupted by shutdown; the request continues after the next start" }`.

### Confirmation, reminders, history, usage

- **Confirmation:** a write to a state on the "Confirmation required" list is asked in the messenger chat or in the
  admin chat of the conversation with ✅/❌ buttons. Only "Yes" lets it happen; "No", no answer (10 minutes), or a request that did not
  come from a messenger blocks it. The answer is stored with the call, so a restart does not ask twice. In simulation mode nothing is
  written, so nothing is asked.
- **Reminders:** `remind_me` sends a message later (at most 7 days ahead) to the chat of the conversation, or to
  `chat.answer`. The reminder waits in the conversation store and survives restarts.
- **History:** `get_history` reads past values (up to 31 days, averaged to at most 200 values) from the history
  instance.
- **Usage:** `pi-agent.0.usage.*` shows input, output and total tokens and the cost in USD over all conversations
  (the cost needs prices in the model catalog; it can stay 0 for a provider without them), `usage.json` per model.

### Messengers: Telegram and MAX

Add a row to the table "Messengers" with **+**, select a `telegram` or `max` instance, enter the allowed users and,
if the bot also serves other scripts, a prefix such as `/ai`. Then write to the bot: `/ai Is the living room light on?`
Messenger adapters that can only send (e.g. WhatsApp, Signal, Pushover) cannot be used for a chat.

- Several bots can talk to the agent, each with its own users and prefix. Answers, confirmations and reminders go back
  through the bot the request came from.
- Every chat has its own conversation with its own history; `pi-agent.0.telegram.chats` maps `<instance>/<chat id>`
  to them.
- Settings of 0.0.5 and earlier (one instance in single fields) are moved into the table at the first start, which
  restarts the instance once. Existing chats keep their conversation.
- Messages from users who are not on the list are ignored and logged as a warning. An empty list allows nobody.
- A first name such as `Alex` counts only for users the messenger adapter knows (authenticated in the telegram
  adapter, `max.0.users.<id>` in the max adapter), because anybody can choose any first name. Two known users with the same first name are both allowed; use the user name
  or the ID to tell them apart.
- A message that the messenger adapter delivers twice is answered once.
- Long answers are split into several messages.
- **Telegram:** Markdown of the model is sent as Telegram HTML (bold, italic, code, links).
- **MAX** (adapter `max` 0.1.12 or newer): answers are plain text. In a private dialog the answer goes to the user, in
  a group to the group. MAX has no "ask", so a confirmation sends callback buttons; the pressed button comes back as
  `communicate.request`, is answered with `answerCallback` and never reaches the model.

### DeepSeek

Select **DeepSeek** as provider and enter a key from the DeepSeek platform. Available models: `deepseek-flash`
(default, fast) and `deepseek-v4-pro`. Requests go to `https://api.deepseek.com`.

## Security

- The model decides which tools to call. The write permissions and the simulation mode are your protection, not the prompt.
- The text of your requests and the values the agent reads are sent to the provider. Do not give it access to states
  that contain secrets.
- The conversations are stored unencrypted in the instance data directory (`session.sqlite`, SQLite built into
  Node.js). An installation that still has the JSONL store of version 0.0.1/0.0.2 (folder `session`) switches to
  SQLite at the first start without pending requests; the old folder is renamed to `session.jsonl-<date>` and kept.
  Earlier history is not carried over, and the messenger chats start new conversations.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.2.0 (2026-10-26)

- Chat in the admin: the menu entry "Pi Agent" opens a chat with the agent, one conversation per ioBroker user, with tool calls, confirmation buttons and reminders

### 0.1.0 (2026-10-26)

- Messengers: a table with one row per bot (active, instance, allowed users, prefix), for several Telegram instances and the MAX messenger (adapter `max`); the Telegram settings of 0.0.5 are moved into it at the first start
- Confirmations and reminders go back through the bot the request came from
- Allowed users can be separated by commas
- Write permissions: a table of scopes (instance, object ID or pattern with `*`) with the checkboxes "Write allowed" and "Confirmation required", and a button that adds the installed instances; the regular expressions stay under "Advanced"
- The settings have three tabs: General, Write permissions, Messengers
- "Dry run" is now called "Simulation mode (nothing is switched)"

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

Older changelog entries can be found in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

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
