import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const ADMIN_EMAIL = "grashfxmw@gmail.com";
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
function amount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10000000) return null;
  return Math.round(value * 100) / 100;
}
function idempotency(req: Request, body: Record<string, unknown>): string {
  const value = req.headers.get("x-idempotency-key") || body.idempotency_key;
  return typeof value === "string" ? value.trim() : "";
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST"].includes(req.method)) return json({ error: "Method not allowed" }, 405);
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "Sign in is required." }, 401);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const publishableKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const publishableKey = publishableKeys.default;
    const secretKey = secretKeys.default;
    if (!url || !publishableKey || !secretKey) return json({ error: "Server configuration is incomplete." }, 500);
    const authClient = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user) return json({ error: "Session is invalid or expired." }, 401);
    if (!user.email_confirmed_at) return json({ error: "Verify your email before using your account." }, 403);
    const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const path = new URL(req.url).pathname.replace(/\/$/, "");
    const { data: profile, error: profileError } = await admin.from("profiles")
      .select("id,email,status,role").eq("id", user.id).maybeSingle();
    if (profileError) throw profileError;

    const isAdmin = (user.email ?? "").toLowerCase() === ADMIN_EMAIL &&
      profile?.role === "admin" && profile?.status === "active";

    if (req.method === "GET" && path.endsWith("/plans")) {
      const { data, error } = await admin.from("investment_plans")
        .select("code,name,daily_rate,min_amount,max_amount,duration_days")
        .eq("active", true).order("min_amount");
      if (error) throw error;
      return json({ plans: data ?? [] });
    }
    if (req.method === "GET" && path.endsWith("/me")) {
      const { data, error } = await admin.from("profiles").select(
        "id,full_name,email,phone_e164,phone_verified_at,status,role,balance,profit_balance,referral_code,created_at"
      ).eq("id", user.id).maybeSingle();
      if (error) throw error;
      if (!data) return json({ profile: null, profile_required: true });
      return json({ profile: data });
    }

    if (req.method === "GET" && path.endsWith("/history")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const [transactions, investments] = await Promise.all([
        admin.from("financial_transactions")
          .select("id,kind,amount,status,reference,description,created_at,metadata")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
        admin.from("investments")
          .select("id,plan_code,principal,daily_rate,duration_days,profit_paid,status,started_at,matures_at,completed_at,last_processed_day")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
      ]);
      if (transactions.error) throw transactions.error;
      if (investments.error) throw investments.error;
      return json({ transactions: transactions.data ?? [], investments: investments.data ?? [] });
    }

    if (req.method === "GET" && path.endsWith("/admin/queue")) {
      if (!isAdmin) return json({ error: "Admin access required." }, 403);
      const [profiles, transactions, investments, customers] = await Promise.all([
        admin.from("profiles")
          .select("id,full_name,email,phone_e164,status,role,balance,profit_balance,created_at")
          .neq("role", "admin").in("status", ["pending", "review_required"])
          .order("created_at", { ascending: true }).limit(100),
        admin.from("financial_transactions")
          .select("id,user_id,kind,amount,status,reference,description,created_at,metadata")
          .in("status", ["pending", "processing"])
          .in("kind", ["deposit", "withdrawal"])
          .order("created_at", { ascending: true }).limit(100),
        admin.from("investments")
          .select("id,user_id,plan_code,principal,daily_rate,duration_days,profit_paid,status,started_at,matures_at,completed_at,last_processed_day")
          .in("status", ["active", "review_required"])
          .order("matures_at", { ascending: true }).limit(100),
        admin.from("profiles")
          .select("id,full_name,email,phone_e164,status,balance,profit_balance,created_at")
          .neq("role", "admin")
          .order("created_at", { ascending: false }).limit(200),
      ]);
      if (profiles.error) throw profiles.error;
      if (transactions.error) throw transactions.error;
      if (investments.error) throw investments.error;
      if (customers.error) throw customers.error;
      return json({ pending_profiles: profiles.data ?? [], financial_requests: transactions.data ?? [], investments: investments.data ?? [], customers: customers.data ?? [] });
    }

    if (req.method === "POST" && (path.endsWith("/profile") || path.endsWith("/me"))) {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
      const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
      if (fullName.length < 2 || fullName.length > 100) return json({ error: "Enter a name between 2 and 100 characters." }, 400);
      if (profile) return json({ error: "Profile already exists." }, 409);
      const email = (user.email ?? "").trim().toLowerCase();
      const isBootstrapAdmin = email === ADMIN_EMAIL;
      const referralCode = crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
      const { data, error } = await admin.from("profiles").insert({
        id: user.id, full_name: fullName, email, phone_e164: null,
        phone_verified_at: null, referral_code: referralCode,
        status: isBootstrapAdmin ? "active" : "pending", role: isBootstrapAdmin ? "admin" : "customer",
      }).select("id,full_name,email,phone_e164,phone_verified_at,status,role,balance,profit_balance,referral_code,created_at").single();
      if (error) {
        if (error.code === "23505") return json({ error: "An account already uses one of these details. Contact support if this is unexpected." }, 409);
        throw error;
      }
      await admin.from("audit_events").insert({ actor_user_id: user.id, subject_user_id: user.id, action: "profile_created", outcome: "success", metadata: { source: "account-api" } });
      const requestedReferralCode = typeof body.referral_code === "string" ? body.referral_code.trim().slice(0, 64) : "";
      if (requestedReferralCode && !isBootstrapAdmin) {
        const { error: referralError } = await admin.rpc("apply_signup_referral_bonus", {
          p_new_user_id: user.id,
          p_referral_code: requestedReferralCode,
        });
        if (referralError) console.error("Referral bonus processing failed", referralError);
      }
      return json({ profile: data }, 201);
    }

    if (req.method === "POST" && ["/deposit", "/withdrawal", "/investment", "/admin/review", "/admin/profile-review"].some(s => path.endsWith(s))) {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
      if (!profile) return json({ error: "Complete account registration first." }, 403);

      if (path.endsWith("/admin/profile-review")) {
        if (!isAdmin) return json({ error: "Admin access required." }, 403);
        const targetUserId = typeof body.user_id === "string" ? body.user_id : "";
        const decision = body.decision;
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
        const { data, error } = await admin.rpc("admin_review_profile", {
          p_target_user_id: targetUserId, p_admin_user_id: user.id,
          p_decision: decision, p_reason: reason,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ profile: data });
      }

      if (path.endsWith("/admin/review")) {
        if (!isAdmin) return json({ error: "Admin access required." }, 403);
        const transactionId = typeof body.transaction_id === "string" ? body.transaction_id : "";
        const decision = body.decision;
        const { data, error } = await admin.rpc("admin_review_financial_transaction", {
          p_transaction_id: transactionId, p_admin_user_id: user.id,
          p_decision: decision, p_reference: typeof body.reference === "string" ? body.reference : null,
          p_reason: typeof body.reason === "string" ? body.reason : null,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ transaction: data });
      }
      if (profile.status !== "active") return json({ error: "Your account must be approved before requesting financial operations." }, 403);
      const value = amount(body.amount);
      if (value === null) return json({ error: "Enter a valid positive amount." }, 400);
      if (path.endsWith("/deposit") && value < 20) return json({ error: "The minimum deposit is $20.00." }, 400);
      if (path.endsWith("/withdrawal") && value < 50) return json({ error: "The minimum withdrawal is $50.00." }, 400);
      const key = idempotency(req, body);
      if (key.length < 8 || key.length > 128) return json({ error: "Include an idempotency key of 8–128 characters." }, 400);
      if (path.endsWith("/deposit")) {
        const { data, error } = await admin.rpc("request_deposit", {
          p_user_id: user.id, p_amount: value, p_idempotency_key: key,
          p_description: typeof body.description === "string" ? body.description.slice(0,250) : "Customer deposit request",
        });
        if (error) return json({ error: error.message }, 400);
        return json({ transaction: data }, 201);
      }
      if (path.endsWith("/withdrawal")) {
        const { data, error } = await admin.rpc("request_withdrawal", {
          p_user_id: user.id, p_amount: value, p_idempotency_key: key,
          p_description: typeof body.description === "string" ? body.description.slice(0,250) : "Customer withdrawal request",
        });
        if (error) return json({ error: error.message }, 400);
        return json({ transaction: data }, 201);
      }
      if (path.endsWith("/investment")) {
        const plan = typeof body.plan_code === "string" ? body.plan_code.toLowerCase() : "";
        const { data, error } = await admin.rpc("activate_investment", {
          p_user_id: user.id, p_plan_code: plan, p_amount: value, p_idempotency_key: key,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ investment: data }, 201);
      }
    }
    return json({ error: "Unknown endpoint." }, 404);
  } catch (error) {
    console.error("account-api error", error);
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
});
