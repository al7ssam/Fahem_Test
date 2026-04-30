import cron, { type ScheduledTask } from "node-cron";
import { runSimpleContentSchedulerTick } from "./service";

let scheduledTask: ScheduledTask | null = null;

export function startSimpleContentScheduler(): void {
  if (scheduledTask) return;
  scheduledTask = cron.schedule("* * * * *", () => {
    void runSimpleContentSchedulerTick().catch((error) => {
      console.error("[simple_content_scheduler] tick-level failure", error);
    });
  });
}

export function stopSimpleContentScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}
