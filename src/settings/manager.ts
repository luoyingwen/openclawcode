import type { ModelInfo } from "../model/types.js";
import { cloneScheduledTask, type ScheduledTask } from "../scheduled-task/types.js";
import path from "node:path";
import { getRuntimePaths } from "../runtime/paths.js";
import { logger } from "../utils/logger.js";

export interface ProjectInfo {
  id: string;
  worktree: string;
  name?: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  directory: string;
}

export interface SessionDirectoryCacheInfo {
  version: 1;
  lastSyncedUpdatedAt: number;
  directories: Array<{
    worktree: string;
    lastUpdated: number;
  }>;
}

export interface UserChatMapping {
  chatId: string;
  lastUpdated: number; // timestamp
}

export interface Settings {
  currentProject?: ProjectInfo;
  currentSession?: SessionInfo;
  currentAgent?: string;
  currentModel?: ModelInfo;
  pinnedMessageId?: number;
  ttsEnabled?: boolean;
  sessionDirectoryCache?: SessionDirectoryCacheInfo;
  scheduledTasks?: ScheduledTask[];
  userChatMappings?: Record<string, UserChatMapping>; // userId -> mapping
}

function cloneScheduledTasks(tasks: ScheduledTask[] | undefined): ScheduledTask[] | undefined {
  return tasks?.map((task) => cloneScheduledTask(task));
}

function getSettingsFilePath(): string {
  return getRuntimePaths().settingsFilePath;
}

async function readSettingsFile(): Promise<Settings> {
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile(getSettingsFilePath(), "utf-8");
    return JSON.parse(content) as Settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error("[SettingsManager] Error reading settings file:", error);
    }
    return {};
  }
}

let settingsWriteQueue: Promise<void> = Promise.resolve();

function writeSettingsFile(settings: Settings): Promise<void> {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => {
      // Keep write queue alive after failed writes.
    })
    .then(async () => {
      try {
        const fs = await import("fs/promises");
        const settingsFilePath = getSettingsFilePath();
        await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
        await fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2));
      } catch (err) {
        logger.error("[SettingsManager] Error writing settings file:", err);
      }
    });

  return settingsWriteQueue;
}

let currentSettings: Settings = {};

export function getCurrentProject(): ProjectInfo | undefined {
  return currentSettings.currentProject;
}

export function setCurrentProject(projectInfo: ProjectInfo): void {
  currentSettings.currentProject = projectInfo;
  void writeSettingsFile(currentSettings);
}

export function clearProject(): void {
  currentSettings.currentProject = undefined;
  void writeSettingsFile(currentSettings);
}

export function getCurrentSession(): SessionInfo | undefined {
  return currentSettings.currentSession;
}

export function setCurrentSession(sessionInfo: SessionInfo): void {
  currentSettings.currentSession = sessionInfo;
  void writeSettingsFile(currentSettings);
}

export function clearSession(): void {
  currentSettings.currentSession = undefined;
  void writeSettingsFile(currentSettings);
}

export function isTtsEnabled(): boolean {
  return currentSettings.ttsEnabled === true;
}

export function setTtsEnabled(enabled: boolean): void {
  currentSettings.ttsEnabled = enabled;
  void writeSettingsFile(currentSettings);
}

export function getCurrentAgent(): string | undefined {
  return currentSettings.currentAgent;
}

export function setCurrentAgent(agentName: string): void {
  currentSettings.currentAgent = agentName;
  void writeSettingsFile(currentSettings);
}

export function clearCurrentAgent(): void {
  currentSettings.currentAgent = undefined;
  void writeSettingsFile(currentSettings);
}

export function getCurrentModel(): ModelInfo | undefined {
  return currentSettings.currentModel;
}

export function setCurrentModel(modelInfo: ModelInfo): void {
  currentSettings.currentModel = modelInfo;
  void writeSettingsFile(currentSettings);
}

export function clearCurrentModel(): void {
  currentSettings.currentModel = undefined;
  void writeSettingsFile(currentSettings);
}

export function getPinnedMessageId(): number | undefined {
  return currentSettings.pinnedMessageId;
}

export function setPinnedMessageId(messageId: number): void {
  currentSettings.pinnedMessageId = messageId;
  void writeSettingsFile(currentSettings);
}

export function clearPinnedMessageId(): void {
  currentSettings.pinnedMessageId = undefined;
  void writeSettingsFile(currentSettings);
}

export function getSessionDirectoryCache(): SessionDirectoryCacheInfo | undefined {
  return currentSettings.sessionDirectoryCache;
}

export function setSessionDirectoryCache(cache: SessionDirectoryCacheInfo): Promise<void> {
  currentSettings.sessionDirectoryCache = cache;
  return writeSettingsFile(currentSettings);
}

export function clearSessionDirectoryCache(): void {
  currentSettings.sessionDirectoryCache = undefined;
  void writeSettingsFile(currentSettings);
}

export function getScheduledTasks(): ScheduledTask[] {
  return cloneScheduledTasks(currentSettings.scheduledTasks) ?? [];
}

export function setScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  currentSettings.scheduledTasks = cloneScheduledTasks(tasks);
  return writeSettingsFile(currentSettings);
}

// User-Chat Mappings for proactive messaging
export function getUserChatMapping(userId: string): UserChatMapping | undefined {
  return currentSettings.userChatMappings?.[userId];
}

export function setUserChatMapping(userId: string, chatId: string): Promise<void> {
  if (!currentSettings.userChatMappings) {
    currentSettings.userChatMappings = {};
  }
  currentSettings.userChatMappings[userId] = {
    chatId,
    lastUpdated: Date.now(),
  };
  return writeSettingsFile(currentSettings);
}

export function getAllUserChatMappings(): Record<string, UserChatMapping> {
  return currentSettings.userChatMappings ?? {};
}

export function clearUserChatMapping(userId: string): Promise<void> {
  if (currentSettings.userChatMappings?.[userId]) {
    delete currentSettings.userChatMappings[userId];
    return writeSettingsFile(currentSettings);
  }
  return Promise.resolve();
}

export function __resetSettingsForTests(): void {
  currentSettings = {};
  settingsWriteQueue = Promise.resolve();
}

export async function loadSettings(): Promise<void> {
  const loadedSettings = (await readSettingsFile()) as Settings & {
    toolMessagesIntervalSec?: unknown;
  };

  if ("toolMessagesIntervalSec" in loadedSettings) {
    delete loadedSettings.toolMessagesIntervalSec;
    void writeSettingsFile(loadedSettings);
  }

  currentSettings = loadedSettings;
  currentSettings.scheduledTasks = cloneScheduledTasks(loadedSettings.scheduledTasks) ?? [];
}
