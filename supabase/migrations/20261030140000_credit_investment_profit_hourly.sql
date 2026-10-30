create or replace function private.process_due_investments()
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  v_investment public.investments%rowtype;
  v_elapsed_hours integer;
  v_hour integer;
  v_hour_in_day integer;
  v_day integer;
  v_processed integer := 0;
  v_daily_profit numeric(20,2);
  v_hourly_credit numeric(20,2);
  v_previous_target numeric(20,2);
  v_current_target numeric(20,2);
  v_legacy_day_exists boolean;
begin
  for v_investment in
    select *
    from public.investments
    where status = 'active'
      and started_at is not null
      and matures_at is not null
      and started_at + interval '1 hour' <= clock_timestamp()
    order by matures_at, id
    for update skip locked
  loop
    if v_investment.rate_basis_snapshot <> 'simple_daily' then
      raise exception 'Unsupported investment rate basis: %', v_investment.rate_basis_snapshot;
    end if;

    v_elapsed_hours := greatest(0, least(
      v_investment.term_days_snapshot * 24,
      floor(extract(epoch from (clock_timestamp() - v_investment.started_at)) / 3600)::integer
    ));
    v_daily_profit := round(v_investment.principal_amount * v_investment.daily_rate_snapshot, 2);

    for v_hour in 1..v_elapsed_hours loop
      v_day := ((v_hour - 1) / 24) + 1;
      select exists (
        select 1 from public.ledger_entries
        where idempotency_key = 'investment-profit:' || v_investment.id::text || ':day:' || v_day::text
      ) into v_legacy_day_exists;

      if not v_legacy_day_exists then
        v_hour_in_day := ((v_hour - 1) % 24) + 1;
        v_previous_target := round(v_daily_profit * (v_hour_in_day - 1)::numeric / 24, 2);
        v_current_target := round(v_daily_profit * v_hour_in_day::numeric / 24, 2);
        v_hourly_credit := v_current_target - v_previous_target;

        if v_hourly_credit > 0 then
          insert into public.ledger_entries (
            user_id, investment_id, entry_type, amount, currency,
            idempotency_key, description, created_by, metadata
          ) values (
            v_investment.user_id, v_investment.id, 'profit_credit', v_hourly_credit,
            v_investment.currency,
            'investment-profit:' || v_investment.id::text || ':hour:' || v_hour::text,
            'Hourly investment profit credit (hour ' || v_hour::text || ')',
            null,
            jsonb_build_object(
              'hour', v_hour, 'day', v_day, 'hour_in_day', v_hour_in_day,
              'daily_rate', v_investment.daily_rate_snapshot,
              'daily_profit', v_daily_profit, 'principal', v_investment.principal_amount,
              'rate_basis', v_investment.rate_basis_snapshot
            )
          ) on conflict (idempotency_key) do nothing;
        end if;
      end if;
    end loop;

    if v_elapsed_hours >= v_investment.term_days_snapshot * 24 then
      insert into public.ledger_entries (
        user_id, investment_id, entry_type, amount, currency,
        idempotency_key, description, created_by, metadata
      ) values (
        v_investment.user_id, v_investment.id, 'principal_return_credit',
        v_investment.principal_amount, v_investment.currency,
        'investment-principal-return:' || v_investment.id::text,
        'Investment principal returned at maturity', null,
        jsonb_build_object('term_days', v_investment.term_days_snapshot, 'matured_at', clock_timestamp())
      ) on conflict (idempotency_key) do nothing;

      update public.investments
        set status = 'matured', matured_at = coalesce(matured_at, clock_timestamp())
      where id = v_investment.id and status = 'active';
    end if;
    v_processed := v_processed + 1;
  end loop;
  return v_processed;
end;
$function$;
