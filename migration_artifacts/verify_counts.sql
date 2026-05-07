SELECT COUNT(*) AS public_tables
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

SELECT COUNT(*) AS foreign_keys
FROM information_schema.table_constraints
WHERE table_schema = 'public' AND constraint_type = 'FOREIGN KEY';

SELECT COUNT(*) AS indexes
FROM pg_indexes
WHERE schemaname = 'public';

SELECT COUNT(*) AS migrations_count
FROM public.schema_migrations;

SELECT
  'ai_factory_jobs' AS table_name, COUNT(*) AS row_count
FROM public.ai_factory_jobs
UNION ALL SELECT 'ai_factory_job_logs', COUNT(*) FROM public.ai_factory_job_logs
UNION ALL SELECT 'ai_factory_inspection_logs', COUNT(*) FROM public.ai_factory_inspection_logs
UNION ALL SELECT 'ai_usage_logs', COUNT(*) FROM public.ai_usage_logs
UNION ALL SELECT 'questions', COUNT(*) FROM public.questions
UNION ALL SELECT 'lessons', COUNT(*) FROM public.lessons
UNION ALL SELECT 'lesson_items', COUNT(*) FROM public.lesson_items
UNION ALL SELECT 'simple_content_runs', COUNT(*) FROM public.simple_content_runs
UNION ALL SELECT 'simple_content_pricing_audit_logs', COUNT(*) FROM public.simple_content_pricing_audit_logs
ORDER BY table_name;
