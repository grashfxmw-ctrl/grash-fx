-- GRASH FX proposed plan values.
-- All plans are intentionally inactive and unapproved by default.
-- These extraordinary daily rates require independent legal, financial and risk review.
-- Do not activate plans or accept deposits based on this seed file alone.

insert into public.investment_plans
  (plan_code, version, display_name, daily_rate, minimum_amount, currency, term_days, rate_basis, is_active, approval_status)
values
  ('starter', 1, 'Starter Plan', 0.100000, 50.00, 'USD', 7, 'simple_daily', false, 'draft'),
  ('basic',   1, 'Basic Plan',   0.200000, 500.00, 'USD', 7, 'simple_daily', false, 'draft'),
  ('premium', 1, 'Premium Plan', 0.300000, 1000.00, 'USD', 7, 'simple_daily', false, 'draft'),
  ('vip',     1, 'VIP Plan',     0.400000, 2000.00, 'USD', 7, 'simple_daily', false, 'draft')
on conflict (plan_code, version) do nothing;
