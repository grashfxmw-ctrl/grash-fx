-- Activate client profiles automatically after Supabase confirms their email.
-- Preserve any non-pending status (for example suspended or blocked accounts).

create or replace function public.activate_profile_after_email_confirmation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    update public.profiles
       set status = 'active',
           updated_at = clock_timestamp()
     where user_id = new.id
       and status = 'pending';
  end if;

  return new;
end;
$$;

revoke all on function public.activate_profile_after_email_confirmation() from public;
revoke all on function public.activate_profile_after_email_confirmation() from anon, authenticated;

drop trigger if exists on_auth_user_email_confirmed_activate_profile on auth.users;
create trigger on_auth_user_email_confirmed_activate_profile
after update of email_confirmed_at on auth.users
for each row
when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
execute function public.activate_profile_after_email_confirmation();

-- Also activate already-verified clients who were left pending before this fix.
update public.profiles p
   set status = 'active',
       updated_at = clock_timestamp()
  from auth.users u
 where u.id = p.user_id
   and u.email_confirmed_at is not null
   and p.status = 'pending';
