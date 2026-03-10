import type { OpenClawStatusResult } from "./backup.js";

export type PhoenixStatusHealthResult = {
  healthy: boolean;
  reason: string;
};

export function evaluateOpenClawStatusHealth(status: OpenClawStatusResult): PhoenixStatusHealthResult {
  const gateway = status.gateway;
  if (gateway?.misconfigured === true) {
    return { healthy: false, reason: "gateway is misconfigured in openclaw status --json" };
  }
  if (gateway?.reachable === false) {
    return { healthy: false, reason: "gateway is unreachable in openclaw status --json" };
  }
  if (gateway && gateway.reachable === true) {
    return { healthy: true, reason: "gateway reachable" };
  }
  return { healthy: false, reason: "openclaw status --json did not report gateway.reachable=true" };
}