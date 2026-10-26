# Older Changelog

### 0.0.1 (2026-10-25)

- Initial version: durable agent with the tools `search_objects`, `get_state`, `list_instances` and `set_state`
- Write allowlist and simulation mode; an interrupted write is never repeated; requests continue after a restart
- Telegram: talk to the agent through a telegram instance, with allowed users, prefix and one conversation per chat
- Providers: Anthropic, OpenAI, DeepSeek; every tool call is logged
