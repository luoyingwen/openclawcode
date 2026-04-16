# OpenClawCode Plugin

OpenClaw plugin for OpenCode integration. Intercepts channel messages and routes them to OpenCode server.

## Prerequisites

Before using this plugin, you must start OpenCode with the serve parameter:

```bash
opencode serve
```

This starts the OpenCode server at `http://localhost:4096` (by default), which this plugin connects to.

## Features

- Intercepts OpenClaw channel messages and routes to OpenCode
- Session and project management
- Agent and model selection
- Progress tracking for coding tasks (thinking, tool execution)
- Scheduled task creation and management
- Permission request handling
- Multi-language support (en, zh, zh-TW, de, es, fr, ru)

## Installation

### From npm (recommended)

```bash
openclaw plugins install @luoyingwen/openclaw-opencode-plugin
```

### Local testing

```bash
# Build
bash scripts/build.sh

# Install locally
bash scripts/install.sh local

# Enable
openclaw config set plugins.entries.openclawcode.enabled true
```

## Configuration

### Required

```bash
# Enable plugin (required - plugin is disabled by default)
openclaw config set plugins.entries.openclawcode.enabled true
```

### Optional

```bash
# Set OpenCode server URL (default: http://localhost:4096)
openclaw config set plugins.entries.openclawcode.config.opencodeBaseUrl "http://localhost:4096"

# Set interface language (default: en)
openclaw config set plugins.entries.openclawcode.config.locale zh

# Set default project directory
openclaw config set plugins.entries.openclawcode.config.defaultProjectDirectory "/path/to/project"

# Scope filters (empty = all channels/accounts/conversations)
openclaw config set plugins.entries.openclawcode.config.channels '["telegram", "discord"]'
openclaw config set plugins.entries.openclawcode.config.accountIds '["account1"]'
openclaw config set plugins.entries.openclawcode.config.conversationIds '["conv1"]'
```

## Commands

### Intercept Mode Commands

| Command     | Description                                         |
| ----------- | --------------------------------------------------- |
| `/opencode` | Enter OpenCode intercept mode for this conversation |
| `/exit`     | Leave OpenCode intercept mode                       |

### OpenCode Commands (require intercept mode)

| Command                     | Description                                                            |
| --------------------------- | ---------------------------------------------------------------------- |
| `/help`                     | Show available commands                                                |
| `/status`                   | Show OpenCode health and current plugin state                          |
| `/projects`                 | List OpenCode projects                                                 |
| `/project <number or path>` | Select a project by number or absolute path                            |
| `/sessions`                 | List sessions in current project                                       |
| `/session <number>`         | Select a session by number                                             |
| `/agents`                   | List available agents                                                  |
| `/agent <number>`           | Select an agent by number                                              |
| `/models`                   | List available models                                                  |
| `/model <number>`           | Select a model by number                                               |
| `/new`                      | Create and select a new OpenCode session                               |
| `/rename`                   | Rename current session (interactive - prompts for new title)           |
| `/stop`                     | Abort current session or cancel active flow (task, rename, permission) |
| `/task`                     | Start scheduled task creation flow                                     |
| `/tasklist`                 | View and manage scheduled tasks                                        |
| `/permission`               | Show pending permission request or risk status                         |
| `/commands`                 | List project commands exposed by OpenCode                              |

### Permission Replies

When a permission request appears, reply with:

| Reply | Action       |
| ----- | ------------ |
| `/1`  | Allow once   |
| `/2`  | Always allow |
| `/3`  | Reject       |

## Usage Flow

1. Enter intercept mode: `/opencode`
2. Select or create project: `/projects` → `/project 1` or `/project /path/to/dir`
3. Select or create session: `/sessions` → `/session 1` or `/new`
4. Send messages to OpenCode (all non-command messages are forwarded)
5. Exit intercept mode: `/exit`

## Progress Indicators

When processing messages, you'll see:

- `正在处理...` (Processing) - Initial response with intercept mode hint
- `💭 思考中...` (Thinking) - AI is reasoning
- Tool execution progress - Shows running tool calls

## License

MIT
