-- GRASH FX Step 7: manual deposit and withdrawal requests.
-- No payment gateway or automatic payout is connected by this migration.
begin;

alter table public.money_requests
  add column if not exists payment_method text,
  add column if not exists payment_details jsonb not null default '{}'::jsonb;
alter table public.money_requests
  add constraint money_requests_payment_method_check
  check (payment_method is null or payment_method in ('bank_transfer','eft'));
alter table public.money_requests
  add constraint money_requests_payment_details_object_check
  check (jsonb_typeof(payment_details) = 'object');
create unique index if not exists money_requests_external_payment_reference_uidx
  on public.money_requests(external_payment_reference)
  where external_payment_reference is not null;

-- Reserve funds for pending withdrawals when the client creates an investment.
create or replace function private.create_investment(
  p_plan_id uuid, p_amount numeric, p_idempotency_key text
) returns uuid
language plpgsql security definer
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
  if v_user_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_plan_id is null or p_amount is null or p_amount <= 0
     or p_amount <> round(p_amount,2) or p_idempotency_key is null
     or length(trim(p_idempotency_key)) < 8 or length(trim(p_idempotency_key)) > 128 then
    raise exception 'invalid investment request' using errcode='22023';
  end if;
  v_amount := p_amount::numeric(20,2);
  select status into v_profile_status from public.profiles where user_id=v_user_id for update;
  if not found then raise exception 'client profile not found' using errcode='P0002'; end if;
  if v_profile_status <> 'active' then raise exception 'client account is not active' using errcode='42501'; end if;

  select id,user_id into v_investment_id,v_existing_user
  from public.investments where idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing_user <> v_user_id then raise exception 'idempotency key already used' using errcode='23505'; end if;
    return v_investment_id;
  end if;

  select * into v_plan from public.investment_plans
  where id=p_plan_id and is_active=true and approval_status='approved'
    and (effective_from is null or effective_from <= v_started_at)
    and (effective_until is null or effective_until > v_started_at) for share;
  if not found then raise exception 'investment plan is not available' using errcode='22023'; end if;
  if v_amount < v_plan.minimum_amount then raise exception 'amount is below this plan minimum' using errcode='22023'; end if;

  select coalesce(sum(amount),0) into v_balance from public.ledger_entries
  where user_id=v_user_id and currency=v_plan.currency;
  v_balance := v_balance - coalesce((
    select sum(amount) from public.money_requests
    where user_id=v_user_id and request_type='withdrawal' and currency=v_plan.currency
      and status in ('submitted','under_review','approved')
  ),0);
  if v_balance < v_amount then raise exception 'insufficient available balance after pending withdrawals' using errcode='22023'; end if;

  insert into public.investments(
    user_id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,
    rate_basis_snapshot,status,requested_at,started_at,matures_at,idempotency_key,created_by
  ) values (
    v_user_id,v_plan.id,v_amount,v_plan.currency,v_plan.daily_rate,v_plan.term_days,v_plan.rate_basis,
    'active',v_started_at,v_started_at+make_interval(days=>v_plan.term_days),trim(p_idempotency_key),v_user_id
  ) returning id into v_investment_id;

  insert into public.ledger_entries(user_id,investment_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
  values(v_user_id,v_investment_id,'investment_principal_debit',-v_amount,v_plan.currency,
    'investment-principal:'||v_investment_id::text,'Principal allocated to investment',v_user_id,
    jsonb_build_object('plan_code',v_plan.plan_code,'plan_version',v_plan.version));
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_user_id,'investment.created','investment',v_investment_id,'Client submitted an eligible investment request',
    jsonb_build_object('amount',v_amount,'currency',v_plan.currency,'plan_id',v_plan.id));
  return v_investment_id;
end;
$$;

