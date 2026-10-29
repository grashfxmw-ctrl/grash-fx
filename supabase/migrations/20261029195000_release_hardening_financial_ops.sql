-- Release hardening: auditable admin balance adjustments, phone uniqueness, login-risk telemetry, and server-enforced plan cap.
create unique index if not exists profiles_phone_normalized_unique
  on public.profiles (lower(regexp_replace(trim(phone), '\s+', '', 'g')))
  where phone is not null and length(trim(phone)) > 0;

create table if not exists public.login_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ip_hash text,
  country_code text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists login_events_created_at_idx on public.login_events (created_at desc);
create index if not exists login_events_ip_hash_idx on public.login_events (ip_hash, created_at desc) where ip_hash is not null;
alter table public.login_events enable row level security;
revoke all on public.login_events from anon, authenticated;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare
  resolved_name text;
  resolved_phone text;
begin
  resolved_name := nullif(btrim(new.raw_user_meta_data ->> 'full_name'), '');
  if resolved_name is null then resolved_name := nullif(split_part(coalesce(new.email, ''), '@', 1), ''); end if;
  if resolved_name is null then resolved_name := 'New Client'; end if;
  resolved_phone := nullif(regexp_replace(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '\s+', '', 'g'), '');
  if resolved_phone is not null and resolved_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter a valid phone number in international format, for example +265XXXXXXXXX';
  end if;
  if resolved_phone is not null and exists (
    select 1 from public.profiles p
    where p.user_id <> new.id and lower(regexp_replace(trim(p.phone), '\s+', '', 'g')) = lower(resolved_phone)
  ) then
    raise exception 'This phone number is already linked to an account. Contact support if you need account recovery.';
  end if;
  insert into public.profiles (user_id, full_name, email, phone, status)
  values (new.id, left(resolved_name, 160), new.email, resolved_phone, 'pending')
  on conflict (user_id) do nothing;
  return new;
end;
$function$;

create or replace function public.admin_adjust_balance(
  p_target_user_id uuid,
  p_direction text,
  p_amount numeric,
  p_reason text,
  p_idempotency_key text
) returns uuid
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_amount numeric(20,2);
  v_balance numeric(20,2);
  v_reserved numeric(20,2);
  v_entry_id uuid;
begin
  if v_actor is null or not exists (
    select 1 from public.admin_roles
    where user_id = v_actor and role_name in ('administrator','finance_operator') and revoked_at is null
  ) then
    raise exception 'admin permission required' using errcode = '42501';
  end if;
  if p_target_user_id is null or p_direction not in ('credit','debit')
     or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2) or p_amount > 10000000
     or length(trim(coalesce(p_reason,''))) < 5 or length(trim(coalesce(p_reason,''))) > 500
     or length(trim(coalesce(p_idempotency_key,''))) < 8 or length(trim(coalesce(p_idempotency_key,''))) > 128 then
    raise exception 'valid customer, direction, amount, reason and idempotency key are required' using errcode = '22023';
  end if;
  perform 1 from public.profiles where user_id = p_target_user_id for update;
  if not found then raise exception 'customer profile not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.ledger_entries where idempotency_key = 'admin-adjust:' || trim(p_idempotency_key)) then
    select id into v_entry_id from public.ledger_entries where idempotency_key = 'admin-adjust:' || trim(p_idempotency_key);
    if exists (select 1 from public.ledger_entries where id = v_entry_id and user_id <> p_target_user_id) then
      raise exception 'idempotency key already used for another customer' using errcode = '23505';
    end if;
    return v_entry_id;
  end if;
  v_amount := round(p_amount,2);
  select coalesce(sum(amount),0) into v_balance
    from public.ledger_entries where user_id = p_target_user_id and currency = 'USD';
  select coalesce(sum(amount),0) into v_reserved
    from public.money_requests where user_id = p_target_user_id and request_type = 'withdrawal'
      and currency = 'USD' and status in ('submitted','under_review','approved');
  if p_direction = 'debit' and v_balance - v_reserved < v_amount then
    raise exception 'debit exceeds available balance after pending withdrawal reservations' using errcode = '22023';
  end if;
  insert into public.ledger_entries(user_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
  values (
    p_target_user_id,
    case when p_direction = 'credit' then 'adjustment_credit'::public.ledger_entry_type else 'adjustment_debit'::public.ledger_entry_type end,
    case when p_direction = 'credit' then v_amount else -v_amount end,
    'USD',
    'admin-adjust:' || trim(p_idempotency_key),
    'Administrator balance ' || p_direction || ': ' || left(trim(p_reason),400),
    v_actor,
    jsonb_build_object('direction',p_direction,'reason',trim(p_reason),'available_before',v_balance-v_reserved)
  ) returning id into v_entry_id;
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_actor,'balance.adjusted','profile',p_target_user_id,trim(p_reason),
    jsonb_build_object('ledger_entry_id',v_entry_id,'direction',p_direction,'amount',v_amount,'currency','USD','idempotency_key',trim(p_idempotency_key)));
  return v_entry_id;
