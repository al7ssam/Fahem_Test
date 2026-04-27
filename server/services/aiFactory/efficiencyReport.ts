import { getPool } from "../../db/pool";
import { getFactoryInspectionLogs } from "./orchestrator";

const REPORT_VERSION = 1 as const;
const ALL_LAYERS = ["architect", "creator", "auditor", "refiner"] as const;
export type EfficiencyLayerName = (typeof ALL_LAYERS)[number];

export type EfficiencyCallEntry = {
  inspectionLogId: number;
  layer: EfficiencyLayerName | string;
  modelName: string;
  createdAt: string;
  promptTokenCount: number;
  thoughtsTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  parseOk: boolean;
  parseError?: string;
};

export type EfficiencyLayerAggregate = {
  promptTokenCount: number;
  thoughtsTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
  callCount: number;
};

export type EfficiencyUsageLogRow = {
  layerType: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type FactoryJobEfficiencyReport = {
  version: typeof REPORT_VERSION;
  jobId: number;
  generatedAt: string;
  dataSource: string;
  notes: string[];
  calls: EfficiencyCallEntry[];
  byLayer: Record<string, EfficiencyLayerAggregate>;
  totals: {
    promptTokenCount: number;
    thoughtsTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  indicators: {
    thoughtsShareOfTotal: number | null;
    dominantLayerByTotal: string | null;
    layerShareOfTotalTokensPercent: Record<string, number>;
  };
  missingLayers: string[];
  usageLogCrossCheck: EfficiencyUsageLogRow[];
};

function safeInt(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Extract Gemini usageMetadata from stored inspection raw_response_text (full SDK response JSON). */
export function parseUsageFromInspectionRaw(rawResponseText: string): {
  promptTokenCount: number;
  thoughtsTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
} | null {
  const raw = String(rawResponseText ?? "").trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const usage = root.usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const promptTokenCount = safeInt(u.promptTokenCount);
  const thoughtsTokenCount = safeInt(u.thoughtsTokenCount);
  const candidatesTokenCount = safeInt(u.candidatesTokenCount);
  const totalFromApi = safeInt(u.totalTokenCount);
  const totalTokenCount =
    totalFromApi > 0 ? totalFromApi : promptTokenCount + thoughtsTokenCount + candidatesTokenCount;
  return {
    promptTokenCount,
    thoughtsTokenCount,
    candidatesTokenCount,
    totalTokenCount,
  };
}

function emptyAggregate(): EfficiencyLayerAggregate {
  return {
    promptTokenCount: 0,
    thoughtsTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
    callCount: 0,
  };
}

async function loadUsageLogCrossCheck(jobId: number): Promise<EfficiencyUsageLogRow[]> {
  const pool = getPool();
  const r = await pool.query<{
    layer_type: string;
    input_sum: string;
    output_sum: string;
    cost_sum: string;
  }>(
    `SELECT layer_type::text,
            COALESCE(SUM(input_tokens), 0)::text AS input_sum,
            COALESCE(SUM(output_tokens), 0)::text AS output_sum,
            COALESCE(SUM(cost_usd), 0)::text AS cost_sum
     FROM ai_usage_logs
     WHERE job_id = $1
     GROUP BY layer_type
     ORDER BY layer_type`,
    [jobId],
  );
  return r.rows.map((row) => ({
    layerType: row.layer_type,
    inputTokens: Number(row.input_sum || 0),
    outputTokens: Number(row.output_sum || 0),
    costUsd: Number(row.cost_sum || 0),
  }));
}

/**
 * Efficiency report for one factory job from inspection logs (usageMetadata) + usage_logs cross-check.
 */
export async function buildFactoryJobEfficiencyReport(jobId: number): Promise<FactoryJobEfficiencyReport> {
  const entries = await getFactoryInspectionLogs(jobId);
  const calls: EfficiencyCallEntry[] = [];
  const byLayer: Record<string, EfficiencyLayerAggregate> = {};

  for (const layer of ALL_LAYERS) {
    byLayer[layer] = emptyAggregate();
  }

  for (const row of entries) {
    const parsed = parseUsageFromInspectionRaw(row.rawResponseText);
    const layerKey = String(row.layerName || "unknown");
    if (!byLayer[layerKey]) {
      byLayer[layerKey] = emptyAggregate();
    }
    const agg = byLayer[layerKey];
    if (parsed) {
      agg.promptTokenCount += parsed.promptTokenCount;
      agg.thoughtsTokenCount += parsed.thoughtsTokenCount;
      agg.candidatesTokenCount += parsed.candidatesTokenCount;
      agg.totalTokenCount += parsed.totalTokenCount;
      agg.callCount += 1;
      calls.push({
        inspectionLogId: row.id,
        layer: row.layerName,
        modelName: row.modelName,
        createdAt: row.createdAt,
        promptTokenCount: parsed.promptTokenCount,
        thoughtsTokenCount: parsed.thoughtsTokenCount,
        candidatesTokenCount: parsed.candidatesTokenCount,
        totalTokenCount: parsed.totalTokenCount,
        parseOk: true,
      });
    } else {
      agg.callCount += 1;
      calls.push({
        inspectionLogId: row.id,
        layer: row.layerName,
        modelName: row.modelName,
        createdAt: row.createdAt,
        promptTokenCount: 0,
        thoughtsTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
        parseOk: false,
        parseError: "usage_metadata_missing_or_invalid_json",
      });
    }
  }

  const totals = {
    promptTokenCount: 0,
    thoughtsTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0,
  };
  for (const key of Object.keys(byLayer)) {
    const a = byLayer[key];
    totals.promptTokenCount += a.promptTokenCount;
    totals.thoughtsTokenCount += a.thoughtsTokenCount;
    totals.candidatesTokenCount += a.candidatesTokenCount;
    totals.totalTokenCount += a.totalTokenCount;
  }

  const grandTotal = totals.totalTokenCount;
  const layerShareOfTotalTokensPercent: Record<string, number> = {};
  for (const layer of [...ALL_LAYERS, ...Object.keys(byLayer).filter((k) => !ALL_LAYERS.includes(k as EfficiencyLayerName))]) {
    if (!byLayer[layer]) continue;
    const t = byLayer[layer].totalTokenCount;
    layerShareOfTotalTokensPercent[layer] =
      grandTotal > 0 ? Math.round((t / grandTotal) * 1000) / 10 : 0;
  }

  let dominantLayerByTotal: string | null = null;
  let maxT = -1;
  for (const layer of ALL_LAYERS) {
    const t = byLayer[layer].totalTokenCount;
    if (t > maxT) {
      maxT = t;
      dominantLayerByTotal = layer;
    }
  }
  if (maxT <= 0) dominantLayerByTotal = null;

  const thoughtsShareOfTotal =
    grandTotal > 0 ? Math.round((totals.thoughtsTokenCount / grandTotal) * 1000) / 1000 : null;

  const missingLayers = ALL_LAYERS.filter((l) => byLayer[l].callCount === 0);
  const usageLogCrossCheck = await loadUsageLogCrossCheck(jobId);

  const notes = [
    "التفصيل من usageMetadata داخل استجابة المزود المحفوظة في ai_factory_inspection_logs.",
    "تعدد النداءات لنفس الطبقة: يُجمع بالجمع.",
    "usageLogCrossCheck: ai_usage_logs (input_tokens ≈ prompt، output_tokens ≈ candidates).",
  ];

  return {
    version: REPORT_VERSION,
    jobId,
    generatedAt: new Date().toISOString(),
    dataSource: "ai_factory_inspection_logs.raw_response_text → usageMetadata",
    notes,
    calls,
    byLayer,
    totals,
    indicators: {
      thoughtsShareOfTotal,
      dominantLayerByTotal,
      layerShareOfTotalTokensPercent,
    },
    missingLayers,
    usageLogCrossCheck,
  };
}
