-- Kiosk bank-payment checkout: durable operations and separated states.
--
-- Design notes for review:
--   * Four facts are stored separately because they fail separately:
--       bank_payments   (consent, preauthorization, capture as the provider reported them)
--       money_movements (settlements, refunds, returns: append-only, signed cents)
--       pos_orders      (the order as the POS reports it)
--       register_acks   (whether the register shows the order as paid)
--       handoffs        (whether staff released the goods)
--   * Every call to a bank or POS is an `operations` row. Its operation_key is created once,
--     with the row, and is the identity sent to the provider on every retry.
--   * Transactions are short. A worker claims an operation (FOR UPDATE SKIP LOCKED), commits,
--     calls the provider outside any transaction, then records the result with its claim token.
--     A worker that lost its lease cannot record anything (finish_operation raises lease_lost).
--   * Nothing here guarantees exactly-once effects at a provider. That depends on the
--     provider honoring the key, which is listed in docs/discovery-note.md as "to confirm".

create schema if not exists kiosk;

-- ---------------------------------------------------------------------------------------------
-- Saved bank references (provider tokens only, never account numbers)
-- ---------------------------------------------------------------------------------------------
create table kiosk.saved_bank_refs (
  id                   uuid primary key default gen_random_uuid(),
  shopper_id           uuid not null,
  store_id             uuid not null,
  provider_consent_ref text not null unique,
  consented_at         timestamptz not null default now(),
  revoked_at           timestamptz,
  revoked_reason       text
);

-- ---------------------------------------------------------------------------------------------
-- One row per kiosk checkout attempt. The kiosk sends the same kiosk_request_id on every tap
-- of the same checkout, so a double tap or a kiosk retry maps to the same row.
-- ---------------------------------------------------------------------------------------------
create table kiosk.checkouts (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null,
  shopper_id         uuid not null,
  kiosk_request_id   text not null check (length(kiosk_request_id) between 8 and 64),
  saved_ref_id       uuid not null references kiosk.saved_bank_refs (id),
  quoted_total_cents integer not null check (quoted_total_cents > 0),
  fee_cents          integer not null default 0 check (fee_cents >= 0),
  cart               jsonb not null,
  -- normalized summary for the kiosk and staff screens; the facts live in the tables below
  outcome            text not null default 'in_progress' check (outcome in (
                       'in_progress', 'ready_for_pickup', 'no_charge', 'needs_new_consent',
                       'needs_staff', 'closed')),
  outcome_reason     text,
  created_at         timestamptz not null default now(),
  unique (store_id, kiosk_request_id)
);

create table kiosk.bank_payments (
  checkout_id           uuid primary key references kiosk.checkouts (id),
  preauth_state         text not null default 'none' check (preauth_state in (
                          'none', 'preauthorized', 'declined', 'voided', 'expired', 'unknown')),
  preauth_ref           text unique,
  preauth_amount_cents  integer,
  capture_state         text not null default 'none' check (capture_state in (
                          'none', 'accepted', 'declined', 'unknown')),
  capture_ref           text unique,
  capture_amount_cents  integer,
  refund_state          text not null default 'none' check (refund_state in (
                          'none', 'accepted', 'declined', 'unknown')),
  refund_ref            text unique,
  refund_amount_cents   integer,
  raw_provider_state    jsonb not null default '{}'::jsonb,
  updated_at            timestamptz not null default now(),
  -- a capture can never exceed what the shopper preauthorized (R11 territory otherwise)
  constraint capture_within_preauth check (
    capture_amount_cents is null or capture_amount_cents <= preauth_amount_cents)
);

create table kiosk.pos_orders (
  checkout_id       uuid primary key references kiosk.checkouts (id),
  pos_order_id      uuid not null unique default gen_random_uuid(), -- caller-generated GUID
  order_state       text not null default 'not_submitted' check (order_state in (
                      'not_submitted', 'submitted', 'ready_for_payment', 'rejected', 'unknown',
                      'cancelled', 'completed')),
  sale_total_cents  integer,
  raw_status        text,
  raw_message       text,
  updated_at        timestamptz not null default now()
);

