import { config } from "../config.js";
import { formatSummaryWithMode } from "../summary/formatter.js";
import { t } from "../i18n/index.js";
import { logger } from "../utils/logger.js";
import { safeBackgroundTask } from "../utils/safe-background-task.js";
import { executeScheduledTask } from "./executor.js";
import { foregroundSessionState } from "./foreground-state.js";
import { computeNextRunAt, isTaskDue } from "./next-run.js";
import {
  getScheduledTask,
  listScheduledTasks,
  removeScheduledTask,
  replaceScheduledTasks,
  updateScheduledTask,
} from "./store.js";
import type { QueuedScheduledTaskDelivery, ScheduledTask, ScheduledTaskExecutionResult } from "./types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MESSAGE_LIMIT = 20000;
const TASK_DESCRIPTION_PREVIEW_LENGTH = 64;

type NotificationCallback = (text: string) => Promise<void>;
let notificationCallback: NotificationCallback | null = null;

const timersByTaskId = new Map<string, ReturnType<typeof setTimeout>>();
const runningTaskIds = new Set<string>();

export function setNotificationCallback(callback: NotificationCallback): void {
  notificationCallback = callback;
  logger.info("[ScheduledTaskRuntime] Notification callback registered");
}

export function clearNotificationCallback(): void {
  notificationCallback = null;
  logger.info("[ScheduledTaskRuntime] Notification callback cleared");
}

async function sendNotification(text: string): Promise<void> {
  if (!notificationCallback) {
    logger.warn("[ScheduledTaskRuntime] No notification callback set");
    return;
  }
  try {
    await notificationCallback(text);
  } catch (err) {
    logger.error("[ScheduledTaskRuntime] Failed to send notification:", err);
  }
}

function truncateDescription(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= TASK_DESCRIPTION_PREVIEW_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, TASK_DESCRIPTION_PREVIEW_LENGTH - 3)}...`;
}

function removeTaskTimer(taskId: string): void {
  const timer = timersByTaskId.get(taskId);
  if (timer) {
    clearTimeout(timer);
    timersByTaskId.delete(taskId);
  }
  runningTaskIds.delete(taskId);
}

function scheduleTask(task: ScheduledTask): void {
  removeTaskTimer(task.id);

  if (!task.nextRunAt) {
    return;
  }

  const nextRunAtMs = Date.parse(task.nextRunAt);
  if (Number.isNaN(nextRunAtMs)) {
    logger.warn(`[ScheduledTaskRuntime] Invalid nextRunAt: id=${task.id}, value=${task.nextRunAt}`);
    return;
  }

  const delayMs = nextRunAtMs - Date.now();
  if (delayMs <= 0) {
    safeBackgroundTask({
      taskName: `scheduled-task.${task.id}`,
      task: async () => executeTask(task.id),
    });
    return;
  }

  const timeoutMs = Math.min(delayMs, MAX_TIMER_DELAY_MS);
  const timer = setTimeout(() => {
    timersByTaskId.delete(task.id);
    const currentTask = getScheduledTask(task.id);
    if (currentTask) {
      safeBackgroundTask({
        taskName: `scheduled-task.${task.id}`,
        task: async () => executeTask(task.id),
      });
    }
  }, timeoutMs);

  timersByTaskId.set(task.id, timer);
  logger.info(`[ScheduledTaskRuntime] Scheduled task ${task.id} in ${Math.floor(timeoutMs / 1000)}s`);
}

function registerTask(task: ScheduledTask): void {
  scheduleTask(task);
}

function removeTask(taskId: string): void {
  removeTaskTimer(taskId);
}

async function executeTask(taskId: string): Promise<void> {
  if (runningTaskIds.has(taskId)) {
    logger.warn(`[ScheduledTaskRuntime] Task ${taskId} already running`);
    return;
  }

  const task = getScheduledTask(taskId);
  if (!task) {
    logger.warn(`[ScheduledTaskRuntime] Task ${taskId} not found`);
    removeTaskTimer(taskId);
    return;
  }

  runningTaskIds.add(taskId);
  logger.info(`[ScheduledTaskRuntime] Executing task ${taskId}: ${truncateDescription(task.prompt)}`);

  try {
    const result: ScheduledTaskExecutionResult = await executeScheduledTask(task);

    if (result.status === "success") {
      const summaryText = result.resultText ?? "";
      const truncatedSummary =
        summaryText.length > MESSAGE_LIMIT ? `${summaryText.slice(0, MESSAGE_LIMIT - 3)}...` : summaryText;

      await sendNotification(
        `✅ **Scheduled task completed**\n\n**Prompt:** ${truncateDescription(task.prompt)}\n\n${truncatedSummary}`,
      );

      if (task.kind === "once") {
        await removeScheduledTask(taskId);
        removeTask(taskId);
      } else {
        const nextRunStr = computeNextRunAt(task);
        const updatedTask = await updateScheduledTask(taskId, (t) => ({
          ...t,
          lastStatus: "success",
          lastError: null,
          nextRunAt: nextRunStr,
          runCount: t.runCount + 1,
        }));
        if (updatedTask) {
          scheduleTask(updatedTask);
        }
      }
    } else {
      await sendNotification(
        `❌ **Scheduled task failed**\n\n**Prompt:** ${truncateDescription(task.prompt)}\n\n**Error:** ${result.errorMessage ?? "Unknown error"}`,
      );

      let nextRunStr: string | null = null;
      if (task.kind === "cron") {
        try {
          nextRunStr = computeNextRunAt(task);
        } catch (err) {
          logger.error(`[ScheduledTaskRuntime] Failed to compute next run:`, err);
        }
      }

      const updatedTask = await updateScheduledTask(taskId, (t) => ({
        ...t,
        lastStatus: "error",
        lastError: result.errorMessage,
        nextRunAt: nextRunStr,
        runCount: t.runCount + 1,
      }));
      if (updatedTask) {
        scheduleTask(updatedTask);
      }
    }
  } catch (err) {
    logger.error(`[ScheduledTaskRuntime] Task execution failed:`, err);
    await sendNotification(
      `❌ **Scheduled task error**\n\n**Prompt:** ${truncateDescription(task.prompt)}\n\n**Error:** ${String(err)}`,
    );
  } finally {
    runningTaskIds.delete(taskId);
  }
}

async function deliverQueuedMessage(delivery: QueuedScheduledTaskDelivery): Promise<void> {
  await sendNotification(delivery.notificationText);
}

export const scheduledTaskRuntime = {
  registerTask,
  removeTask,
  scheduleNextRun: scheduleTask,
  executeTask,
  deliverQueuedMessage,
};