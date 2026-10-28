-- GRASH FX backend foundation
-- PostgreSQL schema only. Do not run against a live-money database before review.
-- Auth-provider user IDs are stored as UUIDs but intentionally have no FK to a
-- provider-specific auth schema until the provider is chosen.

begin;

create extension if not exists pgcrypto;

create type public.account_status as enum ('pending', 'active', 'restricted', 'closed');
create type public.investment_status as enum ('pending', 'active', 'matured', 'cancelled', 'under_review');
create type public.money_request_status as enum ('submitted', 'under_review', 'approved', 'rejected', 'paid', 'cancelled');
create type public.ledger_entry_type as enum (
  'deposit_credit', 'investment_principal_debit', 'principal_return_credit',
  'profit_credit', 'withdrawal_debit', 'referral_bonus_credit',
  'adjustment_credit', 'adjustment_debit', 'reversal'
);

create table public.profiles (
  user_id uuid primary key,
  full_name text not null check (length(trim(full_name)) between 1 and 160),
  email text,
  phone text,
  status public.account_status not null default 'pending',
  country_code char(2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  terms_version text,
  privacy_version text,
  terms_accepted_at timestamptz,
  privacy_accepted_at timestamptz
);

create table public.admin_roles (
  user_id uuid not null,
  role_name text not null check (role_name in ('support', 'finance_operator', 'reviewer', 'administrator')),
  granted_by uuid,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  reason text not null,
  primary key (user_id, role_name, granted_at)
);

create table public.investment_plans (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null,
  version integer not null check (version > 0),
  display_name text not null,
  daily_rate numeric(9,6) not null check (daily_rate >= 0 and daily_rate <= 1),
  minimum_amount numeric(20,2) not null check (minimum_amount > 0),
  currency char(3) not null default 'USD',
  term_days integer not null default 7 check (term_days = 7),
  rate_basis text not null default 'simple_daily' check (rate_basis in ('simple_daily')),
  is_active boolean not null default false,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'pending_review', 'approved', 'rejected')),
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  approval_reason text,
  unique (plan_code, version),
  check (effective_until is null or effective_from is null or effective_until > effective_from),
  check (not is_active or approval_status = 'approved')
);

create table public.investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  plan_id uuid not null references public.investment_plans(id),
  principal_amount numeric(20,2) not null check (principal_amount > 0),
  currency char(3) not null,
  daily_rate_snapshot numeric(9,6) not null check (daily_rate_snapshot >= 0 and daily_rate_snapshot <= 1),
  term_days_snapshot integer not null check (term_days_snapshot = 7),
  rate_basis_snapshot text not null check (rate_basis_snapshot = 'simple_daily'),
  status public.investment_status not null default 'pending',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  matures_at timestamptz,
  matured_at timestamptz,
  idempotency_key text not null unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (matures_at is null or started_at is not null),
  check (matured_at is null or status = 'matured')
);

create index investments_user_status_idx on public.investments(user_id, status);
create index investments_due_idx on public.investments(matures_at) where status = 'active';

create table public.money_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  request_type text not null check (request_type in ('deposit', 'withdrawal')),
  amount numeric(20,2) not null check (amount > 0),
  currency char(3) not null default 'USD',
  status public.money_request_status not null default 'submitted',
  client_reference text,
  external_payment_reference text,
  evidence_object_key text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  review_reason text,
  paid_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  check (reviewed_at is null or reviewed_by is not null),
  check (status <> 'paid' or paid_at is not null)
);

create index money_requests_user_idx on public.money_requests(user_id, submitted_at desc);
create index money_requests_queue_idx on public.money_requests(request_type, status, submitted_at);

-- Append-only journal. Amount is signed: positive credits, negative debits.
-- Available balances must be derived from posted ledger entries, not browser input.
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  investment_id uuid references public.investments(id),
  money_request_id uuid references public.money_requests(id),
  entry_type public.ledger_entry_type not null,
  amount numeric(20,2) not null check (amount <> 0),
  currency char(3) not null,
  idempotency_key text not null unique,
  related_entry_id uuid references public.ledger_entries(id),
  description text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  check (
    (entry_type in ('investment_principal_debit', 'withdrawal_debit', 'adjustment_debit') and amount < 0)
    or
    (entry_type in ('deposit_credit', 'principal_return_credit', 'profit_credit', 'referral_bonus_credit', 'adjustment_credit') and amount > 0)
    or entry_type = 'reversal'
  )
);

create index ledger_entries_user_time_idx on public.ledger_entries(user_id, created_at desc);
create index ledger_entries_investment_idx on public.ledger_entries(investment_id);
create index ledger_entries_request_idx on public.ledger_entries(money_request_id);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null,
  referred_user_id uuid not null unique,
  referral_code text not null,
  status text not null default 'pending' check (status in ('pending', 'eligible', 'rewarded', 'rejected')),
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  check (referrer_user_id <> referred_user_id)
);

create table public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  subject text not null check (length(trim(subject)) between 3 and 180),
  message text not null check (length(trim(message)) between 1 and 10000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_for_client', 'resolved', 'closed')),
  assigned_to uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  reason text,
  request_id text,
  ip_hash text,
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create table public.processed_jobs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  idempotency_key text not null unique,
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_code text,
  safe_error_summary text
);

-- Protect the journal from accidental edits. Corrections must be new linked entries.
create function public.reject_ledger_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger entries are append-only; post a correcting entry instead';
end;
$$;

create trigger ledger_entries_no_update
before update or delete on public.ledger_entries
for each row execute function public.reject_ledger_mutation();

commit;
