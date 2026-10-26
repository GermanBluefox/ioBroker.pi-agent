# Older Changelog

### 0.0.2 (2026-10-25)

- Telegram answers keep their formatting: Markdown of the model is sent as Telegram HTML (bold, italic, code, links;
  tables as a monospace block), and Telegram chats are asked for short answers without tables
- Released through the CI workflow with npm provenance (trusted publishing)

### 0.0.1 (2026-10-25)

- Initial version: durable agent with the tools `search_objects`, `get_state`, `list_instances` and `set_state`
- Write allowlist and simulation mode; an interrupted write is never repeated; requests continue after a restart
- Telegram: talk to the agent through a telegram instance, with allowed users, prefix and one conversation per chat
- Providers: Anthropic, OpenAI, DeepSeek; every tool call is logged
