-- Automatically credit the referrer when the referred investor verifies email.
-- The internal worker is idempotent and is shared by the auth trigger and the
-- existing authenticated retry endpoint.

create or replace function public.process_referral_reward_for_user(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare
  v_referral public.referrals%rowtype;
begin
  if p_user is null then
    return false;
  end if;

  select *
    into v_referral
    from public.referrals
   where referred_user_id = p_user
     and status = 'pending'
   for update;

  if not found then
    return false;
  end if;

  perform 1
    from public.profiles
   where user_id = v_referral.referrer_user_id
   for update;

  if not found then
    update public.referrals
       set status = 'rejected'
     where id = v_referral.id
       and status = 'pending';
    return false;
  end if;

  insert into public.ledger_entries(
    user_id, entry_type, amount, currency, idempotency_key,
    description, created_by, metadata
  )
  values(
    v_referral.referrer_user_id,
    'referral_bonus_credit',
    5,
    'USD',
    'referral-reward:' || v_referral.id::text,
    'Referral reward for a verified registration',
    p_user,
    jsonb_build_object(
      'referral_id', v_referral.id,
      'referred_user_id', p_user,
      'referral_code', v_referral.referral_code
    )
  )
  on conflict (idempotency_key) do nothing;

  update public.referrals
     set status = 'rewarded',
         rewarded_at = coalesce(rewarded_at, clock_timestamp())
   where id = v_referral.id
     and status = 'pending';

  insert into public.audit_events(
    actor_user_id, action, entity_type, entity_id, reason, details
  )
  values(
    p_user,
    'referral.rewarded',
    'referral',
    v_referral.id,
    'Reward credited automatically after referred user verified email',
    jsonb_build_object(
      'referrer_user_id', v_referral.referrer_user_id,
      'amount', 5,
      'currency', 'USD'
    )
  );

  return true;
end;
$function$;

revoke all on function public.process_referral_reward_for_user(uuid)
  from public, anon, authenticated;

create or replace function public.handle_referral_email_verification()
returns trigger
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
begin
  if old.email_confirmed_at is null
     and new.email_confirmed_at is not null then
    begin
      perform public.process_referral_reward_for_user(new.id);
    exception when others then
      -- Never prevent a legitimate email verification because a reward
      -- credit failed; the existing authenticated retry remains available.
      raise warning 'Automatic referral reward failed for user %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$function$;

revoke all on function public.handle_referral_email_verification()
  from public, anon, authenticated;

drop trigger if exists on_auth_user_email_verified_referral_reward on auth.users;
create trigger on_auth_user_email_verified_referral_reward
after update of email_confirmed_at on auth.users
for each row
when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
execute function public.handle_referral_email_verification();

-- Recover referrals that were already verified before this automatic trigger
-- was installed. The same locks and idempotency key prevent double credits.
do $backfill$
declare
  v_user uuid;
begin
  for v_user in
    select r.referred_user_id
      from public.referrals r
      join auth.users u on u.id = r.referred_user_id
     where r.status = 'pending'
       and u.email_confirmed_at is not null
  loop
    begin
      perform public.process_referral_reward_for_user(v_user);
    exception when others then
      raise warning 'Referral reward backfill failed for user %: %', v_user, sqlerrm;
    end;
  end loop;
end;
$backfill$;
