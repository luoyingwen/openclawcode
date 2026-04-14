import { readFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { opencodeClient } from "../opencode/client.js";
import { ProjectInfo } from "../settings/manager.js";
import { getCachedSessionProjects, upsertSessionDirectory } from "../session/cache-manager.js";
import { logger } from "../utils/logger.js";

interface InternalProject extends ProjectInfo {
  lastUpdated: number;
}

async function isLinkedGitWorktree(worktree: string): Promise<boolean> {
  if (worktree === "/") {
    return false;
  }

  const gitPath = path.join(worktree, ".git");

  try {
    const gitStat = await stat(gitPath);

    if (!gitStat.isFile()) {
      return false;
    }

    const gitPointer = (await readFile(gitPath, "utf-8")).trim();
    const match = gitPointer.match(/^gitdir:\s*(.+)$/i);
    if (!match) {
      return false;
    }

    const gitDir = path.resolve(worktree, match[1].trim()).replace(/\\/g, "/").toLowerCase();
    return gitDir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
}

function worktreeKey(worktree: string): string {
  if (process.platform === "win32") {
    return worktree.toLowerCase();
  }

  return worktree;
}

export async function getProjects(): Promise<ProjectInfo[]> {
  const { data: projects, error } = await opencodeClient.project.list();

  if (error || !projects) {
    throw error || new Error("No data received from server");
  }

  const apiProjects: InternalProject[] = projects.map((project) => ({
    id: project.id,
    worktree: project.worktree,
    name: project.name || project.worktree,
    lastUpdated: project.time?.updated ?? 0,
  }));

  const cachedProjects = await getCachedSessionProjects();
  const mergedByWorktree = new Map<string, InternalProject>();

  for (const apiProject of apiProjects) {
    mergedByWorktree.set(worktreeKey(apiProject.worktree), apiProject);
  }

  for (const cachedProject of cachedProjects) {
    const key = worktreeKey(cachedProject.worktree);
    const existing = mergedByWorktree.get(key);

    if (existing) {
      if ((cachedProject.lastUpdated ?? 0) > existing.lastUpdated) {
        existing.lastUpdated = cachedProject.lastUpdated;
      }
      continue;
    }

    mergedByWorktree.set(key, {
      id: cachedProject.id,
      worktree: cachedProject.worktree,
      name: cachedProject.name,
      lastUpdated: cachedProject.lastUpdated ?? 0,
    });
  }

  const projectList = Array.from(mergedByWorktree.values()).sort(
    (left, right) => right.lastUpdated - left.lastUpdated,
  );

  const linkedWorktreeFlags = await Promise.all(
    projectList.map((project) => isLinkedGitWorktree(project.worktree)),
  );

  const visibleProjects = projectList.filter((_, index) => !linkedWorktreeFlags[index]);
  const hiddenLinkedWorktrees = projectList.length - visibleProjects.length;

  logger.debug(
    `[ProjectManager] Projects resolved: api=${projects.length}, cached=${cachedProjects.length}, hiddenLinkedWorktrees=${hiddenLinkedWorktrees}, total=${visibleProjects.length}`,
  );

  return visibleProjects.map(({ id, worktree, name }) => ({ id, worktree, name }));
}

export async function getProjectById(id: string): Promise<ProjectInfo> {
  const projects = await getProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new Error(`Project with id ${id} not found`);
  }
  return project;
}

export async function getProjectByWorktree(worktree: string): Promise<ProjectInfo> {
  const projects = await getProjects();
  const key = worktreeKey(worktree);
  const project = projects.find((p) => worktreeKey(p.worktree) === key);
  if (!project) {
    throw new Error(`Project with worktree ${worktree} not found`);
  }
  return project;
}

/**
 * Normalize a path string:
 * - Expand ~ to user home directory
 * - Convert to absolute path
 * - Normalize path separators
 */
function normalizePath(inputPath: string): string {
  let normalized = inputPath.trim();

  // Expand ~ to user home directory
  if (normalized.startsWith("~")) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }

  // Convert to absolute path
  normalized = path.resolve(normalized);

  // Normalize path separators for current platform
  return path.normalize(normalized);
}

/**
 * Check if a string looks like a valid path (not a number)
 */
function isValidPath(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;

  // Check if it's a number
  const num = Number(trimmed);
  if (!Number.isNaN(num) && String(num) === trimmed) {
    return false;
  }

  // Check for path indicators
  const pathIndicators = ["/", "\\", "~", ":", "."];
  return pathIndicators.some((indicator) => trimmed.includes(indicator));
}

/**
 * Ensure directory exists, create if not
 */
async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
    logger.debug(`[ProjectManager] Ensured directory exists: ${dirPath}`);
  } catch (error) {
    logger.error(`[ProjectManager] Failed to create directory: ${dirPath}`, error);
    throw new Error(`Failed to create directory: ${dirPath}`);
  }
}

/**
 * Create a virtual project ID from worktree path
 */
function createVirtualProjectId(worktree: string): string {
  const hash = createHash("sha1").update(worktree).digest("hex").slice(0, 16);
  return `dir_${hash}`;
}

/**
 * Ensure project exists by path:
 * - If path doesn't exist, create it
 * - If project doesn't exist in OpenCode, create it by initializing a session
 * - Return project info
 */
export async function ensureProjectByPath(inputPath: string): Promise<{
  project: ProjectInfo;
  isNew: boolean;
  pathCreated: boolean;
}> {
  // 1. Normalize the path
  const normalizedPath = normalizePath(inputPath);
  logger.info(`[ProjectManager] Ensuring project for path: ${normalizedPath}`);

  // 2. Check if path is valid
  if (!isValidPath(inputPath)) {
    throw new Error(`Invalid path: ${inputPath}`);
  }

  // 3. Ensure directory exists (create if not)
  let pathCreated = false;
  try {
    await stat(normalizedPath);
  } catch {
    // Path doesn't exist, create it
    logger.info(`[ProjectManager] Creating directory: ${normalizedPath}`);
    await ensureDirectoryExists(normalizedPath);
    pathCreated = true;
  }

  // 4. Check if project already exists in OpenCode
  try {
    const existingProject = await getProjectByWorktree(normalizedPath);
    logger.info(
      `[ProjectManager] Found existing project: ${existingProject.name || existingProject.worktree}`,
    );
    return {
      project: existingProject,
      isNew: false,
      pathCreated,
    };
  } catch {
    // Project doesn't exist, need to create it
    logger.info(`[ProjectManager] Project not found, creating new project at: ${normalizedPath}`);
  }

  // 5. Create project by initializing a session
  // This registers the directory as a project in OpenCode
  const { data: session, error } = await opencodeClient.session.create({
    directory: normalizedPath,
  });

  if (error || !session) {
    logger.error(`[ProjectManager] Failed to create session for project:`, error);
    throw error || new Error("Failed to create project session");
  }

  logger.info(`[ProjectManager] Created session for new project: ${session.id}`);

  // 6. Register in session cache
  await upsertSessionDirectory(normalizedPath, Date.now());

  // 7. Return new project info
  const newProject: ProjectInfo = {
    id: createVirtualProjectId(normalizedPath),
    worktree: normalizedPath,
    name: path.basename(normalizedPath),
  };

  return {
    project: newProject,
    isNew: true,
    pathCreated,
  };
}
