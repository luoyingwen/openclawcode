import fs from "node:fs";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/core";
import { loadJsonFile, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const PLUGIN_VERSION = "0.15.0";
const BUILD_MARKER = "progress-followups-2026-04-06-2115";
const DIAGNOSTIC_VERSION = `v${PLUGIN_VERSION}+${BUILD_MARKER}`;
const DINGTALK_MESSAGE_LIMIT = 20_000;
const HELLO_DELAY_MS = 30_000;
const STATE_DIRNAME = "openclawcode";
const STATE_FILENAME = "state.json";
const ENTER_OPENCODE_COMMAND = "进入opencode";
const LEAVE_OPENCODE_COMMAND = "离开opencode";

type PluginConfig = {
  enabled?: boolean;
  channels?: string[];
  accountIds?: string[];
  conversationIds?: string[];
  opencodeBaseUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  defaultProjectDirectory?: string;
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

type PluginState = {
  currentProject?: ProjectState;
  currentSession?: SessionState;
  interceptMode?: InterceptModeState;
  ttsEnabled?: boolean;
  helloCount: number;
  lastHelloAt?: string;
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
    part?: {
      sessionID?: string;
      messageID?: string;
      callID?: string;
      tool?: string;
      type?: string;
      state?: {
        status?: string;
        input?: Record<string, unknown>;
        title?: string;
        metadata?: Record<string, unknown>;
      };
    };
  };
};

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
  };
}