create table kiosk.register_acks (
  checkout_id  uuid primary key references kiosk.checkouts (id),
  ack_state    text not null default 'not_sent' check (ack_state in (
                 'not_sent', 'sent', 'applied', 'cannot_be_applied', 'unknown')),
  amount_cents integer,
  raw_status   text,
  updated_at   timestamptz not null default now()
);

create table kiosk.handoffs (
  checkout_id     uuid primary key references kiosk.checkouts (id),
  handed_over_at  timestamptz not null,
  staff_id        text not null,
  override_reason text,          -- required when the register did not acknowledge payment
  goods_returned_at timestamptz
);

-- Signed cents. Unique per (kind, provider_ref): a duplicate webhook, or a webhook and a poll
-- reporting the same fact, insert nothing new.
create table kiosk.money_movements (
  id             bigserial primary key,
  checkout_id    uuid not null references kiosk.checkouts (id),
  kind           text not null check (kind in ('settlement', 'refund', 'return')),
  provider_ref   text not null,
  amount_cents   integer not null,
  return_code    text,
  effective_date date not null,
  source         text not null check (source in ('webhook', 'poll')),
  recorded_at    timestamptz not null default now(),
  unique (kind, provider_ref),
  constraint sign_matches_kind check (
    (kind = 'settlement' and amount_cents > 0) or (kind in ('refund', 'return') and amount_cents < 0))
);

create table kiosk.operations (
  id            uuid primary key default gen_random_uuid(),
  checkout_id   uuid not null references kiosk.checkouts (id),
  kind          text not null check (kind in (
                  'bank_preauthorize', 'pos_submit_order', 'pos_check_order', 'bank_capture',
                  'pos_apply_payment', 'pos_check_payment', 'pos_cancel_order',
                  'bank_void_preauth', 'bank_refund')),
  seq           integer not null default 1,
  operation_key uuid not null unique default gen_random_uuid(),
  state         text not null default 'ready' check (state in (
                  'ready', 'claimed', 'done', 'needs_investigation')),
  not_before    timestamptz not null default now(),
  attempts      integer not null default 0,
  claim_token   uuid,
  claimed_by    text,
  lease_until   timestamptz,
  last_outcome  text,
  last_error    text,
  input         jsonb not null default '{}'::jsonb,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (checkout_id, kind, seq)
);
create index operations_runnable on kiosk.operations (not_before) where state in ('ready', 'claimed');

create table kiosk.webhook_receipts (
  provider_event_id text primary key,
  event_type        text not null,
  received_at       timestamptz not null default now(),
  result            text not null
);

