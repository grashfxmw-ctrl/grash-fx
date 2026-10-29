-- GRASH FX: separate deposit and withdrawal payment methods.
-- Methods are recorded for manual review only; no gateway or automatic payout is connected.
begin;

alter table public.money_requests
  drop constraint if exists money_requests_payment_method_check;
alter table public.money_requests
  add constraint money_requests_payment_method_check
  check (payment_method in (
    'usdt_ethereum','usdc_ethereum','bitcoin','airtel_money','cash_send',
    'bank_transfer','eft','mobile_money'
  ));

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
     or p_payment_method is null
     or p_idempotency_key is null or length(trim(p_idempotency_key)) < 8
     or length(trim(p_idempotency_key)) > 128 or jsonb_typeof(v_details) <> 'object'
     or length(v_details::text) > 2000 then
    raise exception 'invalid money request' using errcode='22023';
  end if;

  -- Deposits use incoming methods only. Bank transfer/EFT are withdrawal-only.
  if p_request_type='deposit' and p_payment_method not in
     ('usdt_ethereum','usdc_ethereum','bitcoin','airtel_money','cash_send') then
    raise exception 'this payment method is not available for deposits' using errcode='22023';
  end if;
  if p_request_type='withdrawal' and p_payment_method not in
     ('bank_transfer','eft','mobile_money','usdt_ethereum','usdc_ethereum','bitcoin') then
    raise exception 'this payment method is not available for withdrawals' using errcode='22023';
  end if;

  if p_request_type='deposit' and (p_client_reference is null
     or length(trim(p_client_reference)) < 3 or length(trim(p_client_reference)) > 120) then
    raise exception 'deposit transaction/reference is required' using errcode='22023';
  end if;

  if p_request_type='withdrawal' then
    if v_details='{}'::jsonb then
      raise exception 'withdrawal payout details are required' using errcode='22023';
    end if;
    if p_payment_method in ('bank_transfer','eft') and (
       not (v_details ? 'account_holder') or not (v_details ? 'account_number')
       or length(trim(coalesce(v_details->>'account_holder',''))) < 2
       or length(trim(coalesce(v_details->>'account_number',''))) < 4) then
      raise exception 'bank account holder and account number are required' using errcode='22023';
    end if;
    if p_payment_method='mobile_money' and (
       not (v_details ? 'account_holder') or not (v_details ? 'phone_number')
       or not (v_details ? 'provider') or not (v_details ? 'country')
       or length(trim(coalesce(v_details->>'account_holder',''))) < 2
       or length(trim(coalesce(v_details->>'phone_number',''))) < 6
       or length(trim(coalesce(v_details->>'provider',''))) < 2
       or length(trim(coalesce(v_details->>'country',''))) <> 2) then
      raise exception 'mobile-money name, phone, provider and country code are required' using errcode='22023';
    end if;
    if p_payment_method in ('usdt_ethereum','usdc_ethereum','bitcoin') and (
       not (v_details ? 'wallet_address') or not (v_details ? 'network')
       or length(trim(coalesce(v_details->>'wallet_address',''))) < 12
       or length(trim(coalesce(v_details->>'network',''))) < 3) then
      raise exception 'crypto wallet address and network are required' using errcode='22023';
    end if;
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

revoke all on function private.submit_money_request(text,numeric,text,text,jsonb,text,text) from public,anon;
grant execute on function private.submit_money_request(text,numeric,text,text,jsonb,text,text) to authenticated;

commit;
