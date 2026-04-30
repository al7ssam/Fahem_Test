import { getPool } from "../../db/pool";
import type { FactoryQuestion } from "../aiFactory/types";

export async function insertSimpleContentQuestions(questions: FactoryQuestion[]): Promise<number[]> {
  const pool = getPool();
  const client = await pool.connect();
  const ids: number[] = [];
  try {
    await client.query("BEGIN");
    for (const q of questions) {
      const ins = await client.query<{ id: number }>(
        `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body, subcategory_key, question_type)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          q.prompt,
          JSON.stringify(q.options),
          q.correctIndex,
          q.difficulty,
          q.studyBody,
          q.subcategoryKey,
          q.questionType,
        ],
      );
      const id = ins.rows[0]?.id;
      if (id != null) ids.push(id);
    }
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}
