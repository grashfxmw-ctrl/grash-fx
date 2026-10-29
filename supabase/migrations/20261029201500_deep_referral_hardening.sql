-- Deep referral hardening: reject invalid supplied codes and remove duplicate auth trigger.
-- The signup metadata is user-controlled, so a non-empty code must resolve to an existing
-- referrer and must never be accepted as a self-referral.

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

  resolved_phone := nullif(regexp_replace(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '\\s+', '', 'g'), '');
  if resolved_phone is not null and resolved_phone !~ '^\\+[1-9][0-9]{7,14}$' then
    raise exception 'Enter a valid phone number in international format, for example +265XXXXXXXXX';
  end if;
  if resolved_phone is not null and exists (
    select 1 from public.profiles p
    where lower(regexp_replace(trim(p.phone), '\\s+', '', 'g')) = lower(resolved_phone)
  ) then
    raise exception 'This phone number is already linked to an account. Contact support if you need account recovery.';
  end if;

  resolved_referral_code := upper(trim(coalesce(new.raw_user_meta_data ->> 'referral_code','')));
  if resolved_referral_code <> '' then
    select user_id into referrer_id
    from public.profiles
    where upper(referral_code) = resolved_referral_code
    limit 1;
    if referrer_id is null then
      raise exception 'That referral code is invalid. Check the code or remove it and try again.';
    end if;
    if referrer_id = new.id then
      raise exception 'You cannot use your own referral code.';
    end if;
  end if;

  loop
    new_referral_code := 'GRASH' || lpad(floor(random()*10000)::integer::text,4,'0');
    exit when not exists (select 1 from public.profiles where upper(referral_code)=new_referral_code);
  end loop;

  insert into public.profiles(user_id,full_name,email,phone,status,referral_code)
  values(new.id,left(resolved_name,160),new.email,resolved_phone,'pending',new_referral_code)
  on conflict(user_id) do nothing;

  if resolved_referral_code <> '' then
    insert into public.referrals(referrer_user_id,referred_user_id,referral_code,status)
    values(referrer_id,new.id,resolved_referral_code,'pending')
    on conflict(referred_user_id) do nothing;
  end if;

  return new;
end;
$function$;

-- Both previously installed triggers called the same handler. Keep one to avoid
-- duplicate trigger execution; the handler remains safe if an older deployment
-- recreates a profile before the remaining trigger executes.
drop trigger if exists on_auth_user_created_grash_fx on auth.users;

revoke all on function public.process_my_referral_reward() from public, anon;
grant execute on function public.process_my_referral_reward() to authenticated;
