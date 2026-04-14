#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PLUGIN_DIR}/../.." && pwd)"

BOLD='\033[1m'
INFO='\033[38;2;136;146;176m'
SUCCESS='\033[38;2;0;229;204m'
WARN='\033[38;2;255;176;32m'
ERROR='\033[38;2;230;57;70m'
NC='\033[0m'

PLUGIN_ID="openclawcode"
PLUGIN_NAME="@grinev/opencode-telegram-bot"

check_build() {
    if [[ -f "${PLUGIN_DIR}/dist/extensions/openclawcode/src/openclaw-plugin.js" ]]; then
        return 0
    fi
    if [[ -f "${REPO_ROOT}/dist/extensions/openclawcode/src/openclaw-plugin.js" ]]; then
        return 0
    fi
    echo -e "${ERROR}Plugin not built. Run scripts/build.sh first${NC}"
    exit 1
}

check_openclaw() {
    if ! command -v openclaw &> /dev/null; then
        echo -e "${WARN}OpenClaw CLI not found in PATH${NC}"
        echo -e "${INFO}This plugin is a bundled plugin in the OpenClaw repo${NC}"
        echo -e "${INFO}It will be auto-discovered when OpenClaw is built from source${NC}"
        return 1
    fi
    return 0
}

is_bundled_plugin() {
    local repo_root
    repo_root="$(cd "${PLUGIN_DIR}/.." && pwd)"

    if [[ -f "${repo_root}/package.json" ]] && grep -q "openclaw" "${repo_root}/package.json" 2>/dev/null; then
        return 0
    fi
    return 1
}

install_as_bundled() {
    echo -e "${BOLD}Installing as bundled plugin...${NC}"
    echo -e "${INFO}OpenClawCode is a bundled plugin in the OpenClaw repository${NC}"
    echo -e "${INFO}No separate installation needed - it's auto-discovered${NC}"
    echo ""
    echo -e "${SUCCESS}Plugin location: ${PLUGIN_DIR}${NC}"
    echo ""
    echo -e "${BOLD}To enable the plugin:${NC}"
    echo -e "${INFO}1. Build OpenClaw: pnpm build (from repo root)${NC}"
    echo -e "${INFO}2. Enable in config: openclaw config set plugins.entries.${PLUGIN_ID}.enabled true${NC}"
    echo -e "${INFO}3. Configure: openclaw config set plugins.entries.${PLUGIN_ID}.config.<key> <value>${NC}"
    echo ""
    echo -e "${BOLD}Config keys:${NC}"
    echo -e "${INFO}  - opencodeBaseUrl: OpenCode server URL${NC}"
    echo -e "${INFO}  - opencodeUsername: Auth username${NC}"
    echo -e "${INFO}  - opencodePassword: Auth password${NC}"
    echo -e "${INFO}  - channels: Channel IDs to intercept${NC}"
    echo -e "${INFO}  - accountIds: Account IDs to intercept${NC}"
    echo -e "${INFO}  - conversationIds: Conversation IDs to intercept${NC}"
    echo -e "${INFO}  - defaultProjectDirectory: Default project path${NC}"
}

install_to_openclaw() {
    echo -e "${BOLD}Installing plugin to OpenClaw...${NC}"

    if ! check_openclaw; then
        return
    fi

    echo -e "${INFO}Checking OpenClaw version...${NC}"
    openclaw_version="$(openclaw --version || echo "unknown")"
    echo -e "${INFO}OpenClaw version: ${openclaw_version}${NC}"

    echo -e "${BOLD}Plugin options:${NC}"
    echo -e "${INFO}1. Bundled plugin (auto-discovered): Already available in repo${NC}"
    echo -e "${INFO}2. External plugin install: openclaw plugins install ${PLUGIN_NAME}${NC}"
    echo ""

    echo -e "${BOLD}Recommended: Use as bundled plugin${NC}"
    install_as_bundled
}

run_standalone() {
    echo -e "${BOLD}Running as standalone Telegram bot...${NC}"

    if [[ ! -f "${PLUGIN_DIR}/dist/cli.js" ]]; then
        echo -e "${ERROR}CLI not built. Run scripts/build.sh first${NC}"
        exit 1
    fi

    echo -e "${INFO}Starting OpenCode Telegram Bot...${NC}"
    echo -e "${INFO}Configuration wizard will guide you through setup${NC}"
    echo ""

    cd "${PLUGIN_DIR}"
    node dist/cli.js
}

show_help() {
    echo -e "${BOLD}OpenClawCode Install Script${NC}"
    echo ""
    echo "Usage: bash scripts/install.sh [command]"
    echo ""
    echo "Commands:"
    echo "  install    Show installation instructions (default)"
    echo "  standalone Run as standalone Telegram bot"
    echo "  help       Show this help message"
    echo ""
    echo -e "${BOLD}Notes:${NC}"
    echo "  - This plugin is bundled in OpenClaw repo and auto-discovered"
    echo "  - No separate npm install needed when using OpenClaw from source"
    echo "  - Can also run standalone as OpenCode Telegram Bot"
}

main() {
    command="${1:-install}"

    case "${command}" in
        install)
            check_build
            if is_bundled_plugin; then
                install_as_bundled
            else
                install_to_openclaw
            fi
            ;;
        standalone)
            check_build
            run_standalone
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo -e "${ERROR}Unknown command: ${command}${NC}"
            show_help
            exit 1
            ;;
    esac
}

main "$@"