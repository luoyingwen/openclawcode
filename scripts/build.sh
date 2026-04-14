#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

NODE_MIN_MAJOR=20

BOLD='\033[1m'
INFO='\033[38;2;136;146;176m'
SUCCESS='\033[38;2;0;229;204m'
WARN='\033[38;2;255;176;32m'
ERROR='\033[38;2;230;57;70m'
NC='\033[0m'

detect_repo_root() {
    local parent_dir
    parent_dir="$(cd "${PLUGIN_DIR}/.." && pwd)"
    local grandparent_dir
    grandparent_dir="$(cd "${parent_dir}/.." && pwd)"

    if [[ -f "${grandparent_dir}/pnpm-workspace.yaml" ]] && [[ -f "${grandparent_dir}/package.json" ]]; then
        REPO_ROOT="${grandparent_dir}"
        IS_BUNDLED_PLUGIN=1
    else
        REPO_ROOT=""
        IS_BUNDLED_PLUGIN=0
    fi
}

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

check_dependencies() {
    if ! command -v node &> /dev/null; then
        echo -e "${ERROR}node is not installed${NC}"
        exit 1
    fi
}

get_pnpm() {
    if command -v pnpm &> /dev/null; then
        PNPM_CMD="pnpm"
    elif command -v npm &> /dev/null; then
        PNPM_CMD="npm exec pnpm"
    else
        echo -e "${ERROR}Neither pnpm nor npm is installed${NC}"
        exit 1
    fi
}

install_deps() {
    echo -e "${BOLD}Installing dependencies...${NC}"

    if [[ "${IS_BUNDLED_PLUGIN}" -eq 1 ]]; then
        echo -e "${INFO}Bundled plugin: using pnpm from repo root${NC}"
        (cd "${REPO_ROOT}" && ${PNPM_CMD} install)
    else
        if command -v npm &> /dev/null; then
            if [[ -f "${PLUGIN_DIR}/package-lock.json" ]]; then
                (cd "${PLUGIN_DIR}" && npm ci --ignore-scripts)
            else
                (cd "${PLUGIN_DIR}" && npm install --ignore-scripts)
            fi
        else
            echo -e "${ERROR}npm is not installed${NC}"
            exit 1
        fi
    fi

    echo -e "${SUCCESS}Dependencies installed${NC}"
}

build_plugin() {
    echo -e "${BOLD}Building OpenClawCode plugin...${NC}"

    if [[ "${IS_BUNDLED_PLUGIN}" -eq 1 ]]; then
        echo -e "${INFO}Bundled plugin: building with OpenClaw repo${NC}"
        (cd "${REPO_ROOT}" && ${PNPM_CMD} build)
    else
        if ! command -v npm &> /dev/null; then
            echo -e "${ERROR}npm is not installed${NC}"
            exit 1
        fi
        cd "${PLUGIN_DIR}"
        npm run build
    fi

    echo -e "${SUCCESS}Build complete${NC}"
}

verify_build() {
    echo -e "${BOLD}Verifying build output...${NC}"

    if [[ "${IS_BUNDLED_PLUGIN}" -eq 1 ]]; then
        expected_files=(
            "dist/extensions/openclawcode/src/openclaw-plugin.js"
        )
    else
        expected_files=(
            "dist/cli.js"
            "dist/index.js"
            "dist/openclaw-plugin.js"
            "dist/build-info.json"
        )
    fi

    missing_files=0
    for file in "${expected_files[@]}"; do
        if [[ ! -f "${PLUGIN_DIR}/${file}" ]] && [[ ! -f "${REPO_ROOT}/${file}" ]]; then
            echo -e "${ERROR}Missing: ${file}${NC}"
            missing_files=1
        else
            echo -e "${INFO}Found: ${file}${NC}"
        fi
    done

    if [[ "${missing_files}" -eq 1 ]]; then
        echo -e "${ERROR}Build verification failed${NC}"
        exit 1
    fi

    echo -e "${SUCCESS}Build verification passed${NC}"
}

run_tests() {
    if [[ "${IS_BUNDLED_PLUGIN}" -eq 1 ]]; then
        if [[ -f "${PLUGIN_DIR}/vitest.config.ts" ]]; then
            echo -e "${BOLD}Running tests...${NC}"
            (cd "${REPO_ROOT}" && pnpm test "${PLUGIN_DIR}/" || true)
        fi
    else
        if [[ -f "${PLUGIN_DIR}/vitest.config.ts" ]]; then
            echo -e "${BOLD}Running tests...${NC}"
            (cd "${PLUGIN_DIR}" && npm test || true)
        fi
    fi
}

main() {
    echo -e "${BOLD}OpenClawCode Build Script${NC}"
    echo ""

    detect_repo_root

    if [[ "${IS_BUNDLED_PLUGIN}" -eq 1 ]]; then
        echo -e "${INFO}Detected as bundled plugin in OpenClaw repo${NC}"
        echo -e "${INFO}Repo root: ${REPO_ROOT}${NC}"
    else
        echo -e "${INFO}Building as standalone plugin${NC}"
    fi
    echo ""

    check_node_version
    check_dependencies
    get_pnpm
    install_deps
    build_plugin
    verify_build
    run_tests

    echo ""
    echo -e "${SUCCESS}Build successful!${NC}"
    echo -e "${INFO}Plugin directory: ${PLUGIN_DIR}${NC}"
    if [[ "${IS_BUNDLED_PLUGIN}" -eq 1 ]]; then
        echo -e "${INFO}Plugin is auto-discovered by OpenClaw${NC}"
    else
        echo -e "${INFO}To run as standalone bot: node ${PLUGIN_DIR}/dist/cli.js${NC}"
    fi
}

main "$@"