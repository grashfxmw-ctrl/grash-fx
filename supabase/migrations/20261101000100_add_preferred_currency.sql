alter table public.profiles
  add column if not exists preferred_currency text not null default 'USD';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_preferred_currency_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_preferred_currency_check
      check (preferred_currency in ('USD','MWK','TZS','ZAR','ZWG','BWP','MZN'));
  end if;
end $$;

comment on column public.profiles.preferred_currency is
  'Client-facing display currency only; all account ledger values remain USD.';

create or replace function public.set_profile_preferred_currency_from_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  requested_currency text;
begin
  requested_currency := upper(coalesce(new.raw_user_meta_data ->> 'preferred_currency', 'USD'));
  if requested_currency not in ('USD','MWK','TZS','ZAR','ZWG','BWP','MZN') then
    requested_currency := 'USD';
  end if;
  update public.profiles
     set preferred_currency = requested_currency,
         updated_at = clock_timestamp()
   where user_id = new.id;
  return new;
end;
$$;

revoke all on function public.set_profile_preferred_currency_from_signup() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_set_preferred_currency on auth.users;
create trigger on_auth_user_created_set_preferred_currency
after insert on auth.users
for each row execute function public.set_profile_preferred_currency_from_signup();