end;
$function$;
revoke all on function public.admin_adjust_balance(uuid,text,numeric,text,text) from public, anon;
grant execute on function public.admin_adjust_balance(uuid,text,numeric,text,text) to authenticated;

create or replace function private.create_investment(p_plan_id uuid, p_amount numeric, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
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
  if v_user_id is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_plan_id is null or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2)
     or p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 or length(trim(p_idempotency_key)) > 128 then
    raise exception 'invalid investment request' using errcode = '22023';
  end if;
  v_amount := p_amount::numeric(20,2);
  select status into v_profile_status from public.profiles where user_id = v_user_id for update;
  if not found then raise exception 'client profile not found' using errcode = 'P0002'; end if;
  if v_profile_status <> 'active' then raise exception 'client account is not active' using errcode = '42501'; end if;
  select id,user_id into v_investment_id,v_existing_user from public.investments where idempotency_key = trim(p_idempotency_key);
  if found then
    if v_existing_user <> v_user_id then raise exception 'idempotency key already used' using errcode = '23505'; end if;
    return v_investment_id;
  end if;
  select * into v_plan from public.investment_plans
  where id = p_plan_id and is_active = true and approval_status = 'approved'
    and (effective_from is null or effective_from <= v_started_at)
    and (effective_until is null or effective_until > v_started_at)
  for share;
  if not found then raise exception 'investment plan is not available' using errcode = '22023'; end if;
  if v_amount < v_plan.minimum_amount then raise exception 'amount is below this plan minimum' using errcode = '22023'; end if;
  if v_plan.plan_code = 'starter' and v_amount > 500 then raise exception 'Starter plan maximum is $500.00' using errcode = '22023'; end if;
  if v_plan.term_days <> 7 or v_plan.rate_basis <> 'simple_daily' then
    raise exception 'plan term or rate basis is not supported by this investment engine' using errcode = '22023';
  end if;
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries
    where user_id = v_user_id and currency = v_plan.currency;
  v_balance := v_balance - coalesce((select sum(amount) from public.money_requests
    where user_id = v_user_id and request_type = 'withdrawal' and currency = v_plan.currency
      and status in ('submitted','under_review','approved')),0);
  if v_balance < v_amount then raise exception 'insufficient available balance after pending withdrawals' using errcode = '22023'; end if;
  insert into public.investments(user_id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,rate_basis_snapshot,
    status,requested_at,started_at,matures_at,idempotency_key,created_by)
  values(v_user_id,v_plan.id,v_amount,v_plan.currency,v_plan.daily_rate,v_plan.term_days,v_plan.rate_basis,
    'active',v_started_at,v_started_at+make_interval(days=>v_plan.term_days),trim(p_idempotency_key),v_user_id)
  returning id into v_investment_id;
  insert into public.ledger_entries(user_id,investment_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
  values(v_user_id,v_investment_id,'investment_principal_debit',-v_amount,v_plan.currency,
    'investment-principal:'||v_investment_id::text,'Principal allocated to investment',v_user_id,
    jsonb_build_object('plan_code',v_plan.plan_code,'plan_version',v_plan.version));
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_user_id,'investment.created','investment',v_investment_id,'Client submitted an eligible investment request',
    jsonb_build_object('amount',v_amount,'currency',v_plan.currency,'plan_id',v_plan.id));
  return v_investment_id;
end;
$function$;
