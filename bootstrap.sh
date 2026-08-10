#!/usr/bin/env bash
# Populate supabase/migrations/ from the live project and verify the schema.
# The 31 farm migrations are recorded server-side; `migration fetch` copies them
# byte-exactly, so they are never hand-written.
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-sfyjvgjwvtwkrnqrvqyc}"

command -v supabase >/dev/null || { echo "supabase CLI not found: https://supabase.com/docs/guides/local-development"; exit 1; }

echo "==> linking $PROJECT_REF"
supabase link --project-ref "$PROJECT_REF"

echo "==> fetching remote migration history into supabase/migrations/"
supabase migration fetch

echo "==> local vs remote"
supabase migration list

echo
echo "==> farm migrations pulled:"
ls -1 supabase/migrations/ | grep -c farm_ || true
echo "    (expected: 31)"

echo
echo "==> schema verification — every row must read PASS"
if [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -f db/verify-schema.sql
else
  echo "    DATABASE_URL not set. Run manually:"
  echo "    psql \"\$DATABASE_URL\" -f db/verify-schema.sql"
fi

echo
echo "==> generating types"
supabase gen types typescript --project-id "$PROJECT_REF" > src/types/database.ts 2>/dev/null \
  && echo "    wrote src/types/database.ts" \
  || echo "    src/ does not exist yet — run this once the app scaffold is in place"
