/**
 * Shared commands flow logic for DingTalk and Feishu
 * Platform-agnostic core implementation
 */

import { opencodeClient } from "../opencode/client.js";
import { getCurrentProject } from "../settings/manager.js";
import { logger } from "../utils/logger.js";
import { t } from "../i18n/index.js";

export interface CommandItem {
  name: string;
  description: string;
}

export interface CommandsFlowState {
  stage: "list" | "confirm";
  projectDirectory: string;
  commands: CommandItem[];
  selectedCommand: CommandItem | null;
  selectedIndex: number;
  lastActivity: number;
}

export interface CommandsFlowResult {
  type: "message" | "execute" | "null";
  message: string | null;
  commandName: string | null;
  args: string | null;
}

export type ExecuteCommandCallback = (commandName: string, args: string) => Promise<void>;

const STATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generic state manager for commands flow
 */
export class CommandsFlowManager {
  private states = new Map<string, CommandsFlowState>();

  getState(userId: string): CommandsFlowState | null {
    const state = this.states.get(userId);
    if (!state) return null;

    if (Date.now() - state.lastActivity > STATE_TIMEOUT_MS) {
      this.states.delete(userId);
      return null;
    }

    return state;
  }

  setState(userId: string, state: CommandsFlowState): void {
    this.states.set(userId, state);
  }

  clearState(userId: string): void {
    this.states.delete(userId);
  }

  isInFlow(userId: string): boolean {
    return this.getState(userId) !== null;
  }

  updateActivity(userId: string): void {
    const state = this.getState(userId);
    if (state) {
      state.lastActivity = Date.now();
    }
  }
}

/**
 * Start commands flow - returns the initial list message
 */
export async function startCommandsFlow(
  manager: CommandsFlowManager,
  userId: string,
): Promise<string> {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return t("bot.project_not_selected");
  }

  try {
    const { data, error } = await opencodeClient.command.list({
      directory: currentProject.worktree.replace(/\\/g, "/"),
    });

    if (error || !data || data.length === 0) {
      return t("commands.empty");
    }

    const commands: CommandItem[] = data
      .filter((cmd) => typeof cmd.name === "string" && cmd.name.trim().length > 0)
      .map((cmd) => ({
        name: cmd.name,
        description: cmd.description?.trim() || t("commands.no_description"),
      }));

    if (commands.length === 0) {
      return t("commands.empty");
    }

    manager.setState(userId, {
      stage: "list",
      projectDirectory: currentProject.worktree,
      commands,
      selectedCommand: null,
      selectedIndex: -1,
      lastActivity: Date.now(),
    });

    return formatCommandsList(commands);
  } catch (err) {
    logger.error("[CommandsFlow] Error starting flow:", err);
    return t("commands.fetch_error");
  }
}

/**
 * Handle text input in list stage
 */
function handleListStage(
  manager: CommandsFlowManager,
  userId: string,
  state: CommandsFlowState,
  input: string,
): CommandsFlowResult {
  const trimmedInput = input.trim().toLowerCase();

  // Check cancel
  if (trimmedInput === "cancel" || trimmedInput === "/cancel" || trimmedInput === "取消") {
    manager.clearState(userId);
    return {
      type: "message",
      message: t("commands.cancelled_callback"),
      commandName: null,
      args: null,
    };
  }

  // Parse command number
  const cmdNumber = parseInt(input.trim(), 10);
  if (isNaN(cmdNumber) || cmdNumber < 1 || cmdNumber > state.commands.length) {
    return {
      type: "message",
      message: `⚠️ ${t("commands.invalid_number", { min: "1", max: String(state.commands.length) })}`,
      commandName: null,
      args: null,
    };
  }

  const selectedCommand = state.commands[cmdNumber - 1];

  // Update state to confirm stage
  manager.setState(userId, {
    ...state,
    stage: "confirm",
    selectedCommand,
    selectedIndex: cmdNumber - 1,
    lastActivity: Date.now(),
  });

  return {
    type: "message",
    message: formatConfirmMessage(selectedCommand),
    commandName: null,
    args: null,
  };
}

/**
 * Handle text input in confirm stage
 */
function handleConfirmStage(
  manager: CommandsFlowManager,
  userId: string,
  state: CommandsFlowState,
  input: string,
): CommandsFlowResult {
  const trimmedInput = input.trim().toLowerCase();

  // Check cancel
  if (trimmedInput === "cancel" || trimmedInput === "/cancel" || trimmedInput === "取消") {
    manager.clearState(userId);
    return {
      type: "message",
      message: t("commands.cancelled_callback"),
      commandName: null,
      args: null,
    };
  }

  if (!state.selectedCommand) {
    manager.clearState(userId);
    return {
      type: "message",
      message: t("commands.inactive_callback"),
      commandName: null,
      args: null,
    };
  }

  const commandName = state.selectedCommand.name;
  let args = "";

  // If not "run", treat input as arguments
  if (trimmedInput !== "run" && trimmedInput !== "执行") {
    args = input.trim();
  }

  // Clear state before execution
  manager.clearState(userId);

  return {
    type: "execute",
    commandName,
    args,
    message: formatExecutingMessage(commandName, args),
  };
}

/**
 * Process text input in commands flow
 */
export function processCommandsInput(
  manager: CommandsFlowManager,
  userId: string,
  input: string,
): CommandsFlowResult {
  const state = manager.getState(userId);
  if (!state) {
    return { type: "null", message: null, commandName: null, args: null };
  }

  manager.updateActivity(userId);

  if (state.stage === "list") {
    return handleListStage(manager, userId, state, input);
  }

  if (state.stage === "confirm") {
    return handleConfirmStage(manager, userId, state, input);
  }

  return { type: "null", message: null, commandName: null, args: null };
}

/**
 * Format commands list message
 */
function formatCommandsList(commands: CommandItem[]): string {
  const lines: string[] = [];
  lines.push(`📋 **OpenCode Commands** (${commands.length} available)\n`);

  commands.forEach((cmd, index) => {
    lines.push(`${index + 1}. /${cmd.name} — ${cmd.description}`);
  });

  lines.push("");
  lines.push(t("commands.hint_select"));

  return lines.join("\n");
}

/**
 * Format confirmation message
 */
function formatConfirmMessage(command: CommandItem): string {
  const lines: string[] = [];
  lines.push("📋 Execute Command\n");
  lines.push(`Command: /${command.name}`);
  lines.push(`Description: ${command.description}`);
  lines.push("");
  lines.push(t("commands.confirm_hint"));

  return lines.join("\n");
}

/**
 * Format executing message
 */
function formatExecutingMessage(commandName: string, args: string): string {
  const cmdText = args ? `/${commandName} ${args}` : `/${commandName}`;
  return `⚡ ${t("commands.executing_prefix")}\n\`${cmdText}\``;
}
