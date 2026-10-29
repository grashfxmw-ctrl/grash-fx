-- Reject idempotency-key reuse when the requested balance adjustment differs.
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
  v_existing public.ledger_entries%rowtype;
  v_expected_type public.ledger_entry_type;
  v_expected_amount numeric(20,2);
begin
  if v_actor is null or not exists (
    select 1 from public.admin_roles
    where user_id = v_actor and role_name in ('administrator','finance_operator') and revoked_at is null
  ) then raise exception 'admin permission required' using errcode = '42501'; end if;
  if p_target_user_id is null or p_direction not in ('credit','debit')
     or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2) or p_amount > 10000000
     or length(trim(coalesce(p_reason,''))) < 5 or length(trim(coalesce(p_reason,''))) > 500
     or length(trim(coalesce(p_idempotency_key,''))) < 8 or length(trim(coalesce(p_idempotency_key,''))) > 128 then
    raise exception 'valid customer, direction, amount, reason and idempotency key are required' using errcode = '22023';
  end if;
  v_amount := round(p_amount,2);
  v_expected_type := case when p_direction='credit' then 'adjustment_credit'::public.ledger_entry_type else 'adjustment_debit'::public.ledger_entry_type end;
  v_expected_amount := case when p_direction='credit' then v_amount else -v_amount end;

  select * into v_existing from public.ledger_entries where idempotency_key='admin-adjust:'||trim(p_idempotency_key);
  if found then
    if v_existing.user_id=p_target_user_id and v_existing.entry_type=v_expected_type
       and v_existing.amount=v_expected_amount and v_existing.metadata->>'reason'=trim(p_reason) then
      return v_existing.id;
    end if;
    raise exception 'idempotency key already used with different adjustment data' using errcode = '23505';
  end if;

  perform 1 from public.profiles where user_id=p_target_user_id for update;
  if not found then raise exception 'customer profile not found' using errcode = 'P0002'; end if;
  select coalesce(sum(amount),0) into v_balance from public.ledger_entries where user_id=p_target_user_id and currency='USD';
  select coalesce(sum(amount),0) into v_reserved from public.money_requests where user_id=p_target_user_id
    and request_type='withdrawal' and currency='USD' and status in ('submitted','under_review','approved');
  if p_direction='debit' and v_balance-v_reserved < v_amount then
    raise exception 'debit exceeds available balance after pending withdrawal reservations' using errcode = '22023';
  end if;
  insert into public.ledger_entries(user_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
  values(p_target_user_id,v_expected_type,v_expected_amount,'USD','admin-adjust:'||trim(p_idempotency_key),
    'Administrator balance '||p_direction||': '||left(trim(p_reason),400),v_actor,
    jsonb_build_object('direction',p_direction,'reason',trim(p_reason),'available_before',v_balance-v_reserved))
  returning id into v_entry_id;
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_actor,'balance.adjusted','profile',p_target_user_id,trim(p_reason),
    jsonb_build_object('ledger_entry_id',v_entry_id,'direction',p_direction,'amount',v_amount,'currency','USD','idempotency_key',trim(p_idempotency_key)));
  return v_entry_id;
end;
$function$;
