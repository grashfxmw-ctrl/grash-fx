create or replace function private.process_due_investments()
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  v_investment public.investments%rowtype;
  v_now timestamptz;
  v_elapsed_hours integer;
  v_hour integer;
  v_processed integer := 0;
  v_hourly_credit numeric(20,2);
  v_cumulative_profit numeric(20,2);
  v_previous_profit numeric(20,2);
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
    v_now := clock_timestamp();

    if v_investment.rate_basis_snapshot <> 'simple_daily' then
      raise exception 'Unsupported investment rate basis: %', v_investment.rate_basis_snapshot;
    end if;

    v_elapsed_hours := greatest(0, least(
      v_investment.term_days_snapshot * 24,
      floor(extract(epoch from (v_now - v_investment.started_at)) / 3600)::integer
    ));

    for v_hour in 1..v_elapsed_hours loop
      v_cumulative_profit := round(
        v_investment.principal_amount * v_investment.daily_rate_snapshot * v_hour / 24,
        2
      );
      v_previous_profit := round(
        v_investment.principal_amount * v_investment.daily_rate_snapshot * (v_hour - 1) / 24,
        2
      );
      v_hourly_credit := v_cumulative_profit - v_previous_profit;

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
          'hour', v_hour,
          'daily_rate', v_investment.daily_rate_snapshot,
          'hourly_rate', v_investment.daily_rate_snapshot / 24,
          'principal', v_investment.principal_amount,
          'rate_basis', v_investment.rate_basis_snapshot
        )
      ) on conflict (idempotency_key) do nothing;
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
        jsonb_build_object(
          'term_days', v_investment.term_days_snapshot,
          'term_hours', v_investment.term_days_snapshot * 24,
          'matured_at', v_now
        )
      ) on conflict (idempotency_key) do nothing;

      update public.investments
        set status = 'matured', matured_at = coalesce(matured_at, v_now)
      where id = v_investment.id and status = 'active';
    end if;

    v_processed := v_processed + 1;
  end loop;
  return v_processed;
end;
$function$;
