import dotenv from "dotenv";
import { getRuntimePaths } from "./runtime/paths.js";
import { normalizeLocale, type Locale } from "./i18n/index.js";

const runtimePaths = getRuntimePaths();
dotenv.config({ path: runtimePaths.envFilePath, quiet: true });

export type MessageFormatMode = "raw" | "markdown";

function getEnvVar(key: string, required: boolean = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(
      `Missing required environment variable: ${key} (expected in ${runtimePaths.envFilePath})`,
    );
  }
  return value || "";
}

function getOptionalPositiveIntEnvVar(key: string, defaultValue: number): number {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    return defaultValue;
  }

  return parsedValue;
}

function getOptionalLocaleEnvVar(key: string, defaultValue: Locale): Locale {
  const value = getEnvVar(key, false);
  return normalizeLocale(value, defaultValue);
}

function getOptionalBooleanEnvVar(key: string, defaultValue: boolean): boolean {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function getOptionalMessageFormatModeEnvVar(
  key: string,
  defaultValue: MessageFormatMode,
): MessageFormatMode {
  const value = getEnvVar(key, false);

  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "raw" || normalized === "markdown") {
    return normalized;
  }

  return defaultValue;
}

export const config = {
  telegram: {
    token: getEnvVar("TELEGRAM_BOT_TOKEN", false),
    allowedUserId: parseInt(getEnvVar("TELEGRAM_ALLOWED_USER_ID", false) || "0", 10),
    proxyUrl: getEnvVar("TELEGRAM_PROXY_URL", false),
  },
  opencode: {
    apiUrl: getEnvVar("OPENCODE_API_URL", false) || "http://localhost:4096",
    username: getEnvVar("OPENCODE_SERVER_USERNAME", false) || "opencode",
    password: getEnvVar("OPENCODE_SERVER_PASSWORD", false),
    model: {
      provider: getEnvVar("OPENCODE_MODEL_PROVIDER", true), // Required
      modelId: getEnvVar("OPENCODE_MODEL_ID", true), // Required
    },
  },
  server: {
    logLevel: getEnvVar("LOG_LEVEL", false) || "info",
  },
  bot: {
    sessionsListLimit: getOptionalPositiveIntEnvVar("SESSIONS_LIST_LIMIT", 10),
    projectsListLimit: getOptionalPositiveIntEnvVar("PROJECTS_LIST_LIMIT", 10),
    commandsListLimit: getOptionalPositiveIntEnvVar("COMMANDS_LIST_LIMIT", 10),
    taskLimit: getOptionalPositiveIntEnvVar("TASK_LIMIT", 10),
    responseStreamThrottleMs: getOptionalPositiveIntEnvVar("RESPONSE_STREAM_THROTTLE_MS", 500),
    bashToolDisplayMaxLength: getOptionalPositiveIntEnvVar("BASH_TOOL_DISPLAY_MAX_LENGTH", 128),
    locale: getOptionalLocaleEnvVar("BOT_LOCALE", "en"),
    hideThinkingMessages: getOptionalBooleanEnvVar("HIDE_THINKING_MESSAGES", false),
    hideToolCallMessages: getOptionalBooleanEnvVar("HIDE_TOOL_CALL_MESSAGES", false),
    messageFormatMode: getOptionalMessageFormatModeEnvVar("MESSAGE_FORMAT_MODE", "markdown"),
  },
  files: {
    maxFileSizeKb: parseInt(getEnvVar("CODE_FILE_MAX_SIZE_KB", false) || "100", 10),
  },
  open: {
    browserRoots: getEnvVar("OPEN_BROWSER_ROOTS", false),
  },
  stt: {
    apiUrl: getEnvVar("STT_API_URL", false),
    apiKey: getEnvVar("STT_API_KEY", false),
    model: getEnvVar("STT_MODEL", false) || "whisper-large-v3-turbo",
    language: getEnvVar("STT_LANGUAGE", false),
  },
  tts: {
    apiUrl: getEnvVar("TTS_API_URL", false),
    apiKey: getEnvVar("TTS_API_KEY", false),
    model: getEnvVar("TTS_MODEL", false) || "gpt-4o-mini-tts",
    voice: getEnvVar("TTS_VOICE", false) || "alloy",
  },
  slack: {
    botToken: getEnvVar("SLACK_BOT_TOKEN", false),
    appToken: getEnvVar("SLACK_APP_TOKEN", false),
    signingSecret: getEnvVar("SLACK_SIGNING_SECRET", false),
    allowedChannelId: getEnvVar("SLACK_ALLOWED_CHANNEL_ID", false),
    proxyUrl: getEnvVar("SLACK_PROXY_URL", false),
  },
  dingtalk: {
    appKey: getEnvVar("DINGTALK_APP_KEY", false),
    appSecret: getEnvVar("DINGTALK_APP_SECRET", false),
    agentId: getEnvVar("DINGTALK_AGENT_ID", false),
    allowedUserId: getEnvVar("DINGTALK_ALLOWED_USER_ID", false),
    debug: getOptionalBooleanEnvVar("DINGTALK_DEBUG", false),
  },
  feishu: {
    appId: getEnvVar("FEISHU_APP_ID", false),
    appSecret: getEnvVar("FEISHU_APP_SECRET", false),
    domain: getEnvVar("FEISHU_DOMAIN", false) || "feishu",
    allowedUsers: getEnvVar("FEISHU_ALLOWED_USERS", false),
    streamEnabled: getOptionalBooleanEnvVar("FEISHU_STREAM_ENABLED", true),
  },
};
