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
PACKAGE_NAME="@luoyingwen/openclaw-opencode-plugin"

check_build() {
    if [[ ! -f "${PLUGIN_DIR}/dist/openclaw-plugin.js" ]]; then
        echo -e "${ERROR}Plugin not built. Run scripts/build.sh first${NC}"
        exit 1
    fi
}

check_openclaw() {
    if ! command -v openclaw &> /dev/null; then
        echo -e "${ERROR}OpenClaw CLI not found in PATH${NC}"
        echo -e "${INFO}Install OpenClaw first: npm install -g openclaw${NC}"
        exit 1
    fi
}

create_tarball() {
    echo -e "${BOLD}Creating npm tarball...${NC}" >&2
    cd "${PLUGIN_DIR}"
    local output
    output=$(npm pack 2>&1)
    local tarball
    tarball=$(echo "${output}" | grep -E "^[a-zA-Z0-9].*\.tgz$" | tail -1)
    if [[ -z "${tarball}" ]]; then
        echo -e "${ERROR}Failed to create tarball${NC}" >&2
        exit 1
    fi
    echo -e "${SUCCESS}Created: ${tarball}${NC}" >&2
    echo "${tarball}"
}

install_local() {
    echo -e "${BOLD}Installing plugin locally for testing...${NC}"
    echo ""
    
    check_build
    check_openclaw
    
    rm -rf ~/.openclaw/extensions/.openclaw-install-stage-* 2>/dev/null || true
    
    local tarball_filename
    tarball_filename=$(create_tarball)
    local tarball_path="${PLUGIN_DIR}/${tarball_filename}"
    
    echo ""
    echo -e "${INFO}Installing from tarball: ${tarball_path}${NC}"
    
    openclaw plugins install --force "${tarball_path}" 2>&1 | grep -v "install-stage" || true
    
    rm -rf ~/.openclaw/extensions/.openclaw-install-stage-* 2>/dev/null || true
    
    echo ""
    echo -e "${SUCCESS}Local installation complete!${NC}"
    echo ""
    echo -e "${BOLD}Enable the plugin:${NC}"
    echo -e "${INFO}  openclaw config set plugins.entries.${PLUGIN_ID}.enabled true${NC}"
    echo ""
    echo -e "${BOLD}Optional configuration:${NC}"
    echo -e "${INFO}  openclaw config set plugins.entries.${PLUGIN_ID}.config.opencodeBaseUrl \"http://localhost:4096\"${NC}"
    
    rm -f "${tarball_path}"
}

install_link() {
    echo -e "${BOLD}Linking plugin locally for testing...${NC}"
    echo ""
    
    check_build
    check_openclaw
    
    rm -rf ~/.openclaw/extensions/.openclaw-install-stage-* 2>/dev/null || true
    
    echo -e "${INFO}Linking from: ${PLUGIN_DIR}${NC}"
    openclaw plugins install --link --force "${PLUGIN_DIR}"
    
    rm -rf ~/.openclaw/extensions/.openclaw-install-stage-* 2>/dev/null || true
    
    echo ""
    echo -e "${SUCCESS}Linked installation complete!${NC}"
    echo -e "${WARN}Note: Linked plugins use live source - rebuild to update${NC}"
    echo ""
    echo -e "${BOLD}Enable the plugin:${NC}"
    echo -e "${INFO}  openclaw config set plugins.entries.${PLUGIN_ID}.enabled true${NC}"
}

show_info() {
    check_build
    
    echo -e "${BOLD}OpenClawCode Plugin${NC}"
    echo ""
    echo -e "${INFO}OpenCode integration for OpenClaw channels${NC}"
    echo ""
    echo -e "${BOLD}Local testing:${NC}"
    echo -e "${SUCCESS}  bash scripts/install.sh local${NC}"
    echo -e "${INFO}  - Install from tarball for integration testing${NC}"
    echo ""
    echo -e "${SUCCESS}  bash scripts/install.sh link${NC}"
    echo -e "${INFO}  - Link source directory (--link mode)${NC}"
    echo ""
    echo -e "${BOLD}Publishing to npm:${NC}"
    echo -e "${INFO}  npm publish --access public${NC}"
    echo ""
    echo -e "${BOLD}Installing from npm:${NC}"
    echo -e "${SUCCESS}  openclaw plugins install ${PACKAGE_NAME}${NC}"
    echo ""
    echo -e "${BOLD}Configuration (all optional):${NC}"
    echo -e "${INFO}  opencodeBaseUrl: OpenCode server URL (default: http://localhost:4096)${NC}"
    echo -e "${INFO}  channels/accountIds/conversationIds: Scope filters (empty = all)${NC}"
}

dry_run_publish() {
    echo -e "${BOLD}Dry run: checking package contents${NC}"
    echo ""
    cd "${PLUGIN_DIR}"
    npm pack --dry-run
}

show_help() {
    echo -e "${BOLD}OpenClawCode Install Script${NC}"
    echo ""
    echo "Usage: bash scripts/install.sh [command]"
    echo ""
    echo "Commands:"
    echo "  info       Show installation info (default)"
    echo "  local      Install locally from tarball"
    echo "  link       Link locally (--link mode)"
    echo "  publish    Dry run npm pack"
    echo "  help       Show this help"
}

main() {
    command="${1:-info}"
    
    case "${command}" in
        info)
            show_info
            ;;
        local)
            install_local
            ;;
        link)
            install_link
            ;;
        publish)
            check_build
            dry_run_publish
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