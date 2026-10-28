-- GRASH FX Step 5: server-side financial engine.
-- This migration is deliberately gated: no plan is activated by this file.
-- All financial writes are performed by guarded database functions.

begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- Client-facing RPC wrapper: callers cannot choose a user_id or set trusted rates.
create or replace function private.create_investment(
  p_plan_id uuid,
  p_amount numeric,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile_status public.account_status;
  v_plan public.investment_plans%rowtype;
  v_amount numeric(20,2);
  v_balance numeric(20,2);
  v_investment_id uuid;
  v_existing_user uuid;
  v_started_at timestamptz := clock_timestamp();
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_plan_id is null
     or p_amount is null
     or p_amount <= 0
     or p_amount <> round(p_amount, 2)
     or p_idempotency_key is null
     or length(trim(p_idempotency_key)) < 8
     or length(trim(p_idempotency_key)) > 128 then
    raise exception 'invalid investment request' using errcode = '22023';
  end if;

  v_amount := p_amount::numeric(20,2);

  -- Serialize financial requests per user so concurrent requests cannot overspend.
  select status into v_profile_status
  from public.profiles
  where user_id = v_user_id
  for update;

  if not found then
    raise exception 'client profile not found' using errcode = 'P0002';
  end if;
  if v_profile_status <> 'active' then
    raise exception 'client account is not active' using errcode = '42501';
  end if;

  select id, user_id into v_investment_id, v_existing_user
  from public.investments
  where idempotency_key = trim(p_idempotency_key);

  if found then
    if v_existing_user <> v_user_id then
      raise exception 'idempotency key already used' using errcode = '23505';
    end if;
    return v_investment_id;
  end if;

  select * into v_plan
  from public.investment_plans
  where id = p_plan_id
    and is_active = true
    and approval_status = 'approved'
    and (effective_from is null or effective_from <= v_started_at)
    and (effective_until is null or effective_until > v_started_at)
  for share;

  if not found then
    raise exception 'investment plan is not available' using errcode = '22023';
  end if;

  if v_amount < v_plan.minimum_amount then
    raise exception 'amount is below this plan minimum' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0)
    into v_balance
  from public.ledger_entries
  where user_id = v_user_id
    and currency = v_plan.currency;

  if v_balance < v_amount then
    raise exception 'insufficient available balance' using errcode = '22023';
  end if;

  insert into public.investments (
    user_id, plan_id, principal_amount, currency,
    daily_rate_snapshot, term_days_snapshot, rate_basis_snapshot,
    status, requested_at, started_at, matures_at,
    idempotency_key, created_by
  ) values (
    v_user_id, v_plan.id, v_amount, v_plan.currency,
    v_plan.daily_rate, v_plan.term_days, v_plan.rate_basis,
    'active', v_started_at, v_started_at + make_interval(days => v_plan.term_days),
    trim(p_idempotency_key), v_user_id
  )
  returning id into v_investment_id;

  insert into public.ledger_entries (
    user_id, investment_id, entry_type, amount, currency,
    idempotency_key, description, created_by, metadata
  ) values (
    v_user_id, v_investment_id, 'investment_principal_debit', -v_amount, v_plan.currency,
    'investment-principal:' || v_investment_id::text,
    'Principal allocated to investment', v_user_id,
    jsonb_build_object('plan_code', v_plan.plan_code, 'plan_version', v_plan.version)
  );

  insert into public.audit_events (
    actor_user_id, action, entity_type, entity_id, reason, details
  ) values (
    v_user_id, 'investment.created', 'investment', v_investment_id,
    'Client submitted an eligible investment request',
    jsonb_build_object('amount', v_amount, 'currency', v_plan.currency, 'plan_id', v_plan.id)
  );

  return v_investment_id;
end;
$$;

-- Public RPC wrapper is invoker-security only; elevated work stays in private schema.
create or replace function public.request_investment(
  p_plan_id uuid,
  p_amount numeric,
  p_idempotency_key text
)
returns uuid
language sql
security invoker
set search_path = pg_catalog, public
as $$
  select private.create_investment(p_plan_id, p_amount, p_idempotency_key);
$$;

revoke all on function private.create_investment(uuid, numeric, text) from public, anon;
grant execute on function private.create_investment(uuid, numeric, text) to authenticated;
revoke all on function public.request_investment(uuid, numeric, text) from public, anon;
grant execute on function public.request_investment(uuid, numeric, text) to authenticated;

-- Trusted worker: mature due investments exactly once in a single transaction.
-- This function has no client-facing wrapper and is executable only by service_role.
create or replace function private.mature_due_investments()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inv public.investments%rowtype;
  v_profit numeric(20,2);
  v_processed integer := 0;
  v_now timestamptz := clock_timestamp();
begin
  for v_inv in
    select *
    from public.investments
    where status = 'active'
      and matures_at is not null
      and matures_at <= v_now
    order by matures_at, id
    for update skip locked
  loop
    -- Deterministic unique keys plus row locking make retries safe.
    insert into public.ledger_entries (
      user_id, investment_id, entry_type, amount, currency,
      idempotency_key, description, created_by, metadata
    ) values (
      v_inv.user_id, v_inv.id, 'principal_return_credit', v_inv.principal_amount,
      v_inv.currency, 'maturity-principal:' || v_inv.id::text,
      'Investment principal returned at maturity', null,
      jsonb_build_object('matured_at', v_now)
    ) on conflict (idempotency_key) do nothing;

    v_profit := round(
      v_inv.principal_amount * v_inv.daily_rate_snapshot * v_inv.term_days_snapshot,
      2
    );

    if v_profit > 0 then
      insert into public.ledger_entries (
        user_id, investment_id, entry_type, amount, currency,
        idempotency_key, description, created_by, metadata
      ) values (
        v_inv.user_id, v_inv.id, 'profit_credit', v_profit, v_inv.currency,
        'maturity-profit:' || v_inv.id::text,
        'Plan profit credited at maturity', null,
        jsonb_build_object(
          'daily_rate_snapshot', v_inv.daily_rate_snapshot,
          'term_days_snapshot', v_inv.term_days_snapshot,
          'rate_basis_snapshot', v_inv.rate_basis_snapshot,
          'matured_at', v_now
        )
      ) on conflict (idempotency_key) do nothing;
    end if;

    update public.investments
      set status = 'matured', matured_at = v_now
    where id = v_inv.id and status = 'active';

    if found then
      insert into public.audit_events (
        actor_user_id, action, entity_type, entity_id, reason, details
      ) values (
        null, 'investment.matured', 'investment', v_inv.id,
        'Scheduled server-side maturity process',
        jsonb_build_object('principal', v_inv.principal_amount, 'profit', v_profit, 'currency', v_inv.currency)
      );
      v_processed := v_processed + 1;
    end if;
  end loop;

  return v_processed;
end;
$$;

revoke all on function private.mature_due_investments() from public, anon, authenticated;
grant execute on function private.mature_due_investments() to service_role;

commit;
