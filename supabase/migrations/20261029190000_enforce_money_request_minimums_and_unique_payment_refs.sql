-- Enforce minimum transaction sizes in the live money_requests schema.
ALTER TABLE public.money_requests
  ADD CONSTRAINT money_requests_minimum_amount_by_type
  CHECK (
    (request_type = 'deposit' AND amount >= 20)
    OR (request_type = 'withdrawal' AND amount >= 50)
    OR request_type NOT IN ('deposit', 'withdrawal')
  );

-- Do not allow the same provider reference to be used to approve multiple requests.
CREATE UNIQUE INDEX money_requests_external_payment_reference_unique
  ON public.money_requests (lower(btrim(external_payment_reference)))
  WHERE external_payment_reference IS NOT NULL
    AND btrim(external_payment_reference) <> '';
