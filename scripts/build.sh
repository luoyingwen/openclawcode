#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

NODE_MIN_MAJOR=20

BOLD='\033[1m'
INFO='\033[38;2;136;146;176m'
SUCCESS='\033[38;2;0;229;204m'
ERROR='\033[38;2;230;57;70m'
NC='\033[0m'

check_node_version() {
    if ! command -v node &> /dev/null; then
        echo -e "${ERROR}Node.js is not installed. Please install Node.js ${NODE_MIN_MAJOR}+${NC}"
        exit 1
    fi

    node_version="$(node --version | sed 's/^v//')"
    major_version="$(echo "${node_version}" | cut -d. -f1)"

    if [[ "${major_version}" -lt "${NODE_MIN_MAJOR}" ]]; then
        echo -e "${ERROR}Node.js version ${node_version} is too old. Please upgrade to ${NODE_MIN_MAJOR}+${NC}"
        exit 1
    fi

    echo -e "${INFO}Node.js version: ${node_version}${NC}"
}

check_npm() {
    if ! command -v npm &> /dev/null; then
        echo -e "${ERROR}npm is not installed${NC}"
        exit 1
    fi
    echo -e "${INFO}npm version: $(npm --version)${NC}"
}

install_deps() {
    echo -e "${BOLD}Installing dependencies...${NC}"
    (cd "${PLUGIN_DIR}" && npm install --ignore-scripts)
    echo -e "${SUCCESS}Dependencies installed${NC}"
}

build_plugin() {
    echo -e "${BOLD}Building OpenClawCode plugin...${NC}"
    cd "${PLUGIN_DIR}"
    npm run build
    echo -e "${SUCCESS}Build complete${NC}"
}

verify_build() {
    echo -e "${BOLD}Verifying build output...${NC}"

    if [[ ! -f "${PLUGIN_DIR}/dist/openclaw-plugin.js" ]]; then
        echo -e "${ERROR}Missing: dist/openclaw-plugin.js${NC}"
        exit 1
    fi

    echo -e "${INFO}Found: dist/openclaw-plugin.js${NC}"
    echo -e "${SUCCESS}Build verification passed${NC}"
}

show_next_steps() {
    echo ""
    echo -e "${SUCCESS}Build successful!${NC}"
    echo -e "${INFO}Plugin directory: ${PLUGIN_DIR}${NC}"
    echo ""
    echo -e "${BOLD}Next steps:${NC}"
    echo -e "${INFO}1. Install locally: bash scripts/install.sh local${NC}"
    echo -e "${INFO}2. Publish to npm: npm publish --access public${NC}"
}

main() {
    echo -e "${BOLD}OpenClawCode Build Script${NC}"
    echo ""

    check_node_version
    check_npm
    install_deps
    build_plugin
    verify_build
    show_next_steps
}

main "$@"