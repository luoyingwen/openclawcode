import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { getDateLocale, t } from "../i18n/index.js";
import { getStoredModel } from "../model/manager.js";
import { getCurrentProject } from "../settings/manager.js";
import { parseTaskSchedule } from "../scheduled-task/schedule-parser.js";
import { addScheduledTask, listScheduledTasks } from "../scheduled-task/store.js";
import { scheduledTaskRuntime } from "../scheduled-task/runtime.js";
import {
  createScheduledTaskModel,
  type ParsedTaskSchedule,
  type ScheduledTask,
  type ScheduledTaskModel,
} from "../scheduled-task/types.js";
import { logger } from "../utils/logger.js";

const TASK_PROMPT_PREVIEW_LENGTH = 100;

interface TaskState {
  stage: "awaiting_schedule" | "awaiting_prompt";
  projectId: string;
  projectWorktree: string;
  model: ScheduledTaskModel;
  scheduleText: string;
  parsedSchedule: ParsedTaskSchedule | null;
  lastActivity: number;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
}

const taskStates = new Map<string, TaskState>();

const STATE_TIMEOUT_MS = 5 * 60 * 1000;

function isTaskLimitReached(): boolean {
  return listScheduledTasks().length >= 10;
}

function truncateTaskPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= TASK_PROMPT_PREVIEW_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, TASK_PROMPT_PREVIEW_LENGTH - 3)}...`;
}

function formatScheduledDate(dateIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(getDateLocale(), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(dateIso));
  } catch {
    return dateIso;
  }
}

function getTaskKindLabel(schedule: ParsedTaskSchedule): string {
  return schedule.kind === "cron" ? t("task.kind.cron") : t("task.kind.once");
}

function formatParsedScheduleMessage(schedule: ParsedTaskSchedule): string {
  const cronLine =
    schedule.kind === "cron" ? `${t("task.schedule_preview.cron", { cron: schedule.cron })}\n` : "";

  return t("task.schedule_preview", {
    summary: schedule.summary,
    cronLine,
    timezone: schedule.timezone,
    kind: getTaskKindLabel(schedule),
    nextRunAt: formatScheduledDate(schedule.nextRunAt, schedule.timezone),
  });
}

function formatTaskCreatedMessage(task: ScheduledTask): string {
  const variant = task.model.variant ? ` (${task.model.variant})` : "";
  const model = `${task.model.providerID}/${task.model.modelID}${variant}`;
  const cronLine = task.kind === "cron" ? `${t("task.created.cron", { cron: task.cron })}\n` : "";

  return t("task.created", {
    description: truncateTaskPrompt(task.prompt),
    project: task.projectWorktree,
    model,
    schedule: task.scheduleSummary,
    cronLine,
    nextRunAt: task.nextRunAt ? formatScheduledDate(task.nextRunAt, task.timezone) : "-",
  });
}

function validateCronMinutesFrequency(cron: string): void {
  const cronParts = cron.trim().split(/\s+/);
  if (cronParts.length < 5) {
    throw new Error("Invalid cron expression returned by parser");
  }

  const minuteValues = expandCronMinuteField(cronParts[0]);
  if (minuteValues.length <= 1) {
    return;
  }

  let minGap = 60;
  for (let index = 0; index < minuteValues.length; index++) {
    const currentValue = minuteValues[index];
    const nextValue =
      index === minuteValues.length - 1 ? minuteValues[0] + 60 : minuteValues[index + 1];
    minGap = Math.min(minGap, nextValue - currentValue);
  }

  if (minGap < 5) {
    throw new Error(t("task.schedule_too_frequent"));
  }
}

function expandCronMinuteField(field: string): number[] {
  const values = new Set<number>();

  for (const token of field.split(",")) {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      throw new Error("Invalid cron minute field returned by parser");
    }

    for (const value of expandCronMinuteToken(trimmedToken)) {
      values.add(value);
    }
  }

  return Array.from(values).sort((left, right) => left - right);
}

function expandCronMinuteToken(token: string): number[] {
  const [rawBase, rawStep] = token.split("/");
  if (rawStep !== undefined) {
    const step = Number.parseInt(rawStep, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error("Invalid cron minute step returned by parser");
    }

    const baseValues = expandCronMinuteBase(rawBase);
    return baseValues.filter((value, index) => {
      if (baseValues.length === 0) {
        return false;
      }
      return index % step === 0;
    });
  }

  return expandCronMinuteBase(rawBase);
}

function expandCronMinuteBase(base: string): number[] {
  if (base === "*") {
    return Array.from({ length: 60 }, (_, index) => index);
  }

  if (base.includes("-")) {
    const [rawStart, rawEnd] = base.split("-");
    const start = parseCronMinuteNumber(rawStart);
    const end = parseCronMinuteNumber(rawEnd);
    if (start > end) {
      throw new Error("Invalid cron minute range returned by parser");
    }

    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  return [parseCronMinuteNumber(base)];
}

function parseCronMinuteNumber(value: string): number {
  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 59) {
    throw new Error("Invalid cron minute value returned by parser");
  }

  return parsedValue;
}

function validateParsedSchedule(parsedSchedule: ParsedTaskSchedule): void {
  if (parsedSchedule.kind === "cron") {
    validateCronMinutesFrequency(parsedSchedule.cron);
  }
}

function clearUserTaskState(userId: string, reason: string): void {
  if (taskStates.has(userId)) {
    taskStates.delete(userId);
    logger.debug(`[OpenClawCode Task] Cleared state for user ${userId}: ${reason}`);
  }
}

function buildScheduledTask(
  projectId: string,
  projectWorktree: string,
  model: ScheduledTaskModel,
  scheduleText: string,
  parsedSchedule: ParsedTaskSchedule,
  prompt: string,
  route: { channelId?: string; accountId?: string; conversationId?: string },
): ScheduledTask {
  const baseTask = {
    id: randomUUID(),
    projectId,
    projectWorktree,
    model,
    scheduleText,
    scheduleSummary: parsedSchedule.summary,
    timezone: parsedSchedule.timezone,
    prompt,
    createdAt: new Date().toISOString(),
    nextRunAt: parsedSchedule.nextRunAt,
    lastRunAt: null,
    runCount: 0,
    lastStatus: "idle" as const,
    lastError: null,
    channelId: route.channelId,
    accountId: route.accountId,
    conversationId: route.conversationId,
  };

  if (parsedSchedule.kind === "cron") {
    return {
      ...baseTask,
      kind: "cron",
      cron: parsedSchedule.cron,
    };
  }

  return {
    ...baseTask,
    kind: "once",
    runAt: parsedSchedule.runAt,
  };
}

export async function handleTaskCommand(
  userId: string,
  route: { channelId?: string; accountId?: string; conversationId?: string },
): Promise<string> {
  const currentProject = getCurrentProject();
  if (!currentProject) {
    return t("bot.project_not_selected");
  }

  if (isTaskLimitReached()) {
    return t("task.limit_reached", { limit: String(config.bot.taskLimit) });
  }

  clearUserTaskState(userId, "new_task_started");

  const currentModel = createScheduledTaskModel(getStoredModel());

  const state: TaskState = {
    stage: "awaiting_schedule",
    projectId: currentProject.id,
    projectWorktree: currentProject.worktree,
    model: currentModel,
    scheduleText: "",
    parsedSchedule: null,
    lastActivity: Date.now(),
    channelId: route.channelId,
    accountId: route.accountId,
    conversationId: route.conversationId,
  };

  taskStates.set(userId, state);

  return t("task.prompt.schedule");
}

export async function handleTaskTextInput(userId: string, text: string): Promise<string | null> {
  const state = taskStates.get(userId);
  if (!state) {
    return null; // Not in task creation flow
  }

  // Check for timeout
  if (Date.now() - state.lastActivity > STATE_TIMEOUT_MS) {
    clearUserTaskState(userId, "timeout");
    return t("task.inactive");
  }

  // Check for cancel
  const trimmedText = text.trim();
  if (trimmedText === "取消" || trimmedText === "/cancel") {
    clearUserTaskState(userId, "user_cancelled");
    return t("task.cancelled");
  }

  state.lastActivity = Date.now();

  if (state.stage === "awaiting_schedule") {
    if (!trimmedText) {
      return t("task.schedule_empty");
    }

    try {
      const parsedSchedule = await parseTaskSchedule(trimmedText, state.projectWorktree);
      validateParsedSchedule(parsedSchedule);

      state.scheduleText = trimmedText;
      state.parsedSchedule = parsedSchedule;
      state.stage = "awaiting_prompt";

      const schedulePreview = formatParsedScheduleMessage(parsedSchedule);
      return `${schedulePreview}\n\n${t("task.prompt.body")}\n\n（输入“取消”可退出）`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t("common.unknown_error");
      logger.warn(`[OpenClawCode Task] Failed to parse schedule: ${errorMessage}`);
      return `${t("task.parse_error", { message: errorMessage })}\n\n（输入“取消”可退出）`;
    }
  }

  if (state.stage === "awaiting_prompt") {
    if (!trimmedText) {
      return t("task.prompt_empty");
    }

    if (!state.parsedSchedule) {
      clearUserTaskState(userId, "missing_schedule");
      return t("task.inactive");
    }

    try {
      if (isTaskLimitReached()) {
        clearUserTaskState(userId, "limit_reached");
        return t("task.limit_reached", { limit: String(config.bot.taskLimit) });
      }

      const task = buildScheduledTask(
        state.projectId,
        state.projectWorktree,
        state.model,
        state.scheduleText,
        state.parsedSchedule,
        trimmedText,
        {
          channelId: state.channelId,
          accountId: state.accountId,
          conversationId: state.conversationId,
        },
      );

      await addScheduledTask(task);
      scheduledTaskRuntime.registerTask(task);
      clearUserTaskState(userId, "task_completed");

      return formatTaskCreatedMessage(task);
    } catch (error) {
      logger.error("[OpenClawCode Task] Failed to save scheduled task", error);
      return t("error.generic");
    }
  }

  return null;
}

export function isUserInTaskFlow(userId: string): boolean {
  const state = taskStates.get(userId);
  if (!state) return false;

  // Check for timeout
  if (Date.now() - state.lastActivity > STATE_TIMEOUT_MS) {
    clearUserTaskState(userId, "timeout_check");
    return false;
  }

  return true;
}

export function clearTaskState(userId: string): void {
  clearUserTaskState(userId, "manual_clear");
}