function matchesScope(config: PluginConfig, ctx: ScopeContext): boolean {
  const normalizedChannel = normalizeText(ctx.channelId)?.toLowerCase();
  const normalizedAccountId = normalizeText(ctx.accountId)?.toLowerCase();
  const normalizedConversationId = normalizeText(ctx.conversationId)?.toLowerCase();

  if (config.channels?.length && (!normalizedChannel || !config.channels.includes(normalizedChannel))) {
    return false;
  }

  if (config.accountIds?.length && (!normalizedAccountId || !config.accountIds.includes(normalizedAccountId))) {
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

  if (config.channels?.length && (!normalizedChannel || !config.channels.includes(normalizedChannel))) {
    return `channel mismatch current=${normalizedChannel ?? "unknown"} expected=${config.channels.join(",")}`;
  }

  if (config.accountIds?.length && (!normalizedAccountId || !config.accountIds.includes(normalizedAccountId))) {
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
  return { helloCount: 0, ttsEnabled: false };
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
      helloCount:
        typeof loaded.helloCount === "number" && Number.isFinite(loaded.helloCount)
          ? loaded.helloCount
          : 0,
      lastHelloAt: normalizeText(loaded.lastHelloAt),
      ttsEnabled: loaded.ttsEnabled === true,
      currentProject:
        loaded.currentProject && typeof loaded.currentProject === "object"
          ? {
              id: normalizeText(loaded.currentProject.id) ?? normalizeText(loaded.currentProject.worktree) ?? "unknown-project",
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
  };
}

function trackChildSessionFromEvent(event: SessionLifecycleEvent, tracker: PromptProgressTracker): void {
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

function buildToolProgressMessage(part: NonNullable<ProgressEvent["properties"]>["part"]): string | null {
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
      text: "💭 正在思考...",
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
}): Promise<void> {
  const { api, client, route, session, logger, abortSignal } = params;

  try {
    const result = await client.event.subscribe({ directory: session.directory }, { signal: abortSignal });
    if (!result.stream) {
      logger.warn(`[OpenClawCode] event.subscribe returned no stream for session=${session.id}`);
      return;
    }

    const tracker = createPromptProgressTracker(session.id);
    for await (const event of result.stream) {
      if (abortSignal.aborted) {
        break;
      }

      const message = resolvePromptProgressMessage(event, tracker);
      if (!message) {
        continue;
      }

      await sendFollowUpMessage(api, route, message, logger);
    }
  } catch (error) {
    if (abortSignal.aborted) {
      return;
    }
    logger.warn(`[OpenClawCode] prompt progress stream failed: ${String(error)}`);
  }
}

export function splitOutboundMessageText(text: string, maxLength: number): string[] {
  if (maxLength <= 0 || text.length <= maxLength) {
    return text.trim() ? [text] : [];
  }

  const parts: string[] = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    let endIndex = currentIndex + maxLength;

    if (endIndex >= text.length) {
      parts.push(text.slice(currentIndex));
      break;
    }

    const breakPoint = text.lastIndexOf("\n", endIndex);
    if (breakPoint > currentIndex) {
      endIndex = breakPoint + 1;
    }

    parts.push(text.slice(currentIndex, endIndex));
    currentIndex = endIndex;
  }

  return parts.filter((part) => part.trim().length > 0);
}

function resolveFollowUpChunkLimit(
  outbound: Awaited<ReturnType<OpenClawPluginApi["runtime"]["channel"]["outbound"]["loadAdapter"]>>,
  api: OpenClawPluginApi,
  route: FollowUpRoute,
): number {
  return (
    outbound?.resolveEffectiveTextChunkLimit?.({
      cfg: api.config,
      accountId: route.accountId,
      fallbackLimit: outbound.textChunkLimit,
    }) ??
    outbound?.textChunkLimit ??
    DINGTALK_MESSAGE_LIMIT
  );
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
  const text = message.text.trim();
  if (!text) {
    logger.warn("[OpenClawCode] follow-up skipped: empty message text");
    return;
  }

  if (message.format === "markdown" && outbound?.sendPayload) {
    await outbound.sendPayload({
      cfg: api.config,
      to: route.conversationId,
      text,
      payload: { text },
      accountId: route.accountId,
    });
    return;
  }

  if (message.format === "text" && outbound?.sendText) {
    const chunkLimit = resolveFollowUpChunkLimit(outbound, api, route);
    const chunks = splitOutboundMessageText(text, chunkLimit);
    for (const chunk of chunks) {
      await outbound.sendText({
        cfg: api.config,
        to: route.conversationId,
        text: chunk,
        accountId: route.accountId,
      });
    }
    return;
  }

  if (outbound?.sendPayload) {
    await outbound.sendPayload({
      cfg: api.config,
      to: route.conversationId,
      text,
      payload: { text },
      accountId: route.accountId,
    });
    return;
  }

  if (!outbound?.sendText) {
    logger.warn(
      `[OpenClawCode] follow-up skipped: outbound adapter unavailable for channel=${route.channelId}`,
    );
    return;
  }

  const chunkLimit = resolveFollowUpChunkLimit(outbound, api, route);
  const chunks = splitOutboundMessageText(text, chunkLimit);
  for (const chunk of chunks) {
    await outbound.sendText({
      cfg: api.config,
      to: route.conversationId,
      text: chunk,
      accountId: route.accountId,
    });
  }
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

function scheduleHelloDelay(
  api: OpenClawPluginApi,
  route: FollowUpRoute,
  state: PluginState,
  logger: PluginLogger,
): void {
  const timer = setTimeout(() => {
    void sendFollowUpMessage(
      api,
      route,
      {
        text: `30s delay message (helloCount=${state.helloCount})`,
        format: "text",
      },
      logger,
    ).catch((error) => {
      logger.error(`[OpenClawCode] delayed /hello message failed: ${String(error)}`);
    });
  }, HELLO_DELAY_MS);

  timer.unref?.();
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
): Promise<ProjectState | null> {
  if (state.currentProject?.worktree) {
    return state.currentProject;
  }

  const configuredDirectory = normalizeText(config.defaultProjectDirectory);
  if (!configuredDirectory) {
    return null;
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
    normalizePathForMatch(state.currentSession.directory) === normalizePathForMatch(project.worktree)
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
}): Promise<SessionState> {
  const project = await ensureCurrentProject(params.client, params.config, params.state);
  if (!project?.worktree) {
    throw new Error(
      "No project is selected. Set plugins.entries.openclawcode.config.defaultProjectDirectory or use /projects <index>.",
    );
  }

  params.state.currentProject = project;
  const session = await ensureCurrentSession(params.client, project, params.state);
  params.state.currentSession = session;
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
    return "No active OpenCode session is selected.";
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
      return "Abort request was sent, but OpenCode did not confirm the stop.";
    }
    return `Aborted session ${state.currentSession.title}.`;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "Abort request timed out while waiting for OpenCode.";
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

function formatHelpText(): string {
  return [
    "# OpenClawCode Channel Commands",
    "",
    `- /${ENTER_OPENCODE_COMMAND} - Enter OpenCode intercept mode for this conversation`,
    `- /${LEAVE_OPENCODE_COMMAND} - Leave OpenCode intercept mode for this conversation`,
    "- /help - Show this command list",
    "- /status - Show OpenCode health and current plugin state",
    "- /projects - List OpenCode projects",
    "- /projects <index> - Select the indexed project",
    "- /sessions - List sessions in the current project",
    "- /sessions <index> - Select the indexed session",
    "- /new - Create and select a new OpenCode session",
    "- /abort - Abort the current OpenCode session",
    "- /commands - List project commands exposed by OpenCode",
    "- /tts - Toggle the plugin TTS flag",
    "- /ping - Return Pong!",
    "- /hello - Return a demo reply and send a delayed follow-up",
    "",
    "All commands except /进入opencode and /离开opencode only work after intercept mode is enabled.",
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
  const session = await preparePromptSession({ client, config, state });

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

  return "OpenCode accepted the message, but the response was empty.";
}

async function sendAsyncPromptToOpencodeWithProgress(params: {
  api: OpenClawPluginApi;
  client: ReturnType<typeof createClient>;
  config: PluginConfig;
  state: PluginState;
  logger: PluginLogger;
  route: FollowUpRoute;
  content: string;
}): Promise<string> {
  const { api, client, config, state, logger, route, content } = params;
  const session = await preparePromptSession({ client, config, state });

  const progressAbortController = new AbortController();
  const progressTask = streamPromptProgress({
    api,
    client,
    route,
    session,
    logger,
    abortSignal: progressAbortController.signal,
  });

  try {
    logger.info(
      `[OpenClawCode] forwarding async message to OpenCode session=${session.id} directory=${session.directory} length=${content.length}`,
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
    return responseText || "OpenCode accepted the message, but the response was empty.";
  } finally {
    progressAbortController.abort();
    await progressTask;
  }
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
        const replyText = await sendAsyncPromptToOpencodeWithProgress({
          api,
          client,
          config,
          state,
          logger,
          route,
          content,
        });
        await savePluginState(state, logger);
        await sendFollowUpMessage(
          api,
          route,
          {
            text: replyText,
            format: "markdown",
          },
          logger,
        );
        await sendFollowUpMessage(
          api,
          route,
          {
            text: "✅ Done",
            format: "text",
          },
          logger,
        );
        logger.info(
          `[OpenClawCode] async prompt follow-up sent channel=${route.channelId ?? "unknown"} conversation=${route.conversationId ?? "unknown"}`,
        );
      } catch (error) {
        const errorText = `OpenClawCode prompt failed: ${String(error)}`;
        logger.error(`[OpenClawCode] async prompt failed: ${String(error)}`);
        await sendFollowUpMessage(
          api,
          route,
          {
            text: errorText,
            format: "text",
          },
          logger,
        ).catch((sendError) => {
          logger.error(`[OpenClawCode] async prompt error follow-up failed: ${String(sendError)}`);
        });
      }
    })();
  });
}

