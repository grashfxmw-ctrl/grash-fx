import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const clean = (v: unknown, max = 250) => typeof v === "string" ? v.trim().slice(0, max) : "";
const money = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10000000 ? Math.round(v * 100) / 100 : null;
const keyOf = (req: Request, body: Record<string, unknown>) => clean(req.headers.get("x-idempotency-key") || body.idempotency_key, 128);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "Method not allowed." }, 405);
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "Sign in is required." }, 401);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
    if (!url || !publishableKey || !serviceKey) return json({ error: "Supabase function secrets are not configured." }, 500);

    const userClient = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: "Bearer " + token } },
    });
    const adminClient = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user) return json({ error: "Session is invalid or expired." }, 401);
    if (!user.email_confirmed_at) return json({ error: "Verify your email before using your account." }, 403);

    const { data: profile, error: profileError } = await adminClient.from("profiles")
      .select("user_id,full_name,email,phone,status,country_code,created_at,updated_at")
      .eq("user_id", user.id).maybeSingle();
    if (profileError) throw profileError;

    const path = new URL(req.url).pathname.replace(/\/$/, "");
    const isAdmin = async () => {
      const { data, error } = await adminClient.from("admin_roles").select("role_name")
        .eq("user_id", user.id).in("role_name", ["administrator", "finance_operator"])
        .is("revoked_at", null).limit(1);
      if (error) throw error;
      return (data || []).length > 0;
    };
    const getBalances = async () => {
      const { data, error } = await adminClient.from("ledger_entries").select("entry_type,amount,currency")
        .eq("user_id", user.id).eq("currency", "USD");
      if (error) throw error;
      let balance = 0, profit = 0;
      for (const row of data || []) {
        balance += Number(row.amount || 0);
        if (row.entry_type === "profit_credit") profit += Number(row.amount || 0);
      }
      const { data: pending, error: pendingError } = await adminClient.from("money_requests").select("amount")
        .eq("user_id", user.id).eq("request_type", "withdrawal").in("status", ["submitted", "under_review", "approved"]);
      if (pendingError) throw pendingError;
      const reserved = (pending || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      return { balance: Math.round(balance * 100) / 100, available_balance: Math.round((balance - reserved) * 100) / 100, profit_balance: Math.round(profit * 100) / 100 };
    };

    if (req.method === "GET" && path.endsWith("/plans")) {
      const { data, error } = await adminClient.from("investment_plans")
        .select("id,plan_code,display_name,daily_rate,minimum_amount,currency,term_days")
        .eq("is_active", true).eq("approval_status", "approved").order("minimum_amount");
      if (error) throw error;
      return json({ plans: (data || []).map(p => ({ id: p.id, code: p.plan_code, name: p.display_name,
        daily_rate: Number(p.daily_rate), min_amount: Number(p.minimum_amount), currency: p.currency,
        duration_days: p.term_days })) });
    }

    if (req.method === "GET" && path.endsWith("/me")) {
      if (!profile) return json({ profile: null, profile_required: true });
      const balances = await getBalances();
      return json({ profile: { ...profile, id: profile.user_id, phone_e164: profile.phone,
        role: "customer", ...balances } });
    }

    if (req.method === "GET" && path.endsWith("/history")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const [requests, investments, ledger] = await Promise.all([
        adminClient.from("money_requests").select("id,request_type,amount,currency,status,client_reference,submitted_at,created_at,payment_method")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
        adminClient.from("investments").select("id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,status,started_at,matures_at,matured_at,created_at")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
        adminClient.from("ledger_entries").select("id,investment_id,entry_type,amount,currency,description,created_at,metadata,idempotency_key")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
      ]);
      if (requests.error) throw requests.error;
      if (investments.error) throw investments.error;
      if (ledger.error) throw ledger.error;
      const planIds = [...new Set((investments.data || []).map(i => i.plan_id).filter(Boolean))];
      let plans: Record<string, string> = {};
      if (planIds.length) {
        const { data, error } = await adminClient.from("investment_plans").select("id,plan_code").in("id", planIds);
        if (error) throw error;
        plans = Object.fromEntries((data || []).map(p => [p.id, p.plan_code]));
      }
      return json({
        transactions: (requests.data || []).map(r => ({ id: r.id, kind: r.request_type, amount: Number(r.amount),
          status: r.status, reference: r.client_reference, description: r.payment_method, created_at: r.created_at || r.submitted_at })),
        investments: (investments.data || []).map(i => ({ id: i.id, plan_code: plans[i.plan_id] || "investment",
          principal: Number(i.principal_amount), daily_rate: Number(i.daily_rate_snapshot), duration_days: i.term_days_snapshot,
          status: i.status, started_at: i.started_at, matures_at: i.matures_at, completed_at: i.matured_at,
          last_processed_day: (ledger.data || []).filter(e => e.investment_id === i.id && e.entry_type === "profit_credit").length })),
        ledger: ledger.data || [],
      });
    }

    if (req.method === "GET" && path.endsWith("/admin/queue")) {
      if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
      const [profiles, requests, investments] = await Promise.all([
        adminClient.from("profiles").select("user_id,full_name,email,phone,status,created_at").order("created_at").limit(200),
        adminClient.from("money_requests").select("id,user_id,request_type,amount,currency,status,client_reference,payment_method,submitted_at,created_at")
          .in("status", ["submitted", "under_review", "approved"]).order("created_at").limit(200),
        adminClient.from("investments").select("id,user_id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,status,started_at,matures_at,matured_at,created_at")
          .in("status", ["active", "under_review", "pending"]).order("matures_at").limit(200),
      ]);
      if (profiles.error) throw profiles.error;
      if (requests.error) throw requests.error;
      if (investments.error) throw investments.error;
      const planIds = [...new Set((investments.data || []).map(i => i.plan_id).filter(Boolean))];
      let plans: Record<string, string> = {};
      if (planIds.length) {
        const { data, error } = await adminClient.from("investment_plans").select("id,plan_code").in("id", planIds);
        if (error) throw error;
        plans = Object.fromEntries((data || []).map(p => [p.id, p.plan_code]));
      }
      const customerIds = (profiles.data || []).map(p => p.user_id);
      let ledgerRows: Array<{user_id:string;investment_id:string|null;entry_type:string;amount:number|string;currency:string}> = [];
      if (customerIds.length) {
        const { data, error } = await adminClient.from("ledger_entries")
          .select("user_id,investment_id,entry_type,amount,currency").in("user_id", customerIds).eq("currency", "USD").limit(10000);
        if (error) throw error;
        ledgerRows = (data || []) as Array<{user_id:string;investment_id:string|null;entry_type:string;amount:number|string;currency:string}>;
      }
      const pendingByUser = new Map<string, number>();
      for (const r of requests.data || []) {
        if (r.request_type === "withdrawal" && ["submitted","under_review","approved"].includes(r.status)) {
          pendingByUser.set(r.user_id, (pendingByUser.get(r.user_id) || 0) + Number(r.amount || 0));
        }
      }
      const balances = new Map<string, {balance:number;profit_balance:number}>();
      for (const row of ledgerRows) {
        const item = balances.get(row.user_id) || {balance:0,profit_balance:0};
        item.balance += Number(row.amount || 0);
        if (row.entry_type === "profit_credit") item.profit_balance += Number(row.amount || 0);
        balances.set(row.user_id,item);
      }
      return json({
        pending_profiles: (profiles.data || []).filter(p => p.status === "pending").map(p => ({ id: p.user_id, ...p })),
        financial_requests: (requests.data || []).map(r => ({ id: r.id, user_id: r.user_id, kind: r.request_type,
          amount: Number(r.amount), status: r.status, reference: r.client_reference, description: r.payment_method,
          created_at: r.created_at || r.submitted_at })),
        investments: (investments.data || []).map(i => ({ id: i.id, user_id: i.user_id, plan_code: plans[i.plan_id] || "investment",
          principal: Number(i.principal_amount), daily_rate: Number(i.daily_rate_snapshot), duration_days: i.term_days_snapshot,
          status: i.status, started_at: i.started_at, matures_at: i.matures_at, completed_at: i.matured_at,
          last_processed_day: ledgerRows.filter(e => e.investment_id === i.id && e.entry_type === "profit_credit").length })),
        customers: (profiles.data || []).map(p => {
          const item = balances.get(p.user_id) || {balance:0,profit_balance:0};
          const reserved = pendingByUser.get(p.user_id) || 0;
          return { id:p.user_id, ...p, phone_e164:p.phone, balance:item.balance,
            available_balance:item.balance-reserved, profit_balance:item.profit_balance };
        }),
      });
    }

    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
      if (!profile) return json({ error: "Your profile is not ready yet. Sign in again shortly." }, 403);

      if (path.endsWith("/profile") || path.endsWith("/me")) {
        return json({ error: "A profile is created automatically at signup. Contact support if it is missing." }, 409);
      }

      if (path.endsWith("/deposit") || path.endsWith("/withdrawal")) {
        if (profile.status !== "active") return json({ error: "Your account must be approved before requesting financial operations." }, 403);
        const value = money(body.amount);
        if (value === null) return json({ error: "Enter a valid positive amount." }, 400);
        const key = keyOf(req, body);
        if (key.length < 8) return json({ error: "Include an idempotency key of 8–128 characters." }, 400);
        const withdrawal = path.endsWith("/withdrawal");
        if (!withdrawal && value < 20) return json({ error: "The minimum deposit is $20.00." }, 400);
        if (withdrawal && value < 50) return json({ error: "The minimum withdrawal is $50.00." }, 400);
        const clientReference = clean(body.client_reference || body.reference, 120);
        const paymentMethod = clean(body.payment_method || "bank_transfer", 40);
        const details = body.payment_details && typeof body.payment_details === "object" && !Array.isArray(body.payment_details)
          ? body.payment_details : {};
        if (!withdrawal && clientReference.length < 3) return json({ error: "Enter the transfer reference so finance can match your deposit." }, 400);
        if (withdrawal && (!clean((details as Record<string, unknown>).account_holder, 120) ||
          !clean((details as Record<string, unknown>).account_number, 120))) {
          return json({ error: "Provide the bank account holder and account number for the withdrawal." }, 400);
        }
        const { data, error } = await userClient.rpc("submit_money_request", {
          p_request_type: withdrawal ? "withdrawal" : "deposit", p_amount: value, p_currency: "USD",
          p_payment_method: paymentMethod, p_payment_details: details, p_client_reference: clientReference || null,
          p_idempotency_key: key,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ request: { id: data, status: "submitted", request_type: withdrawal ? "withdrawal" : "deposit", amount: value } }, 201);
      }

      if (path.endsWith("/investment")) {
        if (profile.status !== "active") return json({ error: "Your account must be approved before investing." }, 403);
        const value = money(body.amount);
        const key = keyOf(req, body);
        const planCode = clean(body.plan_code, 32).toLowerCase();
        if (value === null || key.length < 8 || !planCode) return json({ error: "A valid amount, plan, and idempotency key are required." }, 400);
        const { data: plan, error: planError } = await adminClient.from("investment_plans").select("id,plan_code")
          .eq("plan_code", planCode).eq("is_active", true).eq("approval_status", "approved").maybeSingle();
        if (planError) throw planError;
        if (!plan) return json({ error: "That investment plan is not currently available." }, 400);
        const { data, error } = await userClient.rpc("request_investment", {
          p_plan_id: plan.id, p_amount: value, p_idempotency_key: key,
        });
        if (error) return json({ error: error.message }, 400);
        const { data: investment, error: readError } = await adminClient.from("investments")
          .select("id,principal_amount,status,started_at,matures_at").eq("id", data).single();
        if (readError) throw readError;
        return json({ investment: { id: investment.id, principal: Number(investment.principal_amount), status: investment.status,
          started_at: investment.started_at, matures_at: investment.matures_at } }, 201);
      }

      if (path.endsWith("/admin/review")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const requestId = clean(body.transaction_id || body.request_id, 64);
        const decision = clean(body.decision, 32);
        const reason = clean(body.reason || body.reference, 500);
        if (!requestId || reason.length < 3) return json({ error: "Request ID and a review reason/reference of at least 3 characters are required." }, 400);
        let action = "";
        if (decision === "reject") {
          action = "reject";
        } else if (decision === "approve" || decision === "complete") {
          const { data: request, error } = await adminClient.from("money_requests")
            .select("request_type,status").eq("id", requestId).maybeSingle();
          if (error) throw error;
          if (!request) return json({ error: "Money request not found." }, 404);
          if (decision === "complete") {
            if (request.request_type !== "withdrawal" || request.status !== "approved") {
              return json({ error: "Only an approved withdrawal can be marked paid." }, 409);
            }
            action = "complete_withdrawal";
          } else {
            if (request.status !== "submitted" && request.status !== "under_review") {
              return json({ error: "Only pending requests can be approved." }, 409);
            }
            action = request.request_type === "deposit" ? "confirm_deposit" : "approve_withdrawal";
          }
        } else return json({ error: "Unsupported review decision." }, 400);
        const { data, error } = await userClient.rpc("review_money_request", {
          p_request_id: requestId, p_action: action, p_reason: reason,
          p_external_payment_reference: clean(body.reference || body.reason, 160),
        });
        if (error) return json({ error: error.message }, 400);
        return json({ request_id: data, status: "reviewed" });
      }

      if (path.endsWith("/admin/profile-review")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const targetUserId = clean(body.user_id, 64);
        const decision = clean(body.decision, 32);
        const reason = clean(body.reason, 500);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
          return json({ error: "A valid customer ID is required." }, 400);
        }
        if (!["approve", "reject"].includes(decision)) return json({ error: "Decision must be approve or reject." }, 400);
        if (decision === "reject" && reason.length < 3) return json({ error: "Enter a reason of at least 3 characters when rejecting an account." }, 400);
        const nextStatus = decision === "approve" ? "active" : "restricted";
        const { data: target, error: targetError } = await adminClient.from("profiles")
          .update({ status: nextStatus, updated_at: new Date().toISOString() })
          .eq("user_id", targetUserId).eq("status", "pending")
          .select("user_id,full_name,email,status,created_at,updated_at").maybeSingle();
        if (targetError) throw targetError;
        if (!target) return json({ error: "Pending customer profile not found or it has already been reviewed." }, 409);
        const { error: auditError } = await adminClient.from("audit_events").insert({
          actor_user_id: user.id, action: decision === "approve" ? "profile.approved" : "profile.rejected",
          entity_type: "profile", entity_id: targetUserId, reason: reason || "Administrator reviewed customer registration",
          details: { decision, status: nextStatus, source: "account-api" }
        });
        if (auditError) throw auditError;
        return json({ profile: { id: target.user_id, ...target } });
      }
    }
    return json({ error: "Unknown endpoint." }, 404);
  } catch (error) {
    console.error("account-api error", error);
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
});