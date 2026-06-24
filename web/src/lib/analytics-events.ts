import { env } from "cloudflare:workers";

let warnedBeforeCutover = false;
let warnedInvalidCutover = false;

function isAnalyticsEngineCutoverReached(): boolean {
  const cutoverDate = env.ANALYTICS_ENGINE_CUTOVER_DATE;
  if (!cutoverDate) return true;

  const parsedCutoverDate = new Date(`${cutoverDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate) ||
    Number.isNaN(parsedCutoverDate.getTime()) ||
    parsedCutoverDate.toISOString().slice(0, 10) !== cutoverDate
  ) {
    if (!warnedInvalidCutover) {
      warnedInvalidCutover = true;
      console.warn(
        "analytics_events_cutover_invalid",
        JSON.stringify({
          cutover_date: cutoverDate,
        }),
      );
    }
    return true;
  }

  const today = new Date().toISOString().slice(0, 10);
  return today >= cutoverDate;
}

export function analyticsEventsBinding(): AnalyticsEngineDataset | undefined {
  if (env.ANALYTICS_EVENTS && !isAnalyticsEngineCutoverReached()) {
    if (!warnedBeforeCutover) {
      warnedBeforeCutover = true;
      console.warn(
        "analytics_events_disabled",
        JSON.stringify({
          reason: "before_analytics_engine_cutover",
          cutover_date: env.ANALYTICS_ENGINE_CUTOVER_DATE,
        }),
      );
    }
    return undefined;
  }

  return env.ANALYTICS_EVENTS;
}
