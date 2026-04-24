import { getPool, closePool } from "../db/pool";
import { config } from "../config";

const samples: Array<{
  prompt: string;
  options: string[];
  correct_index: number;
  difficulty?: string;
  study_body?: string;
}> = [
  {
    prompt: "ما عاصمة المملكة العربية السعودية؟",
    options: ["الرياض", "جدة", "مكة المكرمة", "الدمام"],
    correct_index: 0,
    difficulty: "easy",
    study_body: "الرياض هي عاصمة المملكة العربية السعودية.",
  },
  {
    prompt: "كم ناتج ٧ × ٨؟",
    options: ["54", "56", "63", "49"],
    correct_index: 1,
    difficulty: "easy",
  },
  {
    prompt: "أي من التالي كوكب؟",
    options: ["القمر", "بلوتو", "الشمس", "سيريوس"],
    correct_index: 1,
    difficulty: "medium",
  },
  {
    prompt: "ما اللغة المستخدمة لتنسيق صفحات الويب؟",
    options: ["Python", "CSS", "SQL", "C++"],
    correct_index: 1,
    difficulty: "easy",
  },
  {
    prompt: "في أي قارة تقع مصر؟",
    options: ["آسيا", "أوروبا", "أفريقيا", "أمريكا الجنوبية"],
    correct_index: 2,
    difficulty: "easy",
  },
];

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is required for seed");
    process.exit(1);
  }
  const pool = getPool();
  const count = await pool.query("SELECT COUNT(*)::int AS c FROM questions");
  if (count.rows[0].c > 0) {
    console.log("Questions already exist, skipping seed.");
    await closePool();
    return;
  }
  for (const q of samples) {
    await pool.query(
      `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body)
       VALUES ($1, $2::jsonb, $3, $4, $5)`,
      [
        q.prompt,
        JSON.stringify(q.options),
        q.correct_index,
        q.difficulty ?? null,
        q.study_body ?? null,
      ],
    );
  }
  console.log(`Seeded ${samples.length} questions.`);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
