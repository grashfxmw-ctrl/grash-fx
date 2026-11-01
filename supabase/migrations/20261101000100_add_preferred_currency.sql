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