function formatProjects(projects: ProjectRecord[], state: PluginState): string {
  return [
    "# OpenCode Projects",
    "",
    ...projects.map((project, index) => {
      const isCurrent =
        state.currentProject &&
        normalizePathForMatch(state.currentProject.worktree) === normalizePathForMatch(project.worktree);
      const prefix = isCurrent ? "- **" : "- ";
      const suffix = isCurrent ? "**" : "";
      return `${prefix}${index + 1}. ${project.name ?? path.basename(project.worktree)}${suffix}\n  - worktree: \`${project.worktree}\``;
    }),
  ].join("\n");
}

function formatSessions(sessions: SessionRecord[], state: PluginState): string {
  return [
    "# OpenCode Sessions",
    "",
    ...sessions.map((session, index) => {
      const isCurrent = state.currentSession?.id === session.id;
      const prefix = isCurrent ? "- **" : "- ";
      const suffix = isCurrent ? "**" : "";
      return `${prefix}${index + 1}. ${session.title}${suffix}\n  - id: \`${session.id}\``;
    }),
  ].join("\n");
}

function formatCommands(commands: CommandRecord[]): string {
  return [
    "# OpenCode Commands",
    "",
    ...commands.map((command) => `- /${command.name}${command.description ? ` - ${command.description}` : ""}`),
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
  const command = parseSlashCommand(content);
  if (!command) {
    return undefined;
  }

  const client = createClient(config);

  if (command.name === "ping") {
    return "Pong!";
  }

  if (command.name === "hello") {
    state.helloCount += 1;
    state.lastHelloAt = new Date().toISOString();
    await savePluginState(state, logger);
    scheduleHelloDelay(api, route, state, logger);
    return `Hello from OpenClawCode. helloCount=${state.helloCount}`;
  }

  if (command.name === "help") {
    return formatHelpText();
  }

  if (command.name === "tts") {
    state.ttsEnabled = !state.ttsEnabled;
    await savePluginState(state, logger);
    return `OpenClawCode TTS flag is now ${state.ttsEnabled ? "enabled" : "disabled"}.`;
  }

  if (command.name === "status") {
    try {
      const { data, error } = await client.global.health();
      const currentSessionStatus = await fetchCurrentSessionStatus(client, state);
      if (error || !data) {
        return `OpenCode server is unavailable at ${config.opencodeBaseUrl ?? "http://localhost:4096"}.`;
      }

      return [
        "# OpenClawCode Status",
        "",
        `- OpenCode healthy: **${data.healthy ? "yes" : "no"}**`,
        `- OpenCode version: \`${normalizeText(data.version) ?? "unknown"}\``,
        `- Configured base URL: \`${config.opencodeBaseUrl ?? "http://localhost:4096"}\``,
        `- Current project: \`${state.currentProject?.worktree ?? config.defaultProjectDirectory ?? "not selected"}\``,
        `- Current session: ${state.currentSession ? `**${state.currentSession.title}** [\`${state.currentSession.id}\`]` : "not selected"}`,
        `- Current session status: ${currentSessionStatus ?? "unknown"}`,
        `- Intercept mode: ${formatInterceptModeStatus(state)}`,
        `- TTS flag: ${state.ttsEnabled ? "on" : "off"}`,
        `- Hello count: ${state.helloCount}`,
      ].join("\n");
    } catch (error) {
      return `Failed to read OpenCode status: ${String(error)}`;
    }
  }

  if (command.name === "projects") {
    try {
      const projects = await fetchProjects(client);
      if (projects.length === 0) {
        return "OpenCode did not return any projects.";
      }

      const args = splitArgs(command.args);
      if (args.length > 0) {
        const index = Number(args[0]);
        if (!Number.isInteger(index) || index < 1 || index > projects.length) {
          return `Invalid project index. Use /projects to inspect the current list.`;
        }

        const selected = projects[index - 1];
        state.currentProject = {
          id: selected.id,
          worktree: selected.worktree,
          name: selected.name,
        };
        state.currentSession = undefined;
        await savePluginState(state, logger);
        return `Selected project ${selected.name ?? path.basename(selected.worktree)} [${selected.worktree}].`;
      }

      return formatProjects(projects, state);
    } catch (error) {
      return `Failed to fetch projects from OpenCode: ${String(error)}`;
    }
  }

  if (command.name === "new") {
    try {
      const project = await ensureCurrentProject(client, config, state);
      if (!project?.worktree) {
        return "No project is selected. Set plugins.entries.openclawcode.config.defaultProjectDirectory or use /projects <index>.";
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
        return "No project is selected. Set plugins.entries.openclawcode.config.defaultProjectDirectory or use /projects <index>.";
      }

      state.currentProject = project;
      const sessions = await fetchSessions(client, project);
      if (sessions.length === 0) {
        return `No sessions found for ${project.worktree}.`;
      }

      const args = splitArgs(command.args);
      if (args.length > 0) {
        const index = Number(args[0]);
        if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
          return `Invalid session index. Use /sessions to inspect the current list.`;
        }

        const selected = sessions[index - 1];
        state.currentSession = {
          id: selected.id,
          title: selected.title,
          directory: selected.directory,
        };
        await savePluginState(state, logger);
        return `Selected session ${selected.title} [${selected.id}].`;
      }

      return formatSessions(sessions, state);
    } catch (error) {
      return `Failed to fetch sessions from OpenCode: ${String(error)}`;
    }
  }

  if (command.name === "abort") {
    const result = await abortCurrentSession(client, state);
    await savePluginState(state, logger);
    return result;
  }

  if (command.name === "commands") {
    try {
      const project = await ensureCurrentProject(client, config, state);
      if (!project?.worktree) {
        return "No project is selected. Set plugins.entries.openclawcode.config.defaultProjectDirectory or use /projects <index>.";
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

  return undefined;
}

export default definePluginEntry({
  id: "openclawcode",
  name: "OpenClawCode",
  description: "OpenCode command handling for OpenClaw channel messages",

  register(api) {
    const logger = api.logger;
    const config = readPluginConfig(api.pluginConfig);
    const state = loadPluginState(logger);

    logger.info(
      `[OpenClawCode] register start version=${DIAGNOSTIC_VERSION} features=thinking,tool-progress,done config=${JSON.stringify({
        ...config,
        opencodePassword: config.opencodePassword ? "***" : undefined,
      })}`,
    );

    if (config.enabled === false) {
      logger.info("[OpenClawCode] plugin disabled by config.enabled=false");
      return;
    }

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
          if (scopeMismatch) {
            logger.info(`[OpenClawCode] message_received skipped: ${scopeMismatch}`);
          }
          return;
        }

        logger.info(
          `[OpenClawCode] message_received channel=${ctx.channelId ?? "unknown"} account=${ctx.accountId ?? "unknown"} conversation=${ctx.conversationId ?? "unknown"} content=${normalizeText(event?.content) ?? "(no content)"}`,
        );
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
          if (scopeMismatch) {
            logger.info(`[OpenClawCode] before_dispatch skipped: ${scopeMismatch}`);
          }
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
            text: "已进入 opencode 模式。现在这个会话里的所有消息都会先被 OpenClawCode 拦截并发送给 OpenCode。",
          };
        }

        if (content === `/${LEAVE_OPENCODE_COMMAND}`) {
          const wasActive = isInterceptModeActiveForRoute(state, route);
          state.interceptMode = undefined;
          await savePluginState(state, logger);
          return {
            handled: true,
            text: wasActive
              ? "已离开 opencode 模式。后续消息将不再由 OpenClawCode 拦截。"
              : "当前不在 opencode 模式。",
          };
        }

        const isIntercepting = isInterceptModeActiveForRoute(state, route);
        if (!isIntercepting) {
          return undefined;
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
          logger.info(`[OpenClawCode] intercepted command content=${content}`);
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
          logger.info(`[OpenClawCode] intercepted slash prompt content=${content}`);
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
        logger.info(`[OpenClawCode] queued async prompt content=${content}`);
        return { handled: true, text: "正在处理..." };
      } catch (error) {
        logger.error(`[OpenClawCode] before_dispatch error: ${String(error)}`);
        return {
          handled: true,
          text: `OpenClawCode command failed: ${String(error)}`,
        };
      }
    });

    logger.info(`[OpenClawCode] register end version=${DIAGNOSTIC_VERSION} features=thinking,tool-progress,done`);
  },
});
