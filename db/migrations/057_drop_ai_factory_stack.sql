-- إزالة جداول مصنع المحتوى ذي الطبقات بعد توقف التطبيق عن استخدامها.
-- تحذير: يحذف سجلات الاستخدام السابقة في ai_usage_logs ثم يُعيد إنشاء الجدول بلا FK إلى ai_factory_jobs.

DROP TABLE IF EXISTS public.ai_usage_logs CASCADE;
DROP TABLE IF EXISTS public.ai_factory_inspection_logs CASCADE;
DROP TABLE IF EXISTS public.ai_factory_job_logs CASCADE;
DROP TABLE IF EXISTS public.ai_factory_pipeline_state CASCADE;
DROP TABLE IF EXISTS public.ai_factory_jobs CASCADE;
DROP TABLE IF EXISTS public.ai_factory_model_config CASCADE;

CREATE TABLE IF NOT EXISTS public.ai_usage_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL,
  model_id TEXT NOT NULL,
  layer_type TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  cost_sar NUMERIC(12, 6) NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pricing_input_per_1m DOUBLE PRECISION,
  pricing_cached_input_per_1m DOUBLE PRECISION,
  pricing_output_per_1m DOUBLE PRECISION,
  pricing_source TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_created_at ON public.ai_usage_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_subject_created ON public.ai_usage_logs (subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_model_created ON public.ai_usage_logs (model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_layer_created ON public.ai_usage_logs (layer_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_subject_model_created ON public.ai_usage_logs (subject, model_id, created_at DESC);

DELETE FROM public.app_settings WHERE key LIKE 'ai_factory%';
