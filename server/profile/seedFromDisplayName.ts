import type { PoolClient } from "pg";
import { splitDisplayNameForProfile } from "./displayNameSplit";

/** تعبئة أولية للاسم من العرض الخارجي إذا كان الصف موجوداً وfirst_name لا يزال فارغاً. */
export async function seedUserProfileNamesIfEmpty(
  client: PoolClient,
  userId: string,
  displayName: string | null | undefined,
): Promise<void> {
  const trimmed = String(displayName ?? "").trim();
  if (!trimmed) return;
  const { firstName, lastName } = splitDisplayNameForProfile(trimmed);
  if (!firstName) return;
  await client.query(
    `UPDATE public.user_profiles
     SET first_name = $2::text,
         last_name = $3::text,
         updated_at = NOW()
     WHERE user_id = $1::uuid
       AND first_name IS NULL`,
    [userId, firstName, lastName],
  );
}
