-- Published policies are immutable. docs/03-domain-model.md §2, dev-logs/015.
--
-- WHY THIS EXISTS
--
-- Every money event carries `authority.policyVersion`. The audit trail's whole
-- claim — "you can reconstruct why a rupee moved without reading our code" —
-- depends on being able to look up what version 4 actually SAID, years later.
--
-- That makes a policy row not a config record but a historical fact. Editing v4
-- would silently rewrite the authority that already-settled events cite: a
-- booking cancelled under a 50% tier would, on re-reading, appear to have been
-- cancelled under whatever the row says today. The trail would not merely go
-- stale — it would confidently lie, with no way to detect it.
--
-- Deleting a policy row is worse still: every event citing that version becomes
-- unresolvable, and the trail's authority chain breaks outright.
--
-- Application code already publishes by INSERT only (`publishPolicy` — a plain
-- insert with a server-derived version). This trigger is the same move the rest
-- of the system makes everywhere it matters: push the guarantee down to a layer
-- that cannot be talked out of it, so it holds even if a future code path
-- forgets. Compare `one_live_booking_per_slot` (migration 0001) — an `if` can be
-- raced or omitted; a database constraint cannot.
--
-- SCOPE OF THE GUARANTEE — read before relying on it
--
-- This blocks ACCIDENTS, not attackers. The escape hatch below is deliberately
-- reachable by anything that can open a session. Making it malice-proof needs
-- role separation — an application role holding no UPDATE/DELETE grant on this
-- table, with migrations run as a separate owner — which this deployment does
-- not yet have. That is the production hardening step; this is the guard that
-- stops a stray `db.update(policies)` in a future slice.

CREATE OR REPLACE FUNCTION latch_policies_immutable() RETURNS trigger AS $$
BEGIN
  -- Test fixtures need to clean up rows they created. An explicit
  --   SET LOCAL latch.allow_policy_mutation = 'on'
  -- inside the cleanup transaction is a deliberate, visible opt-out — it cannot
  -- happen by accident, and `LOCAL` scopes it to that transaction alone.
  IF current_setting('latch.allow_policy_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'policies is append-only: % on policy_id=% is blocked',
      TG_OP, COALESCE(OLD.policy_id, '?')
    USING
      HINT   = 'Publish a new version with publishPolicy() instead of mutating an existing one. Test cleanup may SET LOCAL latch.allow_policy_mutation = ''on''.',
      ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER policies_immutable
  BEFORE UPDATE OR DELETE ON "policies"
  FOR EACH ROW EXECUTE FUNCTION latch_policies_immutable();
