#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BOLD='\033[1m'
INFO='\033[38;2;136;146;176m'
SUCCESS='\033[38;2;0;229;204m'
WARN='\033[38;2;255;176;32m'
ERROR='\033[38;2;230;57;70m'
NC='\033[0m'

PLUGIN_ID="openclawcode"
PACKAGE_NAME="@grinev/opencode-telegram-bot"

check_build() {
    if [[ ! -f "${PLUGIN_DIR}/dist/openclaw-plugin.js" ]]; then
        echo -e "${ERROR}Plugin not built. Run scripts/build.sh first${NC}"
        exit 1
    fi
}

check_npm_auth() {
    if ! npm whoami 2>&1 | grep -q "@"; then
        echo -e "${WARN}Not logged in to npm${NC}"
        echo -e "${INFO}Run: npm login${NC}"
        return 1
    fi
    return 0
}

show_publish_info() {
    echo -e "${BOLD}Publishing to npm${NC}"
    echo ""
    echo -e "${INFO}Steps to publish:${NC}"
    echo -e "${INFO}1. Build: npm run build${NC}"
    echo -e "${INFO}2. Login: npm login${NC}"
    echo -e "${INFO}3. Publish: npm publish --access public${NC}"
    echo ""
    echo -e "${BOLD}Or use npm release scripts:${NC}"
    echo -e "${INFO}  npm run release:prepare  - Prepare stable release${NC}"
    echo -e "${INFO}  npm run release:rc       - Prepare RC release${NC}"
}

show_install_info() {
    echo ""
    echo -e "${BOLD}Installing from npm${NC}"
    echo ""
    echo -e "${INFO}After publishing, users can install:${NC}"
    echo -e "${SUCCESS}  openclaw plugins install ${PACKAGE_NAME}${NC}"
    echo ""
    echo -e "${BOLD}Configuration (all optional, have defaults):${NC}"
    echo -e "${INFO}  openclaw config set plugins.entries.${PLUGIN_ID}.enabled true${NC}"
    echo -e "${INFO}  openclaw config set plugins.entries.${PLUGIN_ID}.config.opencodeBaseUrl \"http://localhost:4096\"${NC}"
    echo ""
    echo -e "${BOLD}Config options:${NC}"
    echo -e "${INFO}  - opencodeBaseUrl: OpenCode server URL (default: http://localhost:4096)${NC}"
    echo -e "${INFO}  - opencodeUsername: Auth username${NC}"
    echo -e "${INFO}  - opencodePassword: Auth password${NC}"
    echo -e "${INFO}  - channels: Channel IDs to intercept (empty = all)${NC}"
    echo -e "${INFO}  - accountIds: Account IDs to intercept (empty = all)${NC}"
    echo -e "${INFO}  - conversationIds: Conversation IDs (empty = all)${NC}"
    echo -e "${INFO}  - defaultProjectDirectory: Default project path${NC}"
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

dry_run_publish() {
    echo -e "${BOLD}Dry run: checking what would be published${NC}"
    echo ""
    npm pack --dry-run
}

show_help() {
    echo -e "${BOLD}OpenClawCode Install/Publish Script${NC}"
    echo ""
    echo "Usage: bash scripts/install.sh [command]"
    echo ""
    echo "Commands:"
    echo "  info       Show publish and install instructions (default)"
    echo "  publish    Dry run npm pack to check package contents"
    echo "  standalone Run as standalone Telegram bot"
    echo "  help       Show this help message"
    echo ""
    echo -e "${BOLD}Workflow:${NC}"
    echo "  1. Build: npm run build"
    echo "  2. Publish: npm publish --access public"
    echo "  3. Users install: openclaw plugins install ${PACKAGE_NAME}"
}

main() {
    command="${1:-info}"
    
    case "${command}" in
        info)
            check_build
            show_publish_info
            show_install_info
            ;;
        publish)
            check_build
            dry_run_publish
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