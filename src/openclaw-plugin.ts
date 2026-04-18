import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/core";
import { loadJsonFile, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  handleTaskCommand,
  handleTaskTextInput,
  isUserInTaskFlow,
  clearTaskState,
} from "./task/task.js";
import {
  handleTaskListCommand,
  handleTaskListTextInput,
  isUserInTaskListFlow,
  clearOpenClawCodeTaskListState,
} from "./task/tasklist.js";
import { setCurrentProject, setCurrentSession, setCurrentModel } from "./settings/manager.js";
import { getStoredModel, getModelSelectionLists } from "./model/manager.js";
import type { FavoriteModel } from "./model/types.js";
import { listScheduledTasks } from "./scheduled-task/store.js";
import { scheduledTaskRuntime } from "./scheduled-task/runtime.js";
import type { PermissionRequest } from "./permission/types.js";
import {
  recordProactiveRisk,
  getProactiveRisk,
  isProactivePermissionError,
} from "./task/proactive-risk-registry.js";
import { ensureProjectByPath } from "./project/manager.js";
import { renameManager } from "./rename/manager.js";
import { t, resolveSupportedLocale, setRuntimeLocale } from "./i18n/index.js";
import { safeBackgroundTask } from "./utils/safe-background-task.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_INFO_PATH = path.join(PACKAGE_ROOT, "dist", "build-info.json");
const STATE_DIRNAME = "openclawcode";
const STATE_FILENAME = "state.json";
const ENTER_OPENCODE_COMMAND = "opencode";
const LEAVE_OPENCODE_COMMAND = "exit";

const PERMISSION_EMOJI_MAP: Record<string, string> = {
  bash: "💻",
  edit: "✏️",
  write: "📝",
  read: "📖",
  webfetch: "🌐",
  websearch: "🔍",
  glob: "📁",
  grep: "🔎",
  list: "📋",
  task: "📌",
  lsp: "🔧",
  external_directory: "📂",
};

const pendingPermissionRequests = new Map<string, PermissionRequest>();
const activeSessionForPermission = new Map<string, { sessionId: string; directory: string }>();

function storePermissionRequest(route: FollowUpRoute, request: PermissionRequest): void {
  const key = deriveUserIdFromRoute(route);
  pendingPermissionRequests.set(key, request);
}

function getPendingPermissionRequest(route: FollowUpRoute): PermissionRequest | null {
  const key = deriveUserIdFromRoute(route);
  return pendingPermissionRequests.get(key) ?? null;
}

function clearPendingPermissionRequest(route: FollowUpRoute): void {
  const key = deriveUserIdFromRoute(route);
  pendingPermissionRequests.delete(key);
}

function hasPendingPermissionRequest(route: FollowUpRoute): boolean {
  const key = deriveUserIdFromRoute(route);
  return pendingPermissionRequests.has(key);
}

type BuildInfoRecord = {
  version?: unknown;
  builtAt?: unknown;
};

type PluginConfig = {
  enabled?: boolean;
  channels?: string[];
  accountIds?: string[];
  conversationIds?: string[];
  opencodeBaseUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  defaultProjectDirectory?: string;
  locale?: string;
};

type ProjectState = {
  id: string;
  worktree: string;
  name?: string;
};

type SessionState = {
  id: string;
  title: string;
  directory: string;
};

type InterceptModeState = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  enteredAt?: string;
};

type AgentRecord = {
  name: string;
  mode?: string;
  hidden?: boolean;
};

type PluginState = {
  currentProject?: ProjectState;
  currentSession?: SessionState;
  interceptMode?: InterceptModeState;
  currentAgent?: string;
};

type ScopeContext = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

type FollowUpRoute = {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
};

type FollowUpMessage = {
  text: string;
  format?: "text" | "markdown";
};

type ProjectRecord = {
  id: string;
  worktree: string;
  name?: string;
  time?: {
    updated?: number;
  };
};

type SessionRecord = {
  id: string;
  title: string;
  directory: string;
  time?: {
    created?: number;
  };
};

type SessionStatusRecord = {
  type?: string;
};

type CommandRecord = {
  name?: string;
  description?: string;
  source?: string;
};

type SlashCommand = {
  name: string;
  args: string;
};

type ResponseTextPart = {
  type?: string;
  text?: string;
  ignored?: boolean;
};

type PromptProgressTracker = {
  rootSessionId: string;
  trackedSessionIds: Set<string>;
  thinkingSent: boolean;
  runningToolCalls: Set<string>;
  textParts: Map<string, string>;
  completedMessageIds: Set<string>;
};

type SessionLifecycleEvent = {
  type?: string;
  properties?: {
    info?: {
      id?: string;
      parentID?: string;
    };
  };
};

type ProgressEvent = {
  type?: string;
  properties?: {
    sessionID?: string;
    part?: {
      sessionID?: string;
      messageID?: string;
      callID?: string;
      tool?: string;
      type?: string;
      id?: string;
      text?: string;
      time?: { created?: number; completed?: number };
      state?: {
        status?: string;
        input?: Record<string, unknown>;
        title?: string;
        metadata?: Record<string, unknown>;
      };
    };
    message?: {
      id?: string;
      sessionID?: string;
      role?: string;
      time?: { created?: number; completed?: number };
    };
  };
};

function resolvePluginVersion(): string {
  try {
    const packageJsonPath = path.join(PACKAGE_ROOT, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function readBuildInfoFile(filePath: string): BuildInfoRecord | null {
  try {
    const buildInfo = JSON.parse(fs.readFileSync(filePath, "utf8")) as BuildInfoRecord;
    return buildInfo && typeof buildInfo === "object" ? buildInfo : null;
  } catch {
    return null;
  }
}

export function formatDiagnosticVersion(
  buildInfo: BuildInfoRecord | null,
  fallbackVersion: string,
): string {
  const version =
    typeof buildInfo?.version === "string" && buildInfo.version.trim()
      ? buildInfo.version.trim()
      : fallbackVersion;
  const builtAt =
    typeof buildInfo?.builtAt === "string" && buildInfo.builtAt.trim()
      ? buildInfo.builtAt.trim()
      : undefined;

  return builtAt ? `v${version} @ ${builtAt}` : `v${version}`;
}

function resolveDiagnosticVersion(): string {
  return formatDiagnosticVersion(readBuildInfoFile(BUILD_INFO_PATH), resolvePluginVersion());
}

const DIAGNOSTIC_VERSION = resolveDiagnosticVersion();

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePathForMatch(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => normalizeText(item)?.toLowerCase())
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function readPluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
    channels: readStringArray(record.channels),
    accountIds: readStringArray(record.accountIds),
    conversationIds: readStringArray(record.conversationIds),
    opencodeBaseUrl: normalizeText(record.opencodeBaseUrl),
    opencodeUsername: normalizeText(record.opencodeUsername),
    opencodePassword: normalizeText(record.opencodePassword),
    defaultProjectDirectory: normalizeText(record.defaultProjectDirectory),
    locale: normalizeText(record.locale),
  };
}

function matchesScope(config: PluginConfig, ctx: ScopeContext): boolean {
  const normalizedChannel = normalizeText(ctx.channelId)?.toLowerCase();
  const normalizedAccountId = normalizeText(ctx.accountId)?.toLowerCase();
  const normalizedConversationId = normalizeText(ctx.conversationId)?.toLowerCase();

  if (
    config.channels?.length &&
    (!normalizedChannel || !config.channels.includes(normalizedChannel))
  ) {
    return false;
  }

  if (
    config.accountIds?.length &&
    (!normalizedAccountId || !config.accountIds.includes(normalizedAccountId))
  ) {
    return false;
  }

  if (
    config.conversationIds?.length &&
    (!normalizedConversationId || !config.conversationIds.includes(normalizedConversationId))
  ) {
    return false;
  }

  return true;
}

function explainScopeMismatch(config: PluginConfig, ctx: ScopeContext): string | undefined {
  const normalizedChannel = normalizeText(ctx.channelId)?.toLowerCase();
  const normalizedAccountId = normalizeText(ctx.accountId)?.toLowerCase();
  const normalizedConversationId = normalizeText(ctx.conversationId)?.toLowerCase();

  if (
    config.channels?.length &&
    (!normalizedChannel || !config.channels.includes(normalizedChannel))
  ) {
    return `channel mismatch current=${normalizedChannel ?? "unknown"} expected=${config.channels.join(",")}`;
  }

  if (
    config.accountIds?.length &&
    (!normalizedAccountId || !config.accountIds.includes(normalizedAccountId))
  ) {
    return `account mismatch current=${normalizedAccountId ?? "unknown"} expected=${config.accountIds.join(",")}`;
  }

  if (
    config.conversationIds?.length &&
    (!normalizedConversationId || !config.conversationIds.includes(normalizedConversationId))
  ) {
    return `conversation mismatch current=${normalizedConversationId ?? "unknown"} expected=${config.conversationIds.join(",")}`;
  }

  return undefined;
}

function createDefaultState(): PluginState {
  return {};
}

function resolvePluginStateFile(): string {
  return path.join(resolveStateDir(), "plugins", STATE_DIRNAME, STATE_FILENAME);
}

function loadPluginState(logger: PluginLogger): PluginState {
  const filePath = resolvePluginStateFile();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const loaded = loadJsonFile(filePath) as PluginState | null;
    if (!loaded || typeof loaded !== "object") {
      return createDefaultState();
    }

    return {
      currentProject:
        loaded.currentProject && typeof loaded.currentProject === "object"
          ? {
              id:
                normalizeText(loaded.currentProject.id) ??
                normalizeText(loaded.currentProject.worktree) ??
                "unknown-project",
              worktree: normalizeText(loaded.currentProject.worktree) ?? "",
              name: normalizeText(loaded.currentProject.name),
            }
          : undefined,
      currentSession:
        loaded.currentSession && typeof loaded.currentSession === "object"
          ? {
              id: normalizeText(loaded.currentSession.id) ?? "",
              title: normalizeText(loaded.currentSession.title) ?? "OpenCode session",
              directory: normalizeText(loaded.currentSession.directory) ?? "",
            }
          : undefined,
      interceptMode:
        loaded.interceptMode && typeof loaded.interceptMode === "object"
          ? {
              channelId: normalizeText(loaded.interceptMode.channelId),
              accountId: normalizeText(loaded.interceptMode.accountId),
              conversationId: normalizeText(loaded.interceptMode.conversationId),
              enteredAt: normalizeText(loaded.interceptMode.enteredAt),
            }
          : undefined,
      currentAgent: normalizeText(loaded.currentAgent),
    };
  } catch (error) {
    logger.warn(`[OpenClawCode] failed to load state file=${filePath}: ${String(error)}`);
    return createDefaultState();
  }
}

async function savePluginState(state: PluginState, logger: PluginLogger): Promise<void> {
  const filePath = resolvePluginStateFile();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await writeJsonFileAtomically(filePath, state);
  } catch (error) {
    logger.error(`[OpenClawCode] failed to save state file=${filePath}: ${String(error)}`);
  }
}

function deriveUserIdFromRoute(route: FollowUpRoute): string {
  const parts = [
    route.channelId ?? "unknown",
    route.accountId ?? "unknown",
    route.conversationId ?? "unknown",
  ];
  return parts.join(":");
}

function syncStateToSettings(state: PluginState): void {
  if (state.currentProject) {
    setCurrentProject(state.currentProject);
  }
  if (state.currentSession) {
    setCurrentSession(state.currentSession);
  }
}

function createClient(config: PluginConfig) {
  const username = config.opencodeUsername ?? "opencode";
  const password = config.opencodePassword;
  const headers =
    password != null
      ? {
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        }
      : undefined;

  return createOpencodeClient({
    baseUrl: config.opencodeBaseUrl ?? "http://localhost:4096",
    headers,
  });
}

function parseSlashCommand(content: string): SlashCommand | null {
  const match = /^\/([^\s]+)(?:\s+(.*))?$/u.exec(content.trim());
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLocaleLowerCase(),
    args: match[2]?.trim() ?? "",
  };
}

function splitArgs(args: string): string[] {
  const normalized = normalizeText(args);
  return normalized ? normalized.split(/\s+/) : [];
}

export function createPromptProgressTracker(rootSessionId: string): PromptProgressTracker {
  return {
    rootSessionId,
    trackedSessionIds: new Set([rootSessionId]),
    thinkingSent: false,
    runningToolCalls: new Set(),
    textParts: new Map(),
    completedMessageIds: new Set(),
  };
}

function trackChildSessionFromEvent(
  event: SessionLifecycleEvent,
  tracker: PromptProgressTracker,
): void {
  const eventType = normalizeText(event.type);
  if (eventType !== "session.created" && eventType !== "session.updated") {
    return;
  }

  const childSessionId = normalizeText(event.properties?.info?.id);
  const parentSessionId = normalizeText(event.properties?.info?.parentID);
  if (!childSessionId || !parentSessionId) {
    return;
  }

  if (tracker.trackedSessionIds.has(parentSessionId)) {
    tracker.trackedSessionIds.add(childSessionId);
  }
}

function truncateToolText(value: string, maxLength = 160): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatToolLabel(tool: string): string {
  switch (tool) {
    case "bash":
      return "terminal";
    case "apply_patch":
      return "patch";
    case "write":
      return "write";
    case "edit":
      return "edit";
    default:
      return tool;
  }
}

