import { runFactoryJob } from "./orchestrator";

export type QueueJobInput = {
  id: number;
  subcategory_key: string;
  difficulty_mode: "mix" | "easy" | "medium" | "hard";
  target_count: number;
  batch_size: number;
  status: string;
  payload: unknown;
  attempt_count: number;
  max_attempts: number;
};

export async function processFactoryQueueJob(job: QueueJobInput): Promise<void> {
  await runFactoryJob(job);
}
