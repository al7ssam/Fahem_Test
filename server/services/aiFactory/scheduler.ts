import { readFactorySettings } from "./runtime";

export async function getSchedulerSnapshot(): Promise<{
  enabled: boolean;
  intervalMinutes: number;
  lastSchedulerRun: string;
}> {
  const settings = await readFactorySettings();
  return {
    enabled: settings.enabled,
    intervalMinutes: settings.intervalMinutes,
    lastSchedulerRun: settings.lastSchedulerRun,
  };
}