function buildToolProgressMessage(
  part: NonNullable<ProgressEvent["properties"]>["part"],
): string | null {
  const tool = normalizeText(part?.tool);
  const callId = normalizeText(part?.callID);
  if (!tool || !callId) {
    return null;
  }

  const title = normalizeText(part?.state?.title);
  const input = part?.state?.input;

  if (tool === "bash") {
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    if (command) {
      return `🛠️ terminal ${truncateToolText(command)}`;
    }
  }

  const primaryDetail = title || (typeof input?.filePath === "string" ? input.filePath : undefined);
  return primaryDetail
    ? `🛠️ ${formatToolLabel(tool)} ${truncateToolText(primaryDetail)}`
    : `🛠️ ${formatToolLabel(tool)} running`;
}

export function resolvePromptProgressMessage(
  event: unknown,
  tracker: PromptProgressTracker,
): FollowUpMessage | undefined {
  trackChildSessionFromEvent(event as SessionLifecycleEvent, tracker);

  const progressEvent = event as ProgressEvent;
  if (normalizeText(progressEvent.type) !== "message.part.updated") {
    return undefined;
  }

  const part = progressEvent.properties?.part;
  const sessionId = normalizeText(part?.sessionID);
  if (!sessionId || !tracker.trackedSessionIds.has(sessionId)) {
    return undefined;
  }

  if (part?.type === "reasoning" && !tracker.thinkingSent) {
    tracker.thinkingSent = true;
    return {
      text: t("bot.thinking"),
      format: "text",
    };
  }

  if (part?.type !== "tool") {
    return undefined;
  }

  const callId = normalizeText(part?.callID);
  const status = normalizeText(part?.state?.status);
  if (!callId || status !== "running") {
    return undefined;
  }

  const toolKey = `${sessionId}:${callId}`;
  if (tracker.runningToolCalls.has(toolKey)) {
    return undefined;
  }
  tracker.runningToolCalls.add(toolKey);

  const text = buildToolProgressMessage(part);
  return text
    ? {
        text,
        format: "text",
      }
    : undefined;
}

async function streamPromptProgress(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createClient>;
  route: FollowUpRoute;
  session: SessionState;
  logger: PluginLogger;
  abortSignal: AbortSignal;
  onComplete?: (text: string) => Promise<void>;
}): Promise<void> {
  const { api, client, route, session, logger, abortSignal, onComplete } = params;

  try {
    const result = await client.event.subscribe(
      { directory: session.directory },
      { signal: abortSignal },
    );
    if (!result.stream) {
      logger.warn(`[OpenClawCode] event.subscribe returned no stream for session=${session.id}`);
      return;
    }

    const tracker = createPromptProgressTracker(session.id);
    for await (const event of result.stream) {
      if (abortSignal.aborted) {
        break;
      }

      const eventType = normalizeText((event as { type?: string }).type);

      if (eventType === "permission.asked") {
        const request = (event as { properties?: PermissionRequest }).properties;
        if (request && request.sessionID === session.id) {
          storePermissionRequest(route, request);
          const emoji = PERMISSION_EMOJI_MAP[request.permission] || "🔐";
          const patterns = request.patterns.join("\n");
          const message = t("permission.reply_hint", {
            emoji,
            type: request.permission,
            patterns,
          });
          await sendFollowUpMessage(api, route, { text: message }, logger);
          logger.info(
            `[OpenClawCode] Permission request sent: requestID=${request.id}, type=${request.permission}`,
          );
        }
        continue;
      }

      if (eventType === "message.part.updated") {
        const progressEvent = event as ProgressEvent;
        const part = progressEvent.properties?.part;
        const sessionId = normalizeText(part?.sessionID);
        if (sessionId && tracker.trackedSessionIds.has(sessionId)) {
          if (part?.type === "text" && part.id && part.text) {
            tracker.textParts.set(part.id, part.text);
          }
          if (part?.time?.completed && part.messageID) {
            tracker.completedMessageIds.add(part.messageID);
          }
        }
        const message = resolvePromptProgressMessage(event, tracker);
        if (message) {
          await sendFollowUpMessage(api, route, message, logger);
        }
        continue;
      }

      if (eventType === "message.updated") {
        const progressEvent = event as ProgressEvent;
        const msg = progressEvent.properties?.message;
        if (msg?.sessionID === session.id && msg?.time?.completed && msg.id) {
          tracker.completedMessageIds.add(msg.id);
        }
        continue;
      }

      if (eventType === "session.idle") {
        const progressEvent = event as ProgressEvent;
        const idleSessionId = progressEvent.properties?.sessionID;
        if (idleSessionId === session.id) {
          if (onComplete && tracker.textParts.size > 0) {
            const combinedText = Array.from(tracker.textParts.values()).join("");
            if (combinedText.trim()) {
              await onComplete(combinedText);
            }
          }
          break;
        }
        continue;
      }

      if (eventType === "session.error") {
        const progressEvent = event as ProgressEvent;
        const errorSessionId = progressEvent.properties?.sessionID;
        if (errorSessionId === session.id) {
          logger.error(`[OpenClawCode] Session error detected: session=${session.id}`);
          break;
        }
        continue;
      }
    }
  } catch (error) {
    if (abortSignal.aborted) {
      return;
    }
    logger.warn(`[OpenClawCode] prompt progress stream failed: ${String(error)}`);
  }
}

async function sendFollowUpMessage(
  api: OpenClawPluginApi,
  route: FollowUpRoute,
  message: FollowUpMessage,
  logger: PluginLogger,
): Promise<void> {
  if (!route.channelId || !route.conversationId) {
    logger.warn(
      `[OpenClawCode] follow-up skipped: missing route channel=${route.channelId ?? "unknown"} conversation=${route.conversationId ?? "unknown"}`,
    );
    return;
  }

  const outbound = await api.runtime.channel.outbound.loadAdapter(route.channelId);
  const text = message.text?.trim() ?? "";
  if (!text) {
    logger.warn("[OpenClawCode] follow-up skipped: empty message text");
    return;
  }

  logger.info(
    `[OpenClawCode] sendFollowUpMessage: channel=${route.channelId} conversation=${route.conversationId} format=${message.format ?? "text"} length=${text.length}`,
  );

  if (!outbound?.sendPayload) {
    logger.warn(
      `[OpenClawCode] follow-up skipped: outbound.sendPayload unavailable for channel=${route.channelId}`,
    );
    return;
  }

  const sendOptions = {
    cfg: api.config,
    to: route.conversationId,
    accountId: route.accountId,
  };

  try {
    await outbound.sendPayload({
      ...sendOptions,
      text,
      payload: { text },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (isProactivePermissionError(errorMessage)) {
      const accountId = route.accountId ?? "unknown";
      const targetId = route.conversationId;
      recordProactiveRisk({
        accountId,
        targetId,
        level: "high",
        reason: errorMessage,
        source: "followup_send",
      });
      logger.warn(
        `[OpenClawCode] Permission error detected for ${accountId}:${targetId}. Recorded proactive risk.`,
      );
    } else {
      logger.error(`[OpenClawCode] follow-up send error: ${errorMessage}`);
    }
  }
}

function shouldSkipProactiveSend(route: FollowUpRoute): boolean {
  const accountId = route.accountId ?? "unknown";
  const targetId = route.conversationId ?? "unknown";
  const risk = getProactiveRisk(accountId, targetId);
  if (risk) {
    return risk.level === "high" || risk.level === "medium";
  }
  return false;
}

function routeToInterceptMode(route: FollowUpRoute): InterceptModeState {
  return {
    channelId: normalizeText(route.channelId),
    accountId: normalizeText(route.accountId),
    conversationId: normalizeText(route.conversationId),
    enteredAt: new Date().toISOString(),
  };
}

function isInterceptModeActiveForRoute(state: PluginState, route: FollowUpRoute): boolean {
  const active = state.interceptMode;
  if (!active?.channelId || !active.conversationId) {
    return false;
  }

  return (
    normalizeText(route.channelId) === active.channelId &&
    normalizeText(route.conversationId) === active.conversationId &&
    normalizeText(route.accountId) === active.accountId
  );
}

function formatInterceptModeStatus(state: PluginState): string {
  if (!state.interceptMode?.channelId || !state.interceptMode.conversationId) {
    return "inactive";
  }

  return `${state.interceptMode.channelId}/${state.interceptMode.conversationId}`;
}

function collectResponseText(parts: ResponseTextPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && !part.ignored)
    .map((part) => part.text)
    .join("")
    .trim();
}

async function fetchProjects(client: ReturnType<typeof createClient>): Promise<ProjectRecord[]> {
  const { data, error } = await client.project.list();
  if (error || !data) {
    throw error ?? new Error("Failed to fetch OpenCode projects");
  }

  return [...(data as ProjectRecord[])].sort(
    (left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0),
  );
}

async function ensureCurrentProject(
  client: ReturnType<typeof createClient>,
  config: PluginConfig,
  state: PluginState,
  logger?: PluginLogger,
): Promise<ProjectState | null> {
  if (state.currentProject?.worktree) {
    return state.currentProject;
  }

  const configuredDirectory = normalizeText(config.defaultProjectDirectory);
  if (!configuredDirectory) {
    return null;
  }

  if (logger?.debug) {
    logger.debug(
      `[ensureCurrentProject] fetching projects for default directory: ${configuredDirectory}`,
    );
  }
  const configuredKey = normalizePathForMatch(configuredDirectory);
  const projects = await fetchProjects(client);
  const matched = projects.find(
    (project) => normalizePathForMatch(project.worktree) === configuredKey,
  );

  if (matched) {
    state.currentProject = {
      id: matched.id,
      worktree: matched.worktree,
      name: matched.name,
    };
    return state.currentProject;
  }

  state.currentProject = {
    id: configuredDirectory,
    worktree: configuredDirectory,
    name: path.basename(configuredDirectory),
  };
  return state.currentProject;
}

async function ensureCurrentSession(
  client: ReturnType<typeof createClient>,
  project: ProjectState,
  state: PluginState,
): Promise<SessionState> {
  if (
    state.currentSession &&
    normalizePathForMatch(state.currentSession.directory) ===
      normalizePathForMatch(project.worktree)
  ) {
    return state.currentSession;
  }

  const { data, error } = await client.session.create({ directory: project.worktree });
  if (error || !data) {
    throw error ?? new Error("Failed to create OpenCode session");
  }

  state.currentSession = {
    id: data.id,
    title: data.title,
    directory: project.worktree,
  };
  return state.currentSession;
}

async function preparePromptSession(params: {
  client: ReturnType<typeof createClient>;
  config: PluginConfig;
  state: PluginState;
  logger?: PluginLogger;
}): Promise<SessionState> {
  if (params.logger?.debug) {
    params.logger.debug(`[preparePromptSession] ensuring project for prompt`);
  }
  const project = await ensureCurrentProject(
    params.client,
    params.config,
    params.state,
    params.logger,
  );
  if (!project?.worktree) {
    throw new Error(t("project.not_selected_config"));
  }

  params.state.currentProject = project;
  if (params.logger?.debug) {
    params.logger.debug(`[preparePromptSession] ensuring session for project: ${project.worktree}`);
  }
  const session = await ensureCurrentSession(params.client, project, params.state);
  params.state.currentSession = session;
  if (params.logger?.debug) {
    params.logger.debug(`[preparePromptSession] session ready: ${session.id}`);
  }
  return session;
}

async function fetchSessions(
  client: ReturnType<typeof createClient>,
  project: ProjectState,
): Promise<SessionRecord[]> {
  const { data, error } = await client.session.list({
    directory: project.worktree,
    limit: 20,
    roots: true,
  });
  if (error || !data) {
    throw error ?? new Error("Failed to fetch OpenCode sessions");
  }

  return data as SessionRecord[];
}

async function fetchCurrentSessionStatus(
  client: ReturnType<typeof createClient>,
  state: PluginState,
): Promise<string | null> {
  if (!state.currentSession) {
    return null;
  }

  const { data, error } = await client.session.status({
    directory: state.currentSession.directory,
  });
  if (error || !data) {
    return null;
  }

  const statusMap = data as Record<string, SessionStatusRecord>;
  return statusMap[state.currentSession.id]?.type ?? null;
}

async function abortCurrentSession(
  client: ReturnType<typeof createClient>,
  state: PluginState,
): Promise<string> {
  if (!state.currentSession) {
    return t("opencode.no_active_session");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const { data, error } = await client.session.abort(
      {
        sessionID: state.currentSession.id,
        directory: state.currentSession.directory,
      },
      { signal: controller.signal },
    );
    if (error) {
      return `OpenCode abort failed: ${String(error)}`;
    }
    if (data !== true) {
      return t("opencode.abort_unconfirmed");
    }
    return `Aborted session ${state.currentSession.title}.`;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return t("opencode.abort_timeout");
    }
    return `Abort request failed: ${String(error)}`;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchCommandList(
  client: ReturnType<typeof createClient>,
  project: ProjectState,
): Promise<CommandRecord[]> {
  const { data, error } = await client.command.list({ directory: project.worktree });
  if (error || !data) {
    throw error ?? new Error("Failed to fetch OpenCode commands");
  }

  return (data as CommandRecord[]).filter(
    (command) => typeof command.name === "string" && command.source === "command",
  );
}

async function fetchAgents(
  client: ReturnType<typeof createClient>,
  project: ProjectState | undefined,
): Promise<AgentRecord[]> {
  const { data, error } = await client.app.agents(
    project ? { directory: project.worktree } : undefined,
  );
  if (error || !data) {
    throw error ?? new Error("Failed to fetch OpenCode agents");
  }
  return (data as AgentRecord[]).filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
}

function formatAgents(agents: AgentRecord[], currentAgent: string | undefined): string {
  const lines = agents.map((agent, index) => {
    const marker = agent.name === currentAgent ? " ✅" : "";
    return `${index + 1}. ${agent.name}${marker}`;
  });
  return [
    t("agent.list_title"),
    "",
    ...lines,
    "",
    t("agent.current", { current: currentAgent ?? "build" }),
    "",
    t("agent.select_hint"),
  ].join("\n");
}

function formatHelpText(): string {
  return [
    t("help.title"),
    "",
    `- /${ENTER_OPENCODE_COMMAND} - ${t("help.opencode")}`,
    `- /${LEAVE_OPENCODE_COMMAND} - ${t("help.exit")}`,
    `- /help - ${t("help.help")}`,
    `- /status - ${t("help.status")}`,
    `- /projects - ${t("help.projects")}`,
    `- /project <number or path> - ${t("help.project")}`,
    `- /sessions - ${t("help.sessions")}`,
    `- /session <number> - ${t("help.session")}`,
    `- /agents - ${t("help.agents")}`,
    `- /agent <number> - ${t("help.agent")}`,
    `- /models - ${t("help.models")}`,
    `- /model <number> - ${t("help.model")}`,
    `- /new - ${t("help.new")}`,
    `- /rename - ${t("help.rename")}`,
    `- /stop - ${t("help.stop")}`,
    `- /task - ${t("help.task")}`,
    `- /tasklist - ${t("help.tasklist")}`,
    `- /permission - ${t("help.permission")}`,
    `- /commands - ${t("help.commands")}`,
    "",
    t("help.permission_replies"),
    `- /1 - ${t("help.permission_1")}`,
    `- /2 - ${t("help.permission_2")}`,
    `- /3 - ${t("help.permission_3")}`,
    "",
    t("help.intercept_hint"),
  ].join("\n");
}

async function sendPromptToOpencode(params: {
  client: ReturnType<typeof createClient>;
  config: PluginConfig;
  state: PluginState;
  logger: PluginLogger;
  content: string;
}): Promise<string> {
  const { client, config, state, logger, content } = params;
  const session = await preparePromptSession({ client, config, state, logger });

  logger.info(
    `[OpenClawCode] forwarding message to OpenCode session=${session.id} directory=${session.directory} length=${content.length}`,
  );

  const { data, error } = await client.session.prompt({
    sessionID: session.id,
    directory: session.directory,
    parts: [{ type: "text", text: content }],
  });
  if (error || !data) {
    throw error ?? new Error("OpenCode did not return a prompt response");
  }

  const responseText = collectResponseText((data.parts ?? []) as ResponseTextPart[]);
  if (responseText) {
    return responseText;
  }

  return t("opencode.response_empty");
}

async function sendAsyncPromptToOpencodeWithProgress(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createClient>;
  config: PluginConfig;
  state: PluginState;
  logger: PluginLogger;
  route: FollowUpRoute;
  content: string;
}): Promise<void> {
  const { api, client, config, state, logger, route, content } = params;
  const session = await preparePromptSession({ client, config, state, logger });

  logger.info(
    `[OpenClawCode] forwarding async message to OpenCode session=${session.id} directory=${session.directory} length=${content.length}`,
  );

  const onComplete = async (text: string): Promise<void> => {
    await savePluginState(state, logger);
    if (text.trim()) {
      await sendFollowUpMessage(api, route, { text, format: "markdown" }, logger);
    }
    await sendFollowUpMessage(api, route, { text: "✅ Done", format: "text" }, logger);
    logger.info(
      `[OpenClawCode] async prompt completed session=${session.id} channel=${route.channelId ?? "unknown"} conversation=${route.conversationId ?? "unknown"}`,
    );
  };

  streamPromptProgress({
    api,
    client,
    route,
    session,
    logger,
    abortSignal: new AbortController().signal,
    onComplete,
  });

  safeBackgroundTask({
    taskName: "session.prompt",
    task: () =>
      client.session.prompt({
        sessionID: session.id,
        directory: session.directory,
        parts: [{ type: "text", text: content }],
      }),
    onSuccess: ({ error }) => {
      if (error) {
        const isTerminatedError =
          typeof error === "object" &&
          (Object.keys(error as object).length === 0 ||
            (error instanceof Error &&
              (error.message?.includes("terminated") ||
                error.message?.includes("Connection") ||
                error.message?.includes("aborted"))));

        if (isTerminatedError) {
          logger.warn(
            `[OpenClawCode] session.prompt connection issue (SSE may still handle completion): session=${session.id}`,
          );
          return;
        }

        const errorDetail =
          error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error);
        logger.error(
          `[OpenClawCode] session.prompt API error: session=${session.id} error=${errorDetail}`,
        );
        void sendFollowUpMessage(
          api,
          route,
          {
            text: `❌ OpenCode request failed: ${errorDetail}`,
            format: "text",
          },
          logger,
        ).catch(() => {});
      }
    },
    onError: (error) => {
      const errorDetail =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      logger.error(
        `[OpenClawCode] session.prompt background error: session=${session.id} error=${errorDetail}`,
      );
      void sendFollowUpMessage(
        api,
        route,
        {
          text: `❌ OpenCode request failed: ${errorDetail}`,
          format: "text",
        },
        logger,
      ).catch(() => {});
    },
  });
}

function schedulePromptFollowUp(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createClient>;
  config: PluginConfig;
  state: PluginState;
  logger: PluginLogger;
  route: FollowUpRoute;
  content: string;
}): void {
  const { api, client, config, state, logger, route, content } = params;

  setImmediate(() => {
    void (async () => {
      try {
        await sendAsyncPromptToOpencodeWithProgress({
          api,
          client,
          config,
          state,
          logger,
          route,
          content,
        });
        logger.info(
          `[OpenClawCode] async prompt dispatched channel=${route.channelId ?? "unknown"} conversation=${route.conversationId ?? "unknown"}`,
        );
      } catch (error) {
        const errorDetails =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const errorText = `❌ OpenClawCode request failed.\n\n**Error:** ${errorDetails}\n\nThis may indicate OpenCode server is restarting or unavailable. Try again in a few seconds.`;
        logger.error(`[OpenClawCode] async prompt failed: ${errorDetails}`);
        try {
          await sendFollowUpMessage(
            api,
            route,
            {
              text: errorText,
              format: "text",
            },
            logger,
          );
        } catch (sendError) {
          const sendErrorDetails =
            sendError instanceof Error
              ? `${sendError.name}: ${sendError.message}`
              : String(sendError);
          logger.error(
            `[OpenClawCode] async prompt error follow-up ALSO failed: ${sendErrorDetails}`,
          );
        }
      }
    })();
  });
}

