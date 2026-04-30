import cron, { type ScheduledTask } from "node-cron";
import { runSimpleContentSchedulerTick } from "./service";

let scheduledTask: ScheduledTask | null = null;

export function startSimpleContentScheduler(): void {
  if (scheduledTask) return;
  scheduledTask = cron.schedule("* * * * *", () => {
    void runSimpleContentSchedulerTick().catch(() => {
      // errors are persisted per-run in simple_content_runs
    });
  });
}

export function stopSimpleContentScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