create or replace function private.submit_money_request(
  p_request_type text, p_amount numeric, p_currency text, p_payment_method text,
  p_payment_details jsonb, p_client_reference text, p_idempotency_key text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_status public.account_status;
  v_amount numeric(20,2);
  v_request_id uuid;
  v_existing public.money_requests%rowtype;
  v_balance numeric(20,2);
  v_details jsonb := coalesce(p_payment_details,'{}'::jsonb);
begin
  if v_user_id is null then raise exception 'authentication required' using errcode='28000'; end if;
  if p_request_type is null or p_request_type not in ('deposit','withdrawal')
     or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2)
     or p_currency is null or upper(p_currency) <> 'USD'
     or p_payment_method is null or p_payment_method not in ('bank_transfer','eft')
     or p_idempotency_key is null or length(trim(p_idempotency_key)) < 8
     or length(trim(p_idempotency_key)) > 128 or jsonb_typeof(v_details) <> 'object'
     or length(v_details::text) > 2000 then
    raise exception 'invalid money request' using errcode='22023';
  end if;
  if p_request_type='deposit' and (p_client_reference is null
     or length(trim(p_client_reference)) < 3 or length(trim(p_client_reference)) > 120) then
    raise exception 'deposit transfer reference is required' using errcode='22023';
  end if;
  if p_request_type='withdrawal' and (v_details='{}'::jsonb
     or not (v_details ? 'account_holder') or not (v_details ? 'account_number')
     or length(trim(coalesce(v_details->>'account_holder',''))) < 2
     or length(trim(coalesce(v_details->>'account_number',''))) < 4) then
    raise exception 'withdrawal bank account details are required' using errcode='22023';
  end if;

  v_amount := p_amount::numeric(20,2);
  select status into v_status from public.profiles where user_id=v_user_id for update;
  if not found then raise exception 'client profile not found' using errcode='P0002'; end if;
  if v_status <> 'active' then raise exception 'client account is not active' using errcode='42501'; end if;

  select * into v_existing from public.money_requests where idempotency_key=trim(p_idempotency_key);
  if found then
    if v_existing.user_id <> v_user_id or v_existing.request_type <> p_request_type
       or v_existing.amount <> v_amount or v_existing.currency <> 'USD'
       or v_existing.payment_method is distinct from p_payment_method
       or v_existing.payment_details <> v_details
       or coalesce(v_existing.client_reference,'') <> coalesce(trim(p_client_reference),'') then
      raise exception 'idempotency key reused with different request data' using errcode='23505';
    end if;
    return v_existing.id;
  end if;

  if p_request_type='withdrawal' then
    select coalesce(sum(amount),0) into v_balance from public.ledger_entries
    where user_id=v_user_id and currency='USD';
    v_balance := v_balance - coalesce((
      select sum(amount) from public.money_requests where user_id=v_user_id
        and request_type='withdrawal' and currency='USD'
        and status in ('submitted','under_review','approved')
    ),0);
    if v_amount > v_balance then raise exception 'withdrawal exceeds available balance' using errcode='22023'; end if;
  end if;

  insert into public.money_requests(user_id,request_type,amount,currency,status,client_reference,payment_method,payment_details,idempotency_key)
  values(v_user_id,p_request_type,v_amount,'USD','submitted',nullif(trim(p_client_reference),''),p_payment_method,v_details,trim(p_idempotency_key))
  returning id into v_request_id;
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_user_id,'money_request.submitted','money_request',v_request_id,'Client submitted a money movement request',
    jsonb_build_object('request_type',p_request_type,'amount',v_amount,'currency','USD','payment_method',p_payment_method));
  return v_request_id;
end;
$$;

create or replace function private.list_money_requests_for_review(p_status text default null)
returns setof public.money_requests
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.admin_roles where user_id=auth.uid()
      and role_name in ('finance_operator','administrator') and revoked_at is null
  ) then raise exception 'finance permission required' using errcode='42501'; end if;
  if p_status is not null and p_status not in ('submitted','under_review','approved','rejected','paid','cancelled') then
    raise exception 'invalid status filter' using errcode='22023';
  end if;
  return query select mr.* from public.money_requests mr
    where p_status is null or mr.status::text=p_status order by mr.submitted_at,mr.id limit 500;
end;
$$;