function formatProjects(projects: ProjectRecord[], state: PluginState): string {
  const limit = 10;
  const displayed = projects.slice(0, limit);
  let message = `${t("project.list_title", { count: displayed.length, total: projects.length })}\n\n`;
  for (let i = 0; i < displayed.length; i++) {
    const project = displayed[i];
    const isCurrent =
      state.currentProject &&
      normalizePathForMatch(state.currentProject.worktree) ===
        normalizePathForMatch(project.worktree);
    const marker = isCurrent ? " ✅" : "";
    message += `${i + 1}. **${project.name ?? path.basename(project.worktree)}**${marker}\n   \`${project.worktree}\`\n`;
  }
  message += `\n${t("project.select_hint")}`;
  return message;
}

function formatSessions(sessions: SessionRecord[], state: PluginState): string {
  const limit = 10;
  const displayed = sessions.slice(0, limit);
  let message = `${t("session.list_title", { count: displayed.length, total: sessions.length })}\n\n`;
  for (let i = 0; i < displayed.length; i++) {
    const session = displayed[i];
    const isCurrent = state.currentSession?.id === session.id;
    const marker = isCurrent ? " ✅" : "";
    message += `${i + 1}. **${session.title}**${marker}\n   \`${session.id}\`\n`;
  }
  message += `\n${t("session.select_hint")}`;
  return message;
}

function formatCommands(commands: CommandRecord[]): string {
  return [
    "# OpenCode Commands",
    "",
    ...commands.map(
      (command) => `- /${command.name}${command.description ? ` - ${command.description}` : ""}`,
    ),
  ].join("\n");
}

async function handleCommand(params: {
  api: OpenClawPluginApi;
  logger: PluginLogger;
  config: PluginConfig;
  state: PluginState;
  route: FollowUpRoute;
  content: string;
}): Promise<string | undefined> {
  const { api, logger, config, state, route, content } = params;

  const trimmedContent = content.trim();
  if (["/1", "/2", "/3"].includes(trimmedContent)) {
    const replyMap: Record<string, "once" | "always" | "reject"> = {
      "/1": "once",
      "/2": "always",
      "/3": "reject",
    };
    const reply = replyMap[trimmedContent];
    if (hasPendingPermissionRequest(route)) {
      const request = getPendingPermissionRequest(route);
      if (!request) {
        return t("opencode.no_pending_permission");
      }
      const session = state.currentSession;
      if (!session) {
        clearPendingPermissionRequest(route);
        return t("opencode.permission_cleared");
      }
      try {
        const client = createClient(config);
        const { error } = await client.permission.reply({
          requestID: request.id,
          directory: session.directory,
          reply,
        });
        if (error) {
          logger.error(`[OpenClawCode] Permission reply failed: ${String(error)}`);
          return `Failed to send permission reply: ${String(error)}`;
        }
        clearPendingPermissionRequest(route);
        const replyLabels: Record<string, string> = {
          once: "✅ Allowed once",
          always: "✅ Always allowed",
          reject: "❌ Rejected",
        };
        return replyLabels[reply];
      } catch (error) {
        logger.error(`[OpenClawCode] Permission reply error: ${String(error)}`);
        return `Permission reply error: ${String(error)}`;
      }
    }
    return t("opencode.no_pending_permission");
  }

  const command = parseSlashCommand(content);
  if (!command) {
    return undefined;
  }

  const client = createClient(config);

  if (command.name === "help") {
    return formatHelpText();
  }

  if (command.name === "status") {
    try {
      const { data, error } = await client.global.health();
      const currentSessionStatus = await fetchCurrentSessionStatus(client, state);
      if (error || !data) {
        return `OpenCode server is unavailable at ${config.opencodeBaseUrl ?? "http://localhost:4096"}.`;
      }

      const statusKey =
        currentSessionStatus === "busy"
          ? "opencode.session_status_busy"
          : "opencode.session_status_idle";
      return [
        "# OpenClawCode Status",
        "",
        `- OpenCode healthy: **${data.healthy ? "yes" : "no"}**`,
        `- OpenCode version: \`${normalizeText(data.version) ?? "unknown"}\``,
        `- Configured base URL: \`${config.opencodeBaseUrl ?? "http://localhost:4096"}\``,
        `- Current project: \`${state.currentProject?.worktree ?? config.defaultProjectDirectory ?? "not selected"}\``,
        `- Current session: ${state.currentSession ? `**${state.currentSession.title}** [\`${state.currentSession.id}\`]` : "not selected"}`,
        `- Current session status: ${t(statusKey)}`,
        `- Intercept mode: ${formatInterceptModeStatus(state)}`,
      ].join("\n");
    } catch (error) {
      return `Failed to read OpenCode status: ${String(error)}`;
    }
  }

  if (command.name === "projects") {
    try {
      const projects = await fetchProjects(client);
      if (projects.length === 0) {
        return t("opencode.no_projects");
      }
      return formatProjects(projects, state);
    } catch (error) {
      return `Failed to fetch projects from OpenCode: ${String(error)}`;
    }
  }

  if (command.name === "project") {
    const trimmedArg = command.args.trim();

    if (!trimmedArg) {
      return t("project.select_prompt");
    }

    const index = Number(trimmedArg);

    if (!Number.isNaN(index) && index >= 1) {
      try {
        const projects = await fetchProjects(client);
        if (index > projects.length) {
          return t("project.index_not_found", { index, total: projects.length });
        }

        const selected = projects[index - 1];
        state.currentProject = {
          id: selected.id,
          worktree: selected.worktree,
          name: selected.name,
        };
        state.currentSession = undefined;
        await savePluginState(state, logger);
        return t("project.select_success", {
          name: selected.name ?? path.basename(selected.worktree),
          path: selected.worktree,
        });
      } catch (error) {
        return t("project.select_error", { error: String(error) });
      }
    }

    try {
      const { project, isNew, pathCreated } = await ensureProjectByPath(trimmedArg);

      state.currentProject = {
        id: project.id,
        worktree: project.worktree,
        name: project.name,
      };
      state.currentSession = undefined;
      await savePluginState(state, logger);

      if (isNew) {
        return t("project.created", { name: project.name, path: project.worktree });
      } else {
        return t("project.selected_existing", { name: project.name, path: project.worktree });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return t("project.select_error", { error: errorMessage });
    }
  }

  if (command.name === "new") {
    try {
      const project = await ensureCurrentProject(client, config, state);
      if (!project?.worktree) {
        return t("project.not_selected_config");
      }

      state.currentProject = project;
      const session = await ensureCurrentSession(client, project, state);
      await savePluginState(state, logger);
      return `Created session ${session.title} [${session.id}] for ${project.worktree}.`;
    } catch (error) {
      return `Failed to create a new OpenCode session: ${String(error)}`;
    }
  }

  if (command.name === "sessions") {
    try {
      const project = await ensureCurrentProject(client, config, state);
      if (!project?.worktree) {
        return t("agent.no_project");
      }

      state.currentProject = project;
      const sessions = await fetchSessions(client, project);
      if (sessions.length === 0) {
        return t("session.no_sessions", { project: project.worktree });
      }

      return formatSessions(sessions, state);
    } catch (error) {
      return `Failed to fetch sessions from OpenCode: ${String(error)}`;
    }
  }

  if (command.name === "session") {
    const trimmedArg = command.args.trim();
    const index = Number(trimmedArg);

    if (Number.isNaN(index) || index < 1) {
      return t("session.select_prompt");
    }
    try {
      const project = await ensureCurrentProject(client, config, state);
      if (!project?.worktree) {
        return t("project.not_selected");
      }

      state.currentProject = project;
      const sessions = await fetchSessions(client, project);

      if (index > sessions.length) {
        return t("session.index_not_found", { index, total: sessions.length });
      }

      const selected = sessions[index - 1];

      const { data: session, error: sessionError } = await client.session.get({
        sessionID: selected.id,
        directory: project.worktree,
      });

      if (sessionError || !session) {
        return t("opencode.no_session_details");
      }

      state.currentSession = {
        id: session.id,
        title: session.title,
        directory: project.worktree,
      };
      await savePluginState(state, logger);
      return t("session.select_success", { title: session.title });
    } catch (error) {
      return t("session.select_error");
    }
  }

  if (command.name === "stop") {
    const userId = deriveUserIdFromRoute(route);
    if (isUserInTaskFlow(userId)) {
      clearTaskState(userId);
      return t("flow.task_cancelled");
    }
    if (isUserInTaskListFlow(userId)) {
      clearOpenClawCodeTaskListState(userId);
      return t("flow.tasklist_cancelled");
    }
    if (renameManager.isWaitingForName()) {
      renameManager.clear();
      return t("flow.rename_cancelled");
    }
    if (hasPendingPermissionRequest(route)) {
      clearPendingPermissionRequest(route);
      return t("flow.permission_cancelled");
    }
    const result = await abortCurrentSession(client, state);
    await savePluginState(state, logger);
    return result;
  }

  if (command.name === "commands") {
    try {
      const project = await ensureCurrentProject(client, config, state);
      if (!project?.worktree) {
        return t("project.not_selected_config");
      }

      const commands = await fetchCommandList(client, project);
      if (commands.length === 0) {
        return `No OpenCode commands are exposed for ${project.worktree}.`;
      }

      return formatCommands(commands);
    } catch (error) {
      return `Failed to fetch OpenCode commands: ${String(error)}`;
    }
  }

  if (command.name === "agents") {
    try {
      const project = state.currentProject;
      const agents = await fetchAgents(client, project);
      if (agents.length === 0) {
        return t("opencode.no_agents");
      }

      return formatAgents(agents, state.currentAgent);
    } catch (error) {
      return `Failed to fetch agents from OpenCode: ${String(error)}`;
    }
  }

  if (command.name === "agent") {
    try {
      const project = state.currentProject;
      const agents = await fetchAgents(client, project);
      if (agents.length === 0) {
        return t("opencode.no_agents");
      }

      const args = splitArgs(command.args);
      if (args.length === 0) {
        return t("agent.usage");
      }

      const index = Number(args[0]);
      if (!Number.isInteger(index) || index < 1 || index > agents.length) {
        return t("agent.invalid_index");
      }

      const selected = agents[index - 1];
      state.currentAgent = selected.name;
      await savePluginState(state, logger);
      return t("agent.select_success", { name: selected.name });
    } catch (error) {
      return `Failed to select agent: ${String(error)}`;
    }
  }

  if (command.name === "rename") {
    if (!state.currentSession) {
      return t("agent.no_session");
    }
    renameManager.startWaiting(
      state.currentSession.id,
      state.currentSession.directory,
      state.currentSession.title,
    );
    return t("agent.rename_prompt", { title: state.currentSession.title });
  }

  if (command.name === "task") {
    syncStateToSettings(state);
    const userId = deriveUserIdFromRoute(route);
    return handleTaskCommand(userId, route);
  }

  if (command.name === "tasklist") {
    syncStateToSettings(state);
    const userId = deriveUserIdFromRoute(route);
    return handleTaskListCommand(userId);
  }

  if (command.name === "models") {
    try {
      const lists = await getModelSelectionLists();
      const lines: string[] = [t("models.header")];
      if (lists.favorites.length > 0) {
        lines.push("", t("models.favorites"));
        lists.favorites.forEach((m: FavoriteModel, i: number) =>
          lines.push(`${i + 1}. ${m.providerID}/${m.modelID}`),
        );
      }
      if (lists.recent.length > 0) {
        lines.push("", t("models.recent"));
        lists.recent.forEach((m: FavoriteModel, i: number) =>
          lines.push(`${i + 1}. ${m.providerID}/${m.modelID}`),
        );
      }
      const current = getStoredModel();
      if (current?.providerID && current.modelID) {
        lines.push("", t("models.current", { model: `${current.providerID}/${current.modelID}` }));
      } else {
        lines.push("", t("models.current_none"));
      }
      lines.push("", t("model.select_hint"));
      return lines.join("\n");
    } catch (error) {
      return t("models.fetch_error", { error: String(error) });
    }
  }

  if (command.name === "model") {
    try {
      const lists = await getModelSelectionLists();
      const allModels: FavoriteModel[] = [...lists.favorites, ...lists.recent];
      if (allModels.length === 0) {
        return t("opencode.no_models");
      }
      const args = splitArgs(command.args);
      if (args.length === 0) {
        return t("model.select_prompt");
      }
      const index = Number(args[0]);
      if (!Number.isInteger(index) || index < 1 || index > allModels.length) {
        return t("model.index_invalid", { max: allModels.length });
      }
      const selected = allModels[index - 1];
      setCurrentModel(selected);
      return t("model.select_success", { provider: selected.providerID, model: selected.modelID });
    } catch (error) {
      return t("model.select_error", { error: String(error) });
    }
  }

  if (command.name === "permission") {
    const request = getPendingPermissionRequest(route);
    if (!request) {
      const accountId = route.accountId ?? "unknown";
      const targetId = route.conversationId ?? "unknown";
      const risk = getProactiveRisk(accountId, targetId);
      if (risk) {
        return `No pending permission request, but proactive risk detected:\n\n**Level:** ${risk.level}\n**Reason:** ${risk.reason}\n**Source:** ${risk.source}\n\nSend a message to clear the risk and restore proactive messaging capability.`;
      }
      return t("opencode.permission_reply_hint");
    }
    const emoji = PERMISSION_EMOJI_MAP[request.permission] || "🔐";
    const patterns = request.patterns.join("\n");
    return t("permission.request_prompt", {
      id: request.id,
      emoji,
      type: request.permission,
      patterns,
    });
  }

  return undefined;
}

export default definePluginEntry({
  id: "openclawcode",
  name: "OpenClawCode",
  description: "OpenCode command handling for OpenClaw channel messages",
  configSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        channels: { type: "array", items: { type: "string" } },
        accountIds: { type: "array", items: { type: "string" } },
        conversationIds: { type: "array", items: { type: "string" } },
        opencodeBaseUrl: { type: "string" },
        opencodeUsername: { type: "string" },
        opencodePassword: { type: "string" },
        defaultProjectDirectory: { type: "string" },
        locale: { type: "string", enum: ["en", "zh", "zh-TW", "de", "es", "fr", "ru"] },
      },
      additionalProperties: false,
    },
  },

  register(api) {
    const logger = api.logger;
    const config = readPluginConfig(api.pluginConfig);
    const state = loadPluginState(logger);

    logger.info(
      `[OpenClawCode] register start version=${DIAGNOSTIC_VERSION} features=thinking,tool-progress,done config=${JSON.stringify(
        {
          ...config,
          opencodePassword: config.opencodePassword ? "***" : undefined,
        },
      )}`,
    );

    if (config.enabled === false) {
      logger.info("[OpenClawCode] plugin disabled by config.enabled=false");
      return;
    }

    if (config.locale) {
      const supportedLocale = resolveSupportedLocale(config.locale);
      if (supportedLocale) {
        setRuntimeLocale(supportedLocale);
        logger.info(`[OpenClawCode] locale set to ${supportedLocale}`);
      } else {
        logger.warn(`[OpenClawCode] unsupported locale: ${config.locale}, using default`);
      }
    }

    scheduledTaskRuntime.setNotificationCallback(
      async (
        text: string,
        route: { channelId?: string; accountId?: string; conversationId?: string },
      ) => {
        if (route.channelId && route.conversationId) {
          await sendFollowUpMessage(api, route, { text }, logger);
        } else {
          logger.warn("[OpenClawCode] Task has no route, cannot send notification");
        }
      },
    );

    void scheduledTaskRuntime
      .initialize()
      .then(() => {
        logger.info("[OpenClawCode] Scheduled task runtime initialized");
      })
      .catch((error) => {
        logger.error(
          `[OpenClawCode] Failed to initialize scheduled task runtime: ${String(error)}`,
        );
      });

    api.on("message_received", async (event, ctx) => {
      try {
        const scopeMismatch = explainScopeMismatch(config, {
          channelId: ctx.channelId,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
        });
        if (
          scopeMismatch ||
          !matchesScope(config, {
            channelId: ctx.channelId,
            accountId: ctx.accountId,
            conversationId: ctx.conversationId,
          })
        ) {
          return;
        }
      } catch (error) {
        logger.error(`[OpenClawCode] message_received error: ${String(error)}`);
      }
    });

    api.on("before_dispatch", async (event, ctx) => {
      try {
        const route = {
          channelId: ctx.channelId ?? event.channel,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
        };
        const scopeMismatch = explainScopeMismatch(config, {
          channelId: route.channelId,
          accountId: route.accountId,
          conversationId: route.conversationId,
        });
        if (
          scopeMismatch ||
          !matchesScope(config, {
            channelId: route.channelId,
            accountId: route.accountId,
            conversationId: route.conversationId,
          })
        ) {
          return undefined;
        }

        const content = normalizeText(event?.content) ?? "";
        if (!content) {
          return undefined;
        }

        if (content === `/${ENTER_OPENCODE_COMMAND}`) {
          state.interceptMode = routeToInterceptMode(route);
          await savePluginState(state, logger);
          logger.info(
            `[OpenClawCode] intercept mode enabled channel=${route.channelId ?? "unknown"} conversation=${route.conversationId ?? "unknown"}`,
          );
          return {
            handled: true,
            text: t("opencode.enter_mode"),
          };
        }

        if (content === `/${LEAVE_OPENCODE_COMMAND}`) {
          const wasActive = isInterceptModeActiveForRoute(state, route);
          state.interceptMode = undefined;
          await savePluginState(state, logger);
          return {
            handled: true,
            text: wasActive ? t("opencode.leave_mode") : t("opencode.leave_mode_inactive"),
          };
        }

        const isIntercepting = isInterceptModeActiveForRoute(state, route);
        if (!isIntercepting) {
          return undefined;
        }

        const userId = deriveUserIdFromRoute(route);
        syncStateToSettings(state);

        if (isUserInTaskFlow(userId)) {
          const taskReply = await handleTaskTextInput(userId, content);
          if (taskReply !== null) {
            await savePluginState(state, logger);
            return { handled: true, text: taskReply };
          }
        }

        if (isUserInTaskListFlow(userId)) {
          const taskListReply = await handleTaskListTextInput(userId, content);
          if (taskListReply !== null) {
            await savePluginState(state, logger);
            return { handled: true, text: taskListReply };
          }
        }

        if (renameManager.isWaitingForName()) {
          const sessionInfo = renameManager.getSessionInfo();
          if (sessionInfo && !content.startsWith("/")) {
            const newTitle = content.trim();
            if (!newTitle) {
              return { handled: true, text: "Title must not be empty. Please enter a new title." };
            }

            try {
              const client = createClient(config);
              const { data: updatedSession, error } = await client.session.update({
                sessionID: sessionInfo.sessionId,
                directory: sessionInfo.directory,
                title: newTitle,
              });

              if (error || !updatedSession) {
                throw error || new Error("Failed to update session");
              }

              state.currentSession = {
                id: sessionInfo.sessionId,
                title: newTitle,
                directory: sessionInfo.directory,
              };
              await savePluginState(state, logger);
              renameManager.clear();
              return { handled: true, text: `✅ Session renamed to "${newTitle}".` };
            } catch (error) {
              renameManager.clear();
              return { handled: true, text: `Failed to rename session: ${String(error)}` };
            }
          }
        }

        const client = createClient(config);

        const replyText = await handleCommand({
          api,
          logger,
          config,
          state,
          route,
          content,
        });

        if (replyText) {
          await savePluginState(state, logger);
          logger.info(
            `[OpenClawCode] intercepted command content=${content} replyLength=${replyText.length}`,
          );
          return { handled: true, text: replyText };
        }

        if (content.startsWith("/")) {
          const promptReply = await sendPromptToOpencode({
            client,
            config,
            state,
            logger,
            content,
          });
          await savePluginState(state, logger);
          logger.info(
            `[OpenClawCode] intercepted slash prompt content=${content} replyLength=${promptReply?.length ?? 0}`,
          );
          return { handled: true, text: promptReply };
        }

        schedulePromptFollowUp({
          api,
          client,
          config,
          state,
          logger,
          route,
          content,
        });
        const processingText = t("opencode.processing");
        logger.info(
          `[OpenClawCode] queued async prompt content=${content} processingReplyLength=${processingText.length}`,
        );
        return { handled: true, text: processingText };
      } catch (error) {
        logger.error(`[OpenClawCode] before_dispatch error: ${String(error)}`);
        return {
          handled: true,
          text: `OpenClawCode command failed: ${String(error)}`,
        };
      }
    });

    logger.info(
      `[OpenClawCode] register end version=${DIAGNOSTIC_VERSION} features=thinking,tool-progress,done`,
    );
  },
});
