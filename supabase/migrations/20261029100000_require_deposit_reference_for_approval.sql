create or replace function public.admin_review_financial_transaction(
  p_transaction_id uuid,
  p_admin_user_id uuid,
  p_decision text,
  p_reference text default null,
  p_reason text default null
)
returns public.financial_transactions
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  tx public.financial_transactions;
  admin_profile public.profiles;
begin
  if p_decision is null or p_decision not in ('approve','reject') then
    raise exception 'Decision must be approve or reject';
  end if;
  select * into admin_profile from public.profiles where id=p_admin_user_id for update;
  if not found or admin_profile.role <> 'admin'
     or lower(admin_profile.email) <> 'grashfxmw@gmail.com'
     or admin_profile.status <> 'active' then
    raise exception 'Admin access required';
  end if;
  select * into tx from public.financial_transactions where id=p_transaction_id for update;
  if not found then raise exception 'Transaction not found'; end if;
  if tx.kind not in ('deposit','withdrawal') then raise exception 'Only deposit and withdrawal requests can be reviewed'; end if;
  if tx.status not in ('pending','processing') then raise exception 'Transaction has already been reviewed'; end if;
  if tx.kind='deposit' and tx.status <> 'pending' then raise exception 'Deposit is not pending'; end if;
  if tx.kind='withdrawal' and tx.status <> 'processing' then raise exception 'Withdrawal is not awaiting review'; end if;

  if p_decision='approve' then
    if tx.kind='deposit' and nullif(trim(coalesce(p_reference,'')),'') is null then
      raise exception 'A verified external payment reference is required to approve a deposit';
    end if;
    if tx.kind='deposit' then
      update public.profiles set balance=balance+tx.amount, updated_at=now() where id=tx.user_id;
    end if;
    update public.financial_transactions
      set status='completed', reference=coalesce(nullif(left(p_reference,250),''),reference),
          reviewed_by=p_admin_user_id, reviewed_at=now(),
          metadata=metadata||jsonb_build_object('review_reason',left(coalesce(p_reason,''),250))
      where id=p_transaction_id returning * into tx;
  else
    if tx.kind='withdrawal' then
      update public.profiles set balance=balance+tx.amount, updated_at=now() where id=tx.user_id;
    end if;
    update public.financial_transactions
      set status='rejected', reviewed_by=p_admin_user_id, reviewed_at=now(),
          metadata=metadata||jsonb_build_object('review_reason',left(coalesce(p_reason,''),250))
      where id=p_transaction_id returning * into tx;
  end if;

  insert into public.audit_events(actor_user_id,subject_user_id,action,outcome,reason,reference,metadata)
  values(p_admin_user_id,tx.user_id,'financial_transaction_reviewed',p_decision,
    nullif(left(coalesce(p_reason,''),500),''),tx.reference,
    jsonb_build_object('transaction_id',tx.id,'kind',tx.kind,'amount',tx.amount));
  return tx;
end;
$function$;
