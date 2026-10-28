-- Payment method is mandatory for all new money requests.
-- Existing request table is empty in the initial foundation project.
begin;
alter table public.money_requests alter column payment_method set not null;
commit;
