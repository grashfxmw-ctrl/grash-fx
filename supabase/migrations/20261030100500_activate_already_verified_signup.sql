-- Handle projects where email confirmation is disabled and Auth creates
-- the user with email_confirmed_at already populated.
create or replace function public.activate_profile_for_preconfirmed_signup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.email_confirmed_at is not null then
    update public.profiles
       set status = 'active',
           updated_at = clock_timestamp()
     where user_id = new.id
       and status = 'pending';
  end if;
  return new;
end;
$$;

revoke all on function public.activate_profile_for_preconfirmed_signup() from public;
revoke all on function public.activate_profile_for_preconfirmed_signup() from anon, authenticated;

drop trigger if exists on_auth_user_preconfirmed_signup_activate_profile on auth.users;
create trigger on_auth_user_preconfirmed_signup_activate_profile
after insert on auth.users
for each row
when (new.email_confirmed_at is not null)
execute function public.activate_profile_for_preconfirmed_signup();
