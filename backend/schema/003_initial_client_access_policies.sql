-- GRASH FX Foundation: initial client-access policies.
-- Supabase Auth is the identity provider for this foundation.
-- Financial writes and administrative access remain server-only until dedicated,
-- audited server-side workflows and administrator authorization are implemented.

ALTER FUNCTION public.reject_ledger_mutation() SET search_path = pg_catalog, public;

CREATE POLICY "clients_read_own_profile"
ON public.profiles
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "clients_read_available_plans"
ON public.investment_plans
FOR SELECT TO anon, authenticated
USING (
  is_active = true
  AND approval_status = 'approved'
  AND (effective_from IS NULL OR effective_from <= now())
  AND (effective_until IS NULL OR effective_until > now())
);

CREATE POLICY "clients_read_own_investments"
ON public.investments
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "clients_read_own_money_requests"
ON public.money_requests
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "clients_read_own_ledger_entries"
ON public.ledger_entries
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "clients_read_own_referrals"
ON public.referrals
FOR SELECT TO authenticated
USING (
  referrer_user_id = (SELECT auth.uid())
  OR referred_user_id = (SELECT auth.uid())
);

CREATE POLICY "clients_read_own_support_tickets"
ON public.support_tickets
FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY "clients_create_own_support_tickets"
ON public.support_tickets
FOR INSERT TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND status = 'open'
  AND assigned_to IS NULL
);

CREATE INDEX IF NOT EXISTS investments_user_id_created_at_idx
ON public.investments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS money_requests_user_id_submitted_at_idx
ON public.money_requests (user_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS ledger_entries_user_id_created_at_idx
ON public.ledger_entries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS referrals_referrer_user_id_idx
ON public.referrals (referrer_user_id);

CREATE INDEX IF NOT EXISTS referrals_referred_user_id_idx
ON public.referrals (referred_user_id);

CREATE INDEX IF NOT EXISTS support_tickets_user_id_created_at_idx
ON public.support_tickets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS investments_plan_id_idx
ON public.investments (plan_id);

CREATE INDEX IF NOT EXISTS ledger_entries_related_entry_id_idx
ON public.ledger_entries (related_entry_id);
