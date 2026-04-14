type RiskLevel = "low" | "medium" | "high";

interface ProactiveRiskObservation {
  level: RiskLevel;
  reason: string;
  source: string;
  observedAt: number;
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const riskRegistry = new Map<string, ProactiveRiskObservation>();

function makeKey(accountId: string, targetId: string): string {
  return `${accountId}:${targetId}`;
}

export function recordProactiveRisk(params: {
  accountId: string;
  targetId: string;
  level: RiskLevel;
  reason: string;
  source: string;
}): void {
  const key = makeKey(params.accountId, params.targetId);
  riskRegistry.set(key, {
    level: params.level,
    reason: params.reason,
    source: params.source,
    observedAt: Date.now(),
  });
}

export function getProactiveRisk(
  accountId: string,
  targetId: string,
): ProactiveRiskObservation | null {
  const key = makeKey(accountId, targetId);
  const observation = riskRegistry.get(key);
  if (!observation) {
    return null;
  }
  if (Date.now() - observation.observedAt > DEFAULT_COOLDOWN_MS) {
    riskRegistry.delete(key);
    return null;
  }
  return observation;
}

export function deleteProactiveRisk(accountId: string, targetId: string): void {
  const key = makeKey(accountId, targetId);
  riskRegistry.delete(key);
}

export function isProactivePermissionError(errCode: string): boolean {
  const permissionErrorCodes = [
    "400502",
    "400014",
    "400503",
    "ForbiddenAccessDenied",
    "ipNotInWhiteList",
    "permissionDenied",
  ];
  const normalized = errCode.toLowerCase().replace(/[^a-z0-9]/g, "");
  return permissionErrorCodes.some((code) => normalized.includes(code.toLowerCase()));
}

export function clearProactiveRiskRegistry(): void {
  riskRegistry.clear();
}
