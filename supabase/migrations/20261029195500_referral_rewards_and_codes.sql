-- Referral codes and idempotent $5 simulated referral reward after email verification.
alter table public.profiles add column if not exists referral_code text;
create unique index if not exists profiles_referral_code_unique
  on public.profiles (upper(referral_code)) where referral_code is not null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare
  resolved_name text;
  resolved_phone text;
  resolved_referral_code text;
  new_referral_code text;
  referrer_id uuid;
begin
  if exists (select 1 from public.profiles where user_id = new.id) then return new; end if;
  resolved_name := nullif(btrim(new.raw_user_meta_data ->> 'full_name'), '');
  if resolved_name is null then resolved_name := nullif(split_part(coalesce(new.email, ''), '@', 1), ''); end if;
  if resolved_name is null then resolved_name := 'New Client'; end if;
  resolved_phone := nullif(regexp_replace(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '\s+', '', 'g'), '');
  if resolved_phone is not null and resolved_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter a valid phone number in international format, for example +265XXXXXXXXX';
  end if;
  if resolved_phone is not null and exists (
    select 1 from public.profiles p
    where lower(regexp_replace(trim(p.phone), '\s+', '', 'g')) = lower(resolved_phone)
  ) then
    raise exception 'This phone number is already linked to an account. Contact support if you need account recovery.';
  end if;
  loop
    new_referral_code := 'GRASH' || lpad(floor(random()*10000)::integer::text,4,'0');
    exit when not exists (select 1 from public.profiles where upper(referral_code)=new_referral_code);
  end loop;
  insert into public.profiles(user_id,full_name,email,phone,status,referral_code)
  values(new.id,left(resolved_name,160),new.email,resolved_phone,'pending',new_referral_code)
  on conflict(user_id) do nothing;
  resolved_referral_code := upper(trim(coalesce(new.raw_user_meta_data ->> 'referral_code','')));
  if resolved_referral_code <> '' then
    select user_id into referrer_id from public.profiles where upper(referral_code)=resolved_referral_code limit 1;
    if referrer_id is not null and referrer_id <> new.id then
      insert into public.referrals(referrer_user_id,referred_user_id,referral_code,status)
      values(referrer_id,new.id,resolved_referral_code,'pending')
      on conflict(referred_user_id) do nothing;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.process_my_referral_reward()
returns boolean
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare
  v_user uuid := auth.uid();
  v_referral public.referrals%rowtype;
  v_confirmed boolean;
begin
  if v_user is null then raise exception 'authentication required' using errcode='28000'; end if;
  select (email_confirmed_at is not null) into v_confirmed from auth.users where id=v_user;
  if coalesce(v_confirmed,false)=false then raise exception 'email verification required' using errcode='42501'; end if;
  select * into v_referral from public.referrals where referred_user_id=v_user and status='pending' for update;
  if not found then return false; end if;
  perform 1 from public.profiles where user_id=v_referral.referrer_user_id for update;
  if not found then
    update public.referrals set status='rejected' where id=v_referral.id;
    return false;
  end if;
  insert into public.ledger_entries(user_id,entry_type,amount,currency,idempotency_key,description,created_by,metadata)
  values(v_referral.referrer_user_id,'referral_bonus_credit',5,'USD','referral-reward:'||v_referral.id::text,
    'Referral reward for a verified registration',v_user,
    jsonb_build_object('referral_id',v_referral.id,'referred_user_id',v_user,'referral_code',v_referral.referral_code))
  on conflict(idempotency_key) do nothing;
  update public.referrals set status='rewarded',rewarded_at=clock_timestamp() where id=v_referral.id and status='pending';
  insert into public.audit_events(actor_user_id,action,entity_type,entity_id,reason,details)
  values(v_user,'referral.rewarded','referral',v_referral.id,'Reward credited after referred user verified email',
    jsonb_build_object('referrer_user_id',v_referral.referrer_user_id,'amount',5,'currency','USD'));
  return true;
end;
$function$;
revoke all on function public.process_my_referral_reward() from public, anon;
grant execute on function public.process_my_referral_reward() to authenticated;
