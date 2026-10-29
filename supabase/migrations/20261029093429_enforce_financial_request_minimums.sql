create or replace function public.request_deposit(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_description text default null
)
returns public.financial_transactions
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_tx public.financial_transactions;
begin
  if p_amount is null or p_amount < 20 or p_amount > 10000000 then
    raise exception 'Deposit must be between $20.00 and $10,000,000.00';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 or length(p_idempotency_key) > 128 then
    raise exception 'A valid idempotency key is required';
  end if;
  insert into public.financial_transactions(user_id, kind, amount, status, idempotency_key, description)
  values (p_user_id, 'deposit', round(p_amount,2), 'pending', p_idempotency_key, left(p_description,250))
  on conflict (idempotency_key) do nothing
  returning * into v_tx;
  if v_tx.id is null then
    select * into v_tx from public.financial_transactions where idempotency_key=p_idempotency_key;
    if v_tx.user_id <> p_user_id or v_tx.kind <> 'deposit' or v_tx.amount <> round(p_amount,2) then
      raise exception 'Idempotency key already used for a different request';
    end if;
  end if;
  return v_tx;
end;
$function$;

create or replace function public.request_withdrawal(
  p_user_id uuid,
  p_amount numeric,
  p_idempotency_key text,
  p_description text default null
)
returns public.financial_transactions
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_profile public.profiles; v_tx public.financial_transactions;
begin
  if p_amount is null or p_amount < 50 or p_amount > 10000000 then
    raise exception 'Withdrawal must be between $50.00 and $10,000,000.00';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 or length(p_idempotency_key) > 128 then
    raise exception 'A valid idempotency key is required';
  end if;
  select * into v_tx from public.financial_transactions where idempotency_key=p_idempotency_key;
  if found then
    if v_tx.user_id <> p_user_id or v_tx.kind <> 'withdrawal' or v_tx.amount <> round(p_amount,2) then
      raise exception 'Idempotency key already used for a different request';
    end if;
    return v_tx;
  end if;
  select * into v_profile from public.profiles where id=p_user_id for update;
  if not found then raise exception 'Account profile not found'; end if;
  if v_profile.status <> 'active' then raise exception 'Account is not approved for withdrawals'; end if;
  if v_profile.balance < round(p_amount,2) then raise exception 'Insufficient available balance'; end if;
  update public.profiles set balance=balance-round(p_amount,2), updated_at=now() where id=p_user_id;
  insert into public.financial_transactions(user_id,kind,amount,status,idempotency_key,description)
  values(p_user_id,'withdrawal',round(p_amount,2),'processing',p_idempotency_key,left(p_description,250))
  returning * into v_tx;
  return v_tx;
end;
$function$;
