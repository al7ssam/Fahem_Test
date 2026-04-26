-- وصف داخلي للتصنيف الفرعي فقط.

ALTER TABLE question_subcategories
  ADD COLUMN IF NOT EXISTS internal_description TEXT NOT NULL DEFAULT '';
