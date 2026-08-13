-- P3 hardening: revoke anon EXECUTE on the SECURITY DEFINER farm write/resolve RPCs.
-- They are internally farm_can_write()-gated (anon calls already fail closed), but the
-- anon key ships publicly in the DalOS bundles, so remove the grant for defense-in-depth.
-- authenticated / service_role retain EXECUTE. Applied via Supabase MCP apply_migration
-- (ledger version 20260813092605); committed here for repo↔ledger parity.
revoke execute on function public.fn_split_block(uuid, jsonb, date, text) from anon, public;
revoke execute on function public.fn_replant_block(uuid, uuid, uuid, integer, date, boolean, text) from anon, public;
revoke execute on function public.farm_resolve_block(text, text, text, integer) from anon, public;
