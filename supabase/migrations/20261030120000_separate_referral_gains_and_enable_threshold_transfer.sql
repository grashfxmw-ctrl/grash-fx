-- Keep referral rewards in a separate wallet until the client transfers them.
-- A balancing debit neutralises each referral credit in the main ledger balance.
create or replace function public.hold_referral_reward_in_referral_wallet()
returns trigger
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
begin
  if new.entry_type = 'referral_bonus_credit' and new.currency = 'USD' and new.amount > 0 then
    insert into public.ledger_entries (
      user_id, entry_type, amount, currency, idempotency_key, description, created_by, metadata
    ) values (
      new.user_id, 'adjustment_debit', -new.amount, new.currency,
      'referral-hold:' || new.id::text,
      'Referral reward held in referral gains wallet',
      new.created_by,
      jsonb_build_object('source_entry_id', new.id, 'wallet', 'referral')
    )
    on conflict (idempotency_key) do nothing;
  end if;
  return new;
end;
$function$;

revoke all on function public.hold_referral_reward_in_referral_wallet() from public, anon, authenticated;
drop trigger if exists hold_referral_reward_in_referral_wallet on public.ledger_entries;
create trigger hold_referral_reward_in_referral_wallet
after insert on public.ledger_entries
for each row execute function public.hold_referral_reward_in_referral_wallet();

-- Backfill the holding entries for rewards that existed before this migration.
insert into public.ledger_entries (
  user_id, entry_type, amount, currency, idempotency_key, description, created_by, metadata
)
select
  r.user_id, 'adjustment_debit', -r.amount, r.currency,
  'referral-hold:' || r.id::text,
  'Referral reward held in referral gains wallet',
  r.created_by,
  jsonb_build_object('source_entry_id', r.id, 'wallet', 'referral')
from public.ledger_entries r
where r.entry_type = 'referral_bonus_credit'
  and r.currency = 'USD'
  and r.amount > 0
on conflict (idempotency_key) do nothing;

create table if not exists public.referral_transfers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(20,2) not null check (amount >= 60 and amount = round(amount, 2)),
  ledger_entry_id uuid not null unique references public.ledger_entries(id),
  idempotency_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, idempotency_key)
);
create index if not exists referral_transfers_user_created_idx
  on public.referral_transfers(user_id, created_at desc);
alter table public.referral_transfers enable row level security;
revoke all on public.referral_transfers from anon, authenticated;

create or replace function public.transfer_referral_gains(p_idempotency_key text)
returns numeric
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_existing public.referral_transfers%rowtype;
  v_available numeric(20,2);
  v_entry_id uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 or length(trim(p_idempotency_key)) > 128 then
    raise exception 'a valid idempotency key is required' using errcode = '22023';
  end if;

  perform 1 from public.profiles where user_id = v_user for update;
  if not found then raise exception 'client profile not found' using errcode = 'P0002'; end if;

  select * into v_existing
  from public.referral_transfers
  where user_id = v_user and idempotency_key = trim(p_idempotency_key);
  if found then return v_existing.amount; end if;

  select round(
    coalesce((select sum(amount) from public.ledger_entries
      where user_id = v_user and currency = 'USD' and entry_type = 'referral_bonus_credit'), 0)
    - coalesce((select sum(amount) from public.referral_transfers where user_id = v_user), 0),
    2
  ) into v_available;

  if v_available < 60 then
    raise exception 'You need at least $60.00 in referral gains before transferring to your main account.' using errcode = '22023';
  end if;

  insert into public.ledger_entries (
    user_id, entry_type, amount, currency, idempotency_key, description, created_by, metadata
  ) values (
    v_user, 'adjustment_credit', v_available, 'USD',
    'referral-transfer:' || trim(p_idempotency_key),
    'Referral gains transferred to main account',
    v_user,
    jsonb_build_object('wallet', 'referral', 'transfer_amount', v_available)
  ) returning id into v_entry_id;

  insert into public.referral_transfers(user_id, amount, ledger_entry_id, idempotency_key)
  values (v_user, v_available, v_entry_id, trim(p_idempotency_key));

  insert into public.audit_events(actor_user_id, action, entity_type, entity_id, reason, details)
  values (v_user, 'referral.gains_transferred', 'profile', v_user,
    'Client transferred eligible referral gains to the main account',
    jsonb_build_object('amount', v_available, 'currency', 'USD', 'ledger_entry_id', v_entry_id));

  return v_available;
end;
$function$;

revoke all on function public.transfer_referral_gains(text) from public, anon;
grant execute on function public.transfer_referral_gains(text) to authenticated;