create table kiosk.events (
  id          bigserial primary key,
  checkout_id uuid,
  source      text not null,
  type        text not null,
  detail      jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

create function kiosk.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'append_only: % is append-only', tg_table_name;
end $$;
create trigger events_append_only before update or delete on kiosk.events
  for each row execute function kiosk.forbid_change();
create trigger movements_append_only before update or delete on kiosk.money_movements
  for each row execute function kiosk.forbid_change();

create function kiosk.log(p_checkout uuid, p_source text, p_type text, p_detail jsonb, p_now timestamptz)
returns void language sql
security definer set search_path = kiosk, pg_temp as $$
  insert into kiosk.events (checkout_id, source, type, detail, at) values (p_checkout, p_source, p_type, coalesce(p_detail, '{}'::jsonb), p_now);
$$;

-- ---------------------------------------------------------------------------------------------
-- start_checkout: called by the Edge Function after it has verified the shopper's session.
-- ---------------------------------------------------------------------------------------------
create function kiosk.start_checkout(
  p_store uuid, p_shopper uuid, p_kiosk_request_id text, p_saved_ref uuid,
  p_quoted_total_cents integer, p_fee_cents integer, p_cart jsonb, p_now timestamptz default now())
returns table (checkout_id uuid, created boolean)
language plpgsql
security definer set search_path = kiosk, pg_temp as $$
declare
  v_ref kiosk.saved_bank_refs;
  v_id uuid;
  v_existing kiosk.checkouts;
begin
  select * into v_ref from kiosk.saved_bank_refs where id = p_saved_ref;
  if not found or v_ref.shopper_id <> p_shopper or v_ref.store_id <> p_store then
    raise exception 'saved_reference_not_usable';
  end if;
  if v_ref.revoked_at is not null then
    raise exception 'reauthentication_required';
  end if;

  insert into kiosk.checkouts (store_id, shopper_id, kiosk_request_id, saved_ref_id,
                               quoted_total_cents, fee_cents, cart, created_at)
  values (p_store, p_shopper, p_kiosk_request_id, p_saved_ref, p_quoted_total_cents, p_fee_cents, p_cart, p_now)
  on conflict (store_id, kiosk_request_id) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from kiosk.checkouts c
      where c.store_id = p_store and c.kiosk_request_id = p_kiosk_request_id;
    if v_existing.shopper_id <> p_shopper or v_existing.quoted_total_cents <> p_quoted_total_cents then
      raise exception 'kiosk_request_id_reused_with_different_checkout';
    end if;
    perform kiosk.log(v_existing.id, 'kiosk', 'duplicate_submission_joined', '{}'::jsonb, p_now);
    return query select v_existing.id, false;
    return;
  end if;

  insert into kiosk.bank_payments (checkout_id) values (v_id);
  insert into kiosk.pos_orders (checkout_id) values (v_id);
  insert into kiosk.register_acks (checkout_id) values (v_id);
  insert into kiosk.operations (checkout_id, kind, not_before, input)
    values (v_id, 'bank_preauthorize', p_now,
            jsonb_build_object('amount_cents', p_quoted_total_cents + p_fee_cents,
                               'consent_ref', v_ref.provider_consent_ref));
  perform kiosk.log(v_id, 'kiosk', 'checkout_started',
                    jsonb_build_object('quoted_total_cents', p_quoted_total_cents, 'fee_cents', p_fee_cents), p_now);
  return query select v_id, true;
end $$;

-- ---------------------------------------------------------------------------------------------
-- claim_next_operation: short transaction; the lock is released at commit, before any I/O.
-- ---------------------------------------------------------------------------------------------
create function kiosk.claim_next_operation(p_worker text, p_lease_seconds integer, p_now timestamptz default now())
returns setof kiosk.operations
language plpgsql
security definer set search_path = kiosk, pg_temp as $$
declare
  v_op kiosk.operations;
  v_reclaim boolean;
begin
  select * into v_op from kiosk.operations o
   where (o.state = 'ready' and o.not_before <= p_now)
      or (o.state = 'claimed' and o.lease_until < p_now)
   order by o.not_before, o.created_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;
  v_reclaim := v_op.state = 'claimed';
  update kiosk.operations o
     set state = 'claimed', claim_token = gen_random_uuid(), claimed_by = p_worker,
         lease_until = p_now + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1, updated_at = p_now
   where o.id = v_op.id
   returning * into v_op;
  perform kiosk.log(v_op.checkout_id, 'worker',
                    case when v_reclaim then 'operation_reclaimed_after_lease_expiry' else 'operation_claimed' end,
                    jsonb_build_object('kind', v_op.kind, 'seq', v_op.seq, 'attempt', v_op.attempts, 'worker', p_worker), p_now);
  return next v_op;
end $$;

-- ---------------------------------------------------------------------------------------------
-- finish_operation: applies one decision atomically. The decision is computed by the pure
-- TypeScript function decide() (src/workflow.ts) and passed as explicit, whitelisted fields.
-- ---------------------------------------------------------------------------------------------
create function kiosk.finish_operation(
  p_op uuid, p_claim_token uuid, p_decision jsonb, p_now timestamptz default now())
returns text
language plpgsql
security definer set search_path = kiosk, pg_temp as $$
declare
  v_op kiosk.operations;
  v_next jsonb;
  v_b jsonb := p_decision -> 'bank';
  v_p jsonb := p_decision -> 'pos';
  v_a jsonb := p_decision -> 'ack';
  v_pos_state text;
begin
  select * into v_op from kiosk.operations where id = p_op for update;
  if not found or v_op.state <> 'claimed' or v_op.claim_token is distinct from p_claim_token then
    raise exception 'lease_lost';
  end if;

  update kiosk.operations
     set state = case p_decision ->> 'op_state'
                   when 'retry' then 'ready' else p_decision ->> 'op_state' end,
         not_before = case when p_decision ->> 'op_state' = 'retry'
                        then p_now + make_interval(secs => coalesce((p_decision ->> 'retry_after_seconds')::int, 5))
                        else not_before end,
         claim_token = null, claimed_by = null, lease_until = null,
         last_outcome = p_decision ->> 'outcome',
         last_error = p_decision ->> 'error',
         result = p_decision -> 'result',
         updated_at = p_now
   where id = p_op;

  if v_b is not null then
    update kiosk.bank_payments set
      preauth_state        = coalesce(v_b ->> 'preauth_state', preauth_state),
      preauth_ref          = coalesce(v_b ->> 'preauth_ref', preauth_ref),
      preauth_amount_cents = coalesce((v_b ->> 'preauth_amount_cents')::int, preauth_amount_cents),
      capture_state        = coalesce(v_b ->> 'capture_state', capture_state),
      capture_ref          = coalesce(v_b ->> 'capture_ref', capture_ref),
      capture_amount_cents = coalesce((v_b ->> 'capture_amount_cents')::int, capture_amount_cents),
      refund_state         = coalesce(v_b ->> 'refund_state', refund_state),
      refund_ref           = coalesce(v_b ->> 'refund_ref', refund_ref),
      refund_amount_cents  = coalesce((v_b ->> 'refund_amount_cents')::int, refund_amount_cents),
      raw_provider_state   = raw_provider_state || coalesce(v_b -> 'raw', '{}'::jsonb),
      updated_at = p_now
    where checkout_id = v_op.checkout_id;
  end if;

  if v_p is not null then
    update kiosk.pos_orders set
      order_state      = coalesce(v_p ->> 'order_state', order_state),
      sale_total_cents = coalesce((v_p ->> 'sale_total_cents')::int, sale_total_cents),
      raw_status       = coalesce(v_p ->> 'raw_status', raw_status),
      raw_message      = coalesce(v_p ->> 'raw_message', raw_message),
      updated_at = p_now
    where checkout_id = v_op.checkout_id;
  end if;

  if v_a is not null then
    update kiosk.register_acks set
      ack_state    = coalesce(v_a ->> 'ack_state', ack_state),
      amount_cents = coalesce((v_a ->> 'amount_cents')::int, amount_cents),
      raw_status   = coalesce(v_a ->> 'raw_status', raw_status),
      updated_at = p_now
    where checkout_id = v_op.checkout_id;
  end if;

  if p_decision ? 'checkout_outcome' then
    update kiosk.checkouts
       set outcome = p_decision ->> 'checkout_outcome',
           outcome_reason = p_decision ->> 'checkout_reason'
     where id = v_op.checkout_id;
  end if;

  for v_next in select * from jsonb_array_elements(coalesce(p_decision -> 'next', '[]'::jsonb)) loop
    -- Defense in depth: never capture unless the POS confirmed the order and its total.
    if v_next ->> 'kind' = 'bank_capture' then
      select order_state into v_pos_state from kiosk.pos_orders where checkout_id = v_op.checkout_id;
      if v_pos_state <> 'ready_for_payment' then
        raise exception 'capture_without_confirmed_order';
      end if;
    end if;
    insert into kiosk.operations (checkout_id, kind, seq, not_before, input, created_at, updated_at)
    values (v_op.checkout_id, v_next ->> 'kind', coalesce((v_next ->> 'seq')::int, 1),
            p_now + make_interval(secs => coalesce((v_next ->> 'delay_seconds')::int, 0)),
            coalesce(v_next -> 'input', '{}'::jsonb), p_now, p_now)
    on conflict (checkout_id, kind, seq) do nothing;
  end loop;

  perform kiosk.log(v_op.checkout_id, 'worker', 'operation_finished',
                    jsonb_build_object('kind', v_op.kind, 'seq', v_op.seq, 'outcome', p_decision ->> 'outcome',
                                       'op_state', p_decision ->> 'op_state', 'note', p_decision ->> 'note'), p_now);
  return p_decision ->> 'op_state';
end $$;

-- ---------------------------------------------------------------------------------------------
-- record_bank_event: webhooks (after signature check in the Edge Function) and polls.
-- Money movements are facts keyed by (kind, provider_ref); arrival order does not matter.
-- ---------------------------------------------------------------------------------------------
create function kiosk.record_bank_event(
  p_event_id text, p_type text, p_ref text, p_amount_cents integer, p_return_code text,
  p_effective_date date, p_source text, p_now timestamptz default now())
returns text
language plpgsql
security definer set search_path = kiosk, pg_temp as $$
declare
  v_checkout uuid;
  v_inserted integer;
  v_result text;
begin
  if p_source = 'webhook' then
    insert into kiosk.webhook_receipts (provider_event_id, event_type, received_at, result)
    values (p_event_id, p_type, p_now, 'processing')
    on conflict (provider_event_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      return 'duplicate_event';
    end if;
  end if;

  if p_type = 'consent.revoked' then
    update kiosk.saved_bank_refs set revoked_at = p_now, revoked_reason = 'provider_revoked'
     where provider_consent_ref = p_ref and revoked_at is null;
    v_result := 'consent_revoked';
  elsif p_type = 'preauth.expired' then
    update kiosk.bank_payments set preauth_state = 'expired', updated_at = p_now
     where preauth_ref = p_ref and preauth_state = 'preauthorized' and capture_state = 'none'
     returning checkout_id into v_checkout;
    if v_checkout is not null then
      v_result := 'recorded';
    elsif exists (select 1 from kiosk.bank_payments where preauth_ref = p_ref) then
      v_result := 'already_known'; -- captured or voided already: the expiry changes nothing
    else
      v_result := 'unknown_reference';
    end if;
  else
    if p_type in ('payment.settled', 'payment.returned') then
      select checkout_id into v_checkout from kiosk.bank_payments where capture_ref = p_ref;
    elsif p_type = 'refund.settled' then
      select checkout_id into v_checkout from kiosk.bank_payments where refund_ref = p_ref;
    else
      raise exception 'unknown_event_type %', p_type;
    end if;

    if v_checkout is null then
      v_result := 'unknown_reference';
    else
      insert into kiosk.money_movements (checkout_id, kind, provider_ref, amount_cents, return_code, effective_date, source, recorded_at)
      values (v_checkout,
              case p_type when 'payment.settled' then 'settlement' when 'payment.returned' then 'return' else 'refund' end,
              p_ref,
              case when p_type = 'payment.settled' then abs(p_amount_cents) else -abs(p_amount_cents) end,
              p_return_code, p_effective_date, p_source, p_now)
      on conflict (kind, provider_ref) do nothing;
      get diagnostics v_inserted = row_count;
      v_result := case when v_inserted = 1 then 'recorded' else 'already_known' end;

      if p_type = 'payment.returned' and v_inserted = 1 then
        update kiosk.checkouts
           set outcome = 'needs_staff',
               outcome_reason = 'Bank returned the debit (' || coalesce(p_return_code, 'no code') || '). Money was taken back from the store.'
         where id = v_checkout;
      end if;
    end if;
    perform kiosk.log(v_checkout, p_source, p_type,
                      jsonb_build_object('ref', p_ref, 'amount_cents', p_amount_cents, 'return_code', p_return_code, 'result', v_result), p_now);
  end if;

  if p_source = 'webhook' then
    if v_result = 'unknown_reference' then
      -- Not ours yet (for example the refund reference is written after its settlement notice).
      -- Forget the receipt so the provider's retry is processed; the caller answers "retry later".
      delete from kiosk.webhook_receipts where provider_event_id = p_event_id;
    else
      update kiosk.webhook_receipts set result = v_result where provider_event_id = p_event_id;
    end if;
  end if;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Staff actions
-- ---------------------------------------------------------------------------------------------
create function kiosk.request_refund(p_checkout uuid, p_amount_cents integer, p_reason text, p_staff text, p_now timestamptz default now())
returns boolean
language plpgsql
security definer set search_path = kiosk, pg_temp as $$
declare
  v_b kiosk.bank_payments;
  v_inserted integer;
begin
  select * into v_b from kiosk.bank_payments where checkout_id = p_checkout for update;
  if v_b.capture_state <> 'accepted' then
    raise exception 'nothing_captured_to_refund';
  end if;
  if exists (select 1 from kiosk.money_movements where checkout_id = p_checkout and kind = 'return') then
    raise exception 'debit_already_returned';
  end if;
  if p_amount_cents <= 0 or p_amount_cents > v_b.capture_amount_cents then
    raise exception 'refund_amount_out_of_range';
  end if;
  -- one refund operation per checkout in this slice; a second request joins the first
  insert into kiosk.operations (checkout_id, kind, seq, not_before, input, created_at, updated_at)
  values (p_checkout, 'bank_refund', 1, p_now,
          jsonb_build_object('amount_cents', p_amount_cents, 'capture_ref', v_b.capture_ref, 'reason', p_reason), p_now, p_now)
  on conflict (checkout_id, kind, seq) do nothing;
  get diagnostics v_inserted = row_count;
  perform kiosk.log(p_checkout, 'staff', case when v_inserted = 1 then 'refund_requested' else 'refund_request_joined_existing' end,
                    jsonb_build_object('staff', p_staff, 'amount_cents', p_amount_cents, 'reason', p_reason), p_now);
  if p_reason = 'goods_returned' then
    update kiosk.handoffs set goods_returned_at = p_now where checkout_id = p_checkout and goods_returned_at is null;
  end if;
  return v_inserted = 1;
end $$;

create function kiosk.record_handoff(p_checkout uuid, p_staff text, p_override_reason text, p_now timestamptz default now())
returns void
language plpgsql
security definer set search_path = kiosk, pg_temp as $$
declare
  v_ack text;
begin
  select ack_state into v_ack from kiosk.register_acks where checkout_id = p_checkout;
  if v_ack <> 'applied' and coalesce(trim(p_override_reason), '') = '' then
    raise exception 'register_has_not_acknowledged_payment';
  end if;
  insert into kiosk.handoffs (checkout_id, handed_over_at, staff_id, override_reason)
  values (p_checkout, p_now, p_staff, nullif(trim(p_override_reason), ''))
  on conflict (checkout_id) do nothing;
  perform kiosk.log(p_checkout, 'staff', 'goods_handed_over',
                    jsonb_build_object('staff', p_staff, 'override_reason', p_override_reason, 'register_ack', v_ack), p_now);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Reconciliation: one row per checkout, amounts and references side by side.
-- expected_net_cents is what the store should hold if nothing else happens:
--   goods out and not returned -> the captured amount; otherwise 0.
-- unsettled_cents: captured, not yet settled or returned: money in flight, not lost.
-- short_cents: goods released (and not returned) but the settled net is below the capture.
-- exposure_cents = unsettled_cents + short_cents.
-- held_for_shopper_cents: money received for goods not released (or returned): owed as goods or refund.
create view kiosk.reconciliation as
select
  c.id as checkout_id,
  c.outcome,
  c.outcome_reason,
  c.quoted_total_cents,
  c.fee_cents,
  b.preauth_state, b.preauth_amount_cents,
  b.capture_state, b.capture_ref, b.capture_amount_cents,
  b.refund_state, b.refund_ref,
  p.pos_order_id, p.order_state, p.sale_total_cents,
  a.ack_state as register_ack_state, a.amount_cents as register_ack_cents,
  (h.checkout_id is not null) as goods_released,
  (h.goods_returned_at is not null) as goods_returned,
  coalesce(m.settled, 0) as settled_cents,
  coalesce(m.refunded, 0) as refunded_cents,
  coalesce(m.returned, 0) as returned_cents,
  coalesce(m.settled, 0) + coalesce(m.refunded, 0) + coalesce(m.returned, 0) as net_cash_cents,
  case when h.checkout_id is not null and h.goods_returned_at is null then coalesce(b.capture_amount_cents, 0) else 0 end as expected_net_cents,
  greatest(0,
    (case when h.checkout_id is not null and h.goods_returned_at is null then coalesce(b.capture_amount_cents, 0) else 0 end)
    - (coalesce(m.settled, 0) + coalesce(m.refunded, 0) + coalesce(m.returned, 0))) as exposure_cents,
  case when b.capture_state = 'accepted' and m.settled is null and m.returned is null
       and h.checkout_id is not null and h.goods_returned_at is null
       then coalesce(b.capture_amount_cents, 0) else 0 end as unsettled_cents,
  greatest(0,
    (case when h.checkout_id is not null and h.goods_returned_at is null then coalesce(b.capture_amount_cents, 0) else 0 end)
    - (coalesce(m.settled, 0) + coalesce(m.refunded, 0) + coalesce(m.returned, 0))
    - (case when b.capture_state = 'accepted' and m.settled is null and m.returned is null
            and h.checkout_id is not null and h.goods_returned_at is null
            then coalesce(b.capture_amount_cents, 0) else 0 end)) as short_cents,
  greatest(0,
    (coalesce(m.settled, 0) + coalesce(m.refunded, 0) + coalesce(m.returned, 0))
    - (case when h.checkout_id is not null and h.goods_returned_at is null then coalesce(b.capture_amount_cents, 0) else 0 end)) as held_for_shopper_cents,
  (select count(*) from kiosk.operations o where o.checkout_id = c.id and o.state = 'needs_investigation') as open_investigations
from kiosk.checkouts c
join kiosk.bank_payments b on b.checkout_id = c.id
join kiosk.pos_orders p on p.checkout_id = c.id
join kiosk.register_acks a on a.checkout_id = c.id
left join kiosk.handoffs h on h.checkout_id = c.id
left join lateral (
  select sum(amount_cents) filter (where kind = 'settlement') as settled,
         sum(amount_cents) filter (where kind = 'refund') as refunded,
         sum(amount_cents) filter (where kind = 'return') as returned
    from kiosk.money_movements mm where mm.checkout_id = c.id
) m on true;

-- ---------------------------------------------------------------------------------------------
-- Access. Browser roles (anon, authenticated) can read nothing and call nothing. The Edge
-- Function connects with a server-side credential and calls the functions as service_role (or as
-- the database owner). The functions are SECURITY DEFINER with a fixed search_path, so
-- service_role needs EXECUTE and read access for the snapshot and reconciliation queries only;
-- every write goes through a function. Tested in tests/postgres_test.ts.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on all functions in schema kiosk from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema kiosk from anon, authenticated';
    execute 'revoke all on all tables in schema kiosk from anon, authenticated';
    execute 'revoke all on all functions in schema kiosk from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema kiosk to service_role';
    execute 'grant select on all tables in schema kiosk to service_role';
    execute 'grant execute on all functions in schema kiosk to service_role';
  end if;
end $$;
-- RLS on, no policies: browser roles see nothing; service_role bypasses RLS in Supabase.
alter table kiosk.saved_bank_refs enable row level security;
alter table kiosk.checkouts enable row level security;
alter table kiosk.bank_payments enable row level security;
alter table kiosk.pos_orders enable row level security;
alter table kiosk.register_acks enable row level security;
alter table kiosk.handoffs enable row level security;
alter table kiosk.money_movements enable row level security;
alter table kiosk.operations enable row level security;
alter table kiosk.webhook_receipts enable row level security;
alter table kiosk.events enable row level security;