create or replace function private.review_money_request(
  p_request_id uuid, p_action text, p_reason text, p_external_payment_reference text default null
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_request public.money_requests%rowtype;
  v_profile_status public.account_status;
  v_reason text := trim(coalesce(p_reason,''));
  v_reference text := trim(coalesce(p_external_payment_reference,''));
  v_balance numeric(20,2);
begin
  if v_actor is null or not exists(
    select 1 from public.admin_roles where user_id=v_actor
      and role_name in ('finance_operator','administrator') and revoked_at is null
  ) then raise exception 'finance permission required' using errcode='42501'; end if;
  if p_request_id is null or p_action is null
     or p_action not in ('start_review','approve_withdrawal','reject','confirm_deposit','complete_withdrawal')
     or length(v_reason)<3 or length(v_reason)>500 then
    raise exception 'invalid review action or reason' using errcode='22023';
  end if;

  select * into v_request from public.money_requests where id=p_request_id for update;
  if not found then raise exception 'money request not found' using errcode='P0002'; end if;
  select status into v_profile_status from public.profiles where user_id=v_request.user_id for update;
  if not found then raise exception 'client profile not found' using errcode='P0002'; end if;

  if p_action='start_review' then
    if v_request.status <> 'submitted' then raise exception 'only submitted requests can enter review' using errcode='22023'; end if;
    update public.money_requests set status='under_review',reviewed_at=clock_timestamp(),reviewed_by=v_actor,review_reason=v_reason where id=p_request_id;
  elsif p_action='approve_withdrawal' then
    if v_request.request_type <> 'withdrawal' or v_request.status not in ('submitted','under_review') then
      raise exception 'only pending withdrawals can be approved' using errcode='22023';
    end if;
    update public.money_requests set status='approved',reviewed_at=clock_timestamp(),reviewed_by=v_actor,review_reason=v_reason where id=p_request_id;
  elsif p_action='reject' then
    if v_request.status not in ('submitted','under_review','approved') then raise exception 'request cannot be rejected in its current status' using errcode='22023'; end if;
    update public.money_requests set status='rejected',reviewed_at=clock_timestamp(),reviewed_by=v_actor,review_reason=v_reason where id=p_request_id;
  elsif p_action='confirm_deposit' then
    if v_request.request_type <> 'deposit' or v_request.status not in ('submitted','under_review')
       or length(v_reference)<3 or length(v_reference)>160 then
      raise exception 'deposit must be under review with a verified bank reference' using errcode='22023';
    end if;
    insert into public.ledger_entries(user_id,money_request_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
    values(v_request.user_id,v_request.id,'deposit_credit',v_request.amount,v_request.currency,
      'money-request-deposit:'||v_request.id::text,'Deposit confirmed by finance review',v_actor,
      jsonb_build_object('external_payment_reference',v_reference,'payment_method',v_request.payment_method));
    update public.money_requests set status='paid',external_payment_reference=v_reference,paid_at=clock_timestamp(),
      reviewed_at=clock_timestamp(),reviewed_by=v_actor,review_reason=v_reason where id=p_request_id;
  elsif p_action='complete_withdrawal' then
    if v_request.request_type <> 'withdrawal' or v_request.status <> 'approved'
       or length(v_reference)<3 or length(v_reference)>160 then
      raise exception 'withdrawal must be approved and externally paid before completion' using errcode='22023';
    end if;
    select coalesce(sum(amount),0) into v_balance from public.ledger_entries
      where user_id=v_request.user_id and currency=v_request.currency;
    v_balance := v_balance - coalesce((
      select sum(amount) from public.money_requests where user_id=v_request.user_id
        and request_type='withdrawal' and currency=v_request.currency
        and status in ('submitted','under_review','approved') and id<>v_request.id
    ),0);
    if v_balance < v_request.amount then raise exception 'withdrawal no longer fits available balance' using errcode='22023'; end if;
    insert into public.ledger_entries(user_id,money_request_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
    values(v_request.user_id,v_request.id,'withdrawal_debit',-v_request.amount,v_request.currency,
      'money-request-withdrawal:'||v_request.id::text,'Withdrawal confirmed paid by finance review',v_actor,
      jsonb_build_object('external_payment_reference',v_reference,'payment_method',v_request.payment_method));
    update public.money_requests set status='paid',external_payment_reference=v_reference,paid_at=clock_timestamp(),
      reviewed_at=clock_timestamp(),reviewed_by=v_actor,review_reason=v_reason where id=p_request_id;
  end if;

  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_actor,'money_request.'||p_action,'money_request',p_request_id,v_reason,
    jsonb_build_object('request_type',v_request.request_type,'amount',v_request.amount,'currency',v_request.currency,
      'external_payment_reference',nullif(v_reference,'')));
  return p_request_id;
end;
$$;

revoke all on function private.submit_money_request(text,numeric,text,text,jsonb,text,text) from public,anon;
grant execute on function private.submit_money_request(text,numeric,text,text,jsonb,text,text) to authenticated;
revoke all on function private.list_money_requests_for_review(text) from public,anon;
grant execute on function private.list_money_requests_for_review(text) to authenticated;
revoke all on function private.review_money_request(uuid,text,text,text) from public,anon;
grant execute on function private.review_money_request(uuid,text,text,text) to authenticated;

create or replace function public.submit_money_request(
  p_request_type text,p_amount numeric,p_currency text,p_payment_method text,
  p_payment_details jsonb,p_client_reference text,p_idempotency_key text
) returns uuid language sql security invoker set search_path=pg_catalog,public as $$
  select private.submit_money_request(p_request_type,p_amount,p_currency,p_payment_method,p_payment_details,p_client_reference,p_idempotency_key);
$$;
create or replace function public.list_money_requests_for_review(p_status text default null)
returns setof public.money_requests language sql security invoker set search_path=pg_catalog,public as $$
  select * from private.list_money_requests_for_review(p_status);
$$;
create or replace function public.review_money_request(
  p_request_id uuid,p_action text,p_reason text,p_external_payment_reference text default null
) returns uuid language sql security invoker set search_path=pg_catalog,public as $$
  select private.review_money_request(p_request_id,p_action,p_reason,p_external_payment_reference);
$$;

revoke all on function public.submit_money_request(text,numeric,text,text,jsonb,text,text) from public,anon;
grant execute on function public.submit_money_request(text,numeric,text,text,jsonb,text,text) to authenticated;
revoke all on function public.list_money_requests_for_review(text) from public,anon;
grant execute on function public.list_money_requests_for_review(text) to authenticated;
revoke all on function public.review_money_request(uuid,text,text,text) from public,anon;
grant execute on function public.review_money_request(uuid,text,text,text) to authenticated;
commit;
