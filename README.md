# OpenClawCode Plugin

OpenClaw plugin for OpenCode integration. Intercepts channel messages and routes them to OpenCode server.

## Features

- Intercepts OpenClaw channel messages
- Routes commands to OpenCode server
- Supports session/project management
- Progress tracking for coding tasks

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

All configuration is optional:

```bash
# Enable plugin
openclaw config set plugins.entries.openclawcode.enabled true

# Set OpenCode server URL (default: http://localhost:4096)
openclaw config set plugins.entries.openclawcode.config.opencodeBaseUrl "http://localhost:4096"

# Scope filters (empty = all)
openclaw config set plugins.entries.openclawcode.config.channels '["telegram", "discord"]'
```

## Commands

When the plugin is enabled and you enter intercept mode (send "进入opencode"), the following commands are available:

- `/status` - Show OpenCode status
- `/projects [index]` - List/select projects
- `/sessions [index]` - List/select sessions
- `/new` - Create new session
- `/abort` - Abort current session
- `/commands` - Show available commands
- `离开opencode` - Exit intercept mode

## License

MIT
