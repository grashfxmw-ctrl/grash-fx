CREATE OR REPLACE FUNCTION private.submit_money_request(p_request_type text, p_amount numeric, p_currency text, p_payment_method text, p_payment_details jsonb, p_client_reference text, p_idempotency_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_status public.account_status;
  v_amount numeric(20,2);
  v_request_id uuid;
  v_existing public.money_requests%rowtype;
  v_balance numeric(20,2);
  v_details jsonb := coalesce(p_payment_details, '{}'::jsonb);
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_request_type not in ('deposit', 'withdrawal')
     or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2)
     or upper(coalesce(p_currency, '')) <> 'USD'
     or p_payment_method not in ('bank_transfer', 'eft')
     or p_idempotency_key is null
     or length(trim(p_idempotency_key)) < 8
     or length(trim(p_idempotency_key)) > 128
     or jsonb_typeof(v_details) <> 'object'
     or length(v_details::text) > 2000 then
    raise exception 'invalid money request' using errcode = '22023';
  end if;

  if (p_request_type = 'deposit' and p_amount < 20)
     or (p_request_type = 'withdrawal' and p_amount < 50) then
    raise exception '% minimum is % USD',
      case when p_request_type = 'deposit' then 'deposit' else 'withdrawal' end,
      case when p_request_type = 'deposit' then 20 else 50 end
      using errcode = '22023';
  end if;

  if (p_request_type = 'deposit' and p_amount < 20)
     or (p_request_type = 'withdrawal' and p_amount < 50) then
    raise exception '% minimum is % USD',
      case when p_request_type = 'deposit' then 'deposit' else 'withdrawal' end,
      case when p_request_type = 'deposit' then 20 else 50 end
      using errcode = '22023';
  end if;

  if p_request_type = 'deposit'
     and (p_client_reference is null or length(trim(p_client_reference)) < 3
          or length(trim(p_client_reference)) > 120) then
    raise exception 'deposit transfer reference is required' using errcode = '22023';
  end if;

  if p_request_type = 'withdrawal'
     and (v_details = '{}'::jsonb
          or not (v_details ? 'account_holder')
          or not (v_details ? 'account_number')
          or length(trim(coalesce(v_details->>'account_holder',''))) < 2
          or length(trim(coalesce(v_details->>'account_number',''))) < 4) then
    raise exception 'withdrawal bank account details are required' using errcode = '22023';
  end if;

  v_amount := p_amount::numeric(20,2);

  select status into v_status
  from public.profiles
  where user_id = v_user_id
  for update;

  if not found then
    raise exception 'client profile not found' using errcode = 'P0002';
  end if;
  if v_status <> 'active' then
    raise exception 'client account is not active' using errcode = '42501';
  end if;

  select * into v_existing
  from public.money_requests
  where idempotency_key = trim(p_idempotency_key);

  if found then
    if v_existing.user_id <> v_user_id
       or v_existing.request_type <> p_request_type
       or v_existing.amount <> v_amount
       or v_existing.currency <> 'USD'
       or v_existing.payment_method <> p_payment_method
       or v_existing.payment_details <> v_details
       or coalesce(v_existing.client_reference,'') <> coalesce(trim(p_client_reference),'') then
      raise exception 'idempotency key reused with different request data' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  if p_request_type = 'withdrawal' then
    select coalesce(sum(amount), 0) into v_balance
    from public.ledger_entries
    where user_id = v_user_id and currency = 'USD';

    v_balance := v_balance - coalesce((
      select sum(amount)
      from public.money_requests
      where user_id = v_user_id
        and request_type = 'withdrawal'
        and currency = 'USD'
        and status in ('submitted', 'under_review', 'approved')
    ), 0);

    if v_amount > v_balance then
      raise exception 'withdrawal exceeds available balance' using errcode = '22023';
    end if;
  end if;

  insert into public.money_requests (
    user_id, request_type, amount, currency, status,
    client_reference, payment_method, payment_details, idempotency_key
  ) values (
    v_user_id, p_request_type, v_amount, 'USD', 'submitted',
    nullif(trim(p_client_reference), ''), p_payment_method, v_details, trim(p_idempotency_key)
  )
  returning id into v_request_id;

  insert into public.audit_events (
    actor_user_id, action, entity_type, entity_id, reason, details
  ) values (
    v_user_id, 'money_request.submitted', 'money_request', v_request_id,
    'Client submitted a money movement request',
    jsonb_build_object('request_type', p_request_type, 'amount', v_amount, 'currency', 'USD', 'payment_method', p_payment_method)
  );

  return v_request_id;
end;
$function$
