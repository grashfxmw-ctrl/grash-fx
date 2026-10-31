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
const sendGrashEmail = async (to: string, name: string, subject: string, heading: string, details: string[]) => {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { sent: false, warning: "Decision saved; RESEND_API_KEY is not configured." };
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" }[c] || c));
  const html = "<div style=\"font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px\"><h2>GRASH FX</h2><h3>" + esc(heading) + "</h3><p>Hello " + esc(name || "Client") + ",</p>" + details.map(x => "<p>" + esc(x) + "</p>").join("") + "<p>For help, reply to this email or contact grashfxmw@gmail.com.</p></div>";
  try {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ from: "GRASH FX <notifications@grashfx.aclclouds.online>", to: [to], reply_to: "grashfxmw@gmail.com", subject, html }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) { console.error("Resend email failed", response.status, (await response.text()).slice(0, 300)); return { sent: false, warning: "Decision saved, but email notification could not be sent. Check Resend configuration." }; }
    return { sent: true, warning: null };
  } catch (error) { console.error("Resend email request failed", error); return { sent: false, warning: "Decision saved, but email notification could not be sent. Check Resend configuration." }; }
};

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
      .select("user_id,full_name,email,phone,referral_code,status,country_code,created_at,updated_at")
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
      const [ledgerResult, pendingResult, referralCreditsResult, referralTransfersResult] = await Promise.all([
        adminClient.from("ledger_entries").select("entry_type,amount,currency").eq("user_id", user.id).eq("currency", "USD"),
        adminClient.from("money_requests").select("amount").eq("user_id", user.id).eq("request_type", "withdrawal")
          .in("status", ["submitted", "under_review", "approved"]),
        adminClient.from("ledger_entries").select("amount").eq("user_id", user.id)
          .eq("entry_type", "referral_bonus_credit").eq("currency", "USD"),
        adminClient.from("referral_transfers").select("amount").eq("user_id", user.id)
      ]);
      if (ledgerResult.error) throw ledgerResult.error;
      if (pendingResult.error) throw pendingResult.error;
      if (referralCreditsResult.error) throw referralCreditsResult.error;
      if (referralTransfersResult.error) throw referralTransfersResult.error;
      let balance = 0, profit = 0;
      for (const row of ledgerResult.data || []) {
        balance += Number(row.amount || 0);
        if (row.entry_type === "profit_credit") profit += Number(row.amount || 0);
      }
      const reserved = (pendingResult.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const referralEarned = (referralCreditsResult.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const referralTransferred = (referralTransfersResult.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
      return {
        balance: Math.round(balance * 100) / 100,
        available_balance: Math.round((balance - reserved) * 100) / 100,
        profit_balance: Math.round(profit * 100) / 100,
        referral_balance: Math.round((referralEarned - referralTransferred) * 100) / 100
      };
    };


    if (req.method === "GET" && path.endsWith("/admin/referral-management")) {
      if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
      const [profilesResult, referralsResult, ledgerResult, transfersResult, controlsResult, adjustmentsResult] = await Promise.all([
        adminClient.from("profiles").select("user_id,full_name,email,referral_code").order("created_at", { ascending: false }).limit(5000),
        adminClient.from("referrals").select("id,referrer_user_id,referred_user_id,referral_code,status,created_at,rewarded_at").order("created_at", { ascending: false }).limit(5000),
        adminClient.from("ledger_entries").select("user_id,entry_type,amount,metadata,created_at").eq("currency", "USD").in("entry_type", ["referral_bonus_credit", "adjustment_debit"]).order("created_at", { ascending: false }).limit(20000),
        adminClient.from("referral_transfers").select("user_id,amount,created_at").order("created_at", { ascending: false }).limit(5000),
        adminClient.from("referral_code_controls").select("user_id,enabled,reason,updated_at"),
        adminClient.from("audit_events").select("entity_id,reason,details,created_at").eq("action", "referral.bonus_adjusted").order("created_at", { ascending: false }).limit(100)
      ]);
      for (const result of [profilesResult, referralsResult, ledgerResult, transfersResult, controlsResult, adjustmentsResult]) {
        if (result.error) throw result.error;
      }
      const profiles = profilesResult.data || [];
      const profileById = new Map(profiles.map(p => [p.user_id, p]));
      const referralsByUser = new Map<string, Array<Record<string, unknown>>>();
      for (const referral of referralsResult.data || []) {
        const rows = referralsByUser.get(referral.referrer_user_id) || [];
        const referred = profileById.get(referral.referred_user_id);
        rows.push({
          id: referral.id,
          status: referral.status,
          referral_code: referral.referral_code,
          created_at: referral.created_at,
          rewarded_at: referral.rewarded_at,
          referred_name: referred?.full_name || "Referred client",
          referred_email: referred?.email || ""
        });
        referralsByUser.set(referral.referrer_user_id, rows);
      }
      const credits = new Map<string, number>();
      const earned = new Map<string, number>();
      const reductions = new Map<string, number>();
      for (const entry of ledgerResult.data || []) {
        const amount = Number(entry.amount || 0);
        const metadata = entry.metadata && typeof entry.metadata === "object" ? entry.metadata as Record<string, unknown> : {};
        if (entry.entry_type === "referral_bonus_credit") {
          credits.set(entry.user_id, (credits.get(entry.user_id) || 0) + amount);
          if (metadata.referral_id) earned.set(entry.user_id, (earned.get(entry.user_id) || 0) + amount);
        } else if (entry.entry_type === "adjustment_debit" &&
          metadata.source === "admin_referral_adjustment" && metadata.wallet === "referral" && metadata.direction === "reduce") {
          reductions.set(entry.user_id, (reductions.get(entry.user_id) || 0) + Math.abs(amount));
        }
      }
      const transferred = new Map<string, number>();
      for (const transfer of transfersResult.data || []) {
        transferred.set(transfer.user_id, (transferred.get(transfer.user_id) || 0) + Number(transfer.amount || 0));
      }
      const controls = new Map((controlsResult.data || []).map(c => [c.user_id, c]));
      const clients = profiles.map(p => {
        const referrals = referralsByUser.get(p.user_id) || [];
        const control = controls.get(p.user_id);
        const earnedTotal = earned.get(p.user_id) || 0;
        const transferredTotal = transferred.get(p.user_id) || 0;
        const referralBalance = (credits.get(p.user_id) || 0) - transferredTotal - (reductions.get(p.user_id) || 0);
        return {
          user_id: p.user_id,
          full_name: p.full_name,
          email: p.email,
          referral_code: p.referral_code,
          referrals,
          enabled: control?.enabled !== false,
          referral_balance: Math.round(referralBalance * 100) / 100,
          earned_total: Math.round(earnedTotal * 100) / 100,
          transferred_total: Math.round(transferredTotal * 100) / 100
        };
      });
      const adjustments = (adjustmentsResult.data || []).map(a => {
        const details = a.details && typeof a.details === "object" ? a.details as Record<string, unknown> : {};
        return {
          user_id: a.entity_id,
          reason: a.reason,
          amount: Number(details.signed_amount ?? (details.direction === "reduce" ? -Number(details.amount || 0) : Number(details.amount || 0))),
          created_at: a.created_at
        };
      });
      return json({ clients, adjustments });
    }

    if (req.method === "GET" && path.endsWith("/admin/client-detail")) {
      if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
      const targetId = clean(new URL(req.url).searchParams.get("user_id"), 64);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) return json({error:"A valid client account is required."},400);
      const [profileResult,authResult,ledgerResult,requestsResult,investmentsResult,loginResult,referralsResult,ticketsResult] = await Promise.all([
        adminClient.from("profiles").select("user_id,full_name,email,phone,referral_code,status,country_code,created_at,updated_at").eq("user_id",targetId).maybeSingle(),
        adminClient.auth.admin.getUserById(targetId),
        adminClient.from("ledger_entries").select("id,entry_type,amount,currency,description,created_at,investment_id").eq("user_id",targetId).order("created_at",{ascending:false}).limit(100),
        adminClient.from("money_requests").select("id,request_type,amount,currency,status,client_reference,external_payment_reference,payment_method,payment_details,submitted_at,created_at,reviewed_at,paid_at").eq("user_id",targetId).order("created_at",{ascending:false}).limit(100),
        adminClient.from("investments").select("id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,status,started_at,matures_at,matured_at,created_at").eq("user_id",targetId).order("created_at",{ascending:false}).limit(100),
        adminClient.from("login_events").select("id,country_code,user_agent,created_at").eq("user_id",targetId).order("created_at",{ascending:false}).limit(20),
        adminClient.from("referrals").select("id,referrer_user_id,referred_user_id,referral_code,status,created_at,rewarded_at").or("referrer_user_id.eq."+targetId+",referred_user_id.eq."+targetId).order("created_at",{ascending:false}).limit(100),
        adminClient.from("support_tickets").select("id,subject,message,status,created_at,updated_at").eq("user_id",targetId).order("created_at",{ascending:false}).limit(50)
      ]);
      for (const result of [profileResult,ledgerResult,requestsResult,investmentsResult,loginResult,referralsResult,ticketsResult]) if (result.error) throw result.error;
      if (!profileResult.data) return json({error:"Client account not found."},404);
      if (authResult.error) throw authResult.error;
      const ledger = ledgerResult.data || [];
      const balance = ledger.filter(x=>x.currency==="USD").reduce((sum,x)=>sum+Number(x.amount||0),0);
      const profit = ledger.filter(x=>x.currency==="USD"&&x.entry_type==="profit_credit").reduce((sum,x)=>sum+Number(x.amount||0),0);
      const pending = (requestsResult.data||[]).filter(x=>x.request_type==="withdrawal"&&["submitted","under_review","approved"].includes(x.status)).reduce((sum,x)=>sum+Number(x.amount||0),0);
      const planIds=[...new Set((investmentsResult.data||[]).map(x=>x.plan_id).filter(Boolean))];
      let planMap:Record<string,string>={};
      if(planIds.length){const {data,error}=await adminClient.from("investment_plans").select("id,plan_code,display_name").in("id",planIds);if(error)throw error;planMap=Object.fromEntries((data||[]).map(x=>[x.id,x.display_name||x.plan_code]));}
      const referralCredits=ledger.filter(x=>x.entry_type==="referral_bonus_credit").reduce((sum,x)=>sum+Number(x.amount||0),0);
      const {data:transfers,error:transferError}=await adminClient.from("referral_transfers").select("amount").eq("user_id",targetId);
      if(transferError)throw transferError;
      const referralTransferred=(transfers||[]).reduce((sum,x)=>sum+Number(x.amount||0),0);
      const authUser=authResult.data?.user, profileData=profileResult.data;
      return json({client:{...profileData,auth_created_at:authUser?.created_at||null,last_sign_in_at:authUser?.last_sign_in_at||null,email_confirmed_at:authUser?.email_confirmed_at||null,main_balance:Math.round(balance*100)/100,available_balance:Math.round((balance-pending)*100)/100,profit_balance:Math.round(profit*100)/100,referral_balance:Math.round((referralCredits-referralTransferred)*100)/100},
        ledger,requests:requestsResult.data||[],investments:(investmentsResult.data||[]).map(x=>({...x,plan_name:planMap[x.plan_id]||"Investment plan"})),
        login_events:loginResult.data||[],referrals:referralsResult.data||[],support_tickets:ticketsResult.data||[]});
    }

    if (req.method === "GET" && path.endsWith("/login-activity")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const { data, error } = await adminClient.from("login_events")
        .select("id,country_code,user_agent,created_at")
        .eq("user_id", user.id).order("created_at", { ascending: false }).limit(10);
      if (error) throw error;
      return json({ events: data || [] });
    }

    if (req.method === "GET" && path.endsWith("/messages") && !path.endsWith("/admin/messages")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const { error: readError } = await adminClient.from("support_messages")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", user.id).eq("sender_role", "admin").is("read_at", null);
      if (readError) throw readError;
      const { data, error } = await adminClient.from("support_messages")
        .select("id,user_id,sender_user_id,sender_role,body,created_at,read_at")
        .eq("user_id", user.id).order("created_at", { ascending: true }).limit(500);
      if (error) throw error;
      return json({ messages: data || [] });
    }

    if (req.method === "GET" && path.endsWith("/admin/messages")) {
      if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
      const targetUserId = clean(new URL(req.url).searchParams.get("user_id"), 64);
      if (targetUserId) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
          return json({ error: "A valid client account is required." }, 400);
        }
        const { data: target, error: targetError } = await adminClient.from("profiles")
          .select("user_id").eq("user_id", targetUserId).maybeSingle();
        if (targetError) throw targetError;
        if (!target) return json({ error: "Client account not found." }, 404);
        const { error: readError } = await adminClient.from("support_messages").update({ read_at: new Date().toISOString() })
          .eq("user_id", targetUserId).eq("sender_role", "client").is("read_at", null);
        if (readError) throw readError;
        const { data, error } = await adminClient.from("support_messages")
          .select("id,user_id,sender_user_id,sender_role,body,created_at,read_at")
          .eq("user_id", targetUserId).order("created_at", { ascending: true }).limit(500);
        if (error) throw error;
        return json({ messages: data || [] });
      }

      const { data: rows, error } = await adminClient.from("support_messages")
        .select("id,user_id,sender_user_id,sender_role,body,created_at,read_at")
        .order("created_at", { ascending: false }).limit(2000);
      if (error) throw error;
      const all = rows || [];
      const ids = [...new Set(all.map(m => m.user_id))];
      let profiles: Array<{user_id:string;full_name:string|null;email:string|null}> = [];
      if (ids.length) {
        const { data, error: profileListError } = await adminClient.from("profiles")
          .select("user_id,full_name,email").in("user_id", ids);
        if (profileListError) throw profileListError;
        profiles = data || [];
      }
      const profileById = new Map(profiles.map(p => [p.user_id, p]));
      const conversations = [...new Set(ids)].map(id => {
        const thread = all.filter(m => m.user_id === id);
        const last = thread[0];
        const p = profileById.get(id);
        return {
          user_id: id, full_name: p?.full_name || "Client", email: p?.email || "",
          unread_count: thread.filter(m => m.sender_role === "client" && !m.read_at).length,
          last_message: last ? { body: last.body, sender_role: last.sender_role } : null,
          last_at: last?.created_at || null
        };
      }).sort((a,b) => String(b.last_at || "").localeCompare(String(a.last_at || "")));
      return json({ conversations });
    }

    if (req.method === "GET" && path.endsWith("/announcements")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const { data, error } = await adminClient.from("platform_announcements")
        .select("id,title,body,label,published_at,created_at")
        .eq("is_published", true).order("published_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return json({ announcements: data || [] });
    }

    if (req.method === "GET" && path.endsWith("/admin/announcements")) {
      if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
      const { data, error } = await adminClient.from("platform_announcements")
        .select("id,title,body,label,is_published,published_at,created_at,updated_at")
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return json({ announcements: data || [] });
    }

    if (req.method === "GET" && path.endsWith("/plans")) {
      const { data, error } = await adminClient.from("investment_plans")
        .select("id,plan_code,display_name,daily_rate,minimum_amount,currency,term_days")
        .eq("is_active", true).eq("approval_status", "approved").order("minimum_amount");
      if (error) throw error;
      return json({ plans: (data || []).map(p => ({ id: p.id, code: p.plan_code, name: p.display_name,
        daily_rate: Number(p.daily_rate), min_amount: Number(p.minimum_amount), currency: p.currency,
        duration_days: p.term_days })) });
    }

    const tryReferralReward = async () => {
      const { error } = await userClient.rpc("process_my_referral_reward");
      if (error) console.warn("Referral reward processing deferred; it will be retried on a later account request.", error.message);
      return !error;
    };

    if (req.method === "GET" && path.endsWith("/me")) {
      if (user.email_confirmed_at) await tryReferralReward();
      if (!profile) return json({ profile: null, profile_required: true });
      const balances = await getBalances();
      return json({ profile: { ...profile, id: profile.user_id, phone_e164: profile.phone,
        role: "customer", ...balances } });
    }

    if (req.method === "GET" && path.endsWith("/referrals")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const [referralsResult, rewardsResult, transfersResult] = await Promise.all([
        adminClient.from("referrals").select("id,referred_user_id,referral_code,status,created_at,rewarded_at")
          .eq("referrer_user_id", user.id).order("created_at", { ascending: false }).limit(500),
        adminClient.from("ledger_entries").select("amount,created_at")
          .eq("user_id", user.id).eq("entry_type", "referral_bonus_credit").eq("currency", "USD")
          .order("created_at", { ascending: false }).limit(500),
        adminClient.from("referral_transfers").select("amount,created_at")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(500)
      ]);
      if (referralsResult.error) throw referralsResult.error;
      if (rewardsResult.error) throw rewardsResult.error;
      if (transfersResult.error) throw transfersResult.error;
      const referrals = referralsResult.data || [];
      const referredIds = referrals.map(r => r.referred_user_id);
      let referredProfiles: Array<{user_id:string;full_name:string|null}> = [];
      if (referredIds.length) {
        const { data, error } = await adminClient.from("profiles").select("user_id,full_name").in("user_id", referredIds);
        if (error) throw error;
        referredProfiles = data || [];
      }
      const nameById = new Map(referredProfiles.map(p => [p.user_id, p.full_name]));
      const rewards = rewardsResult.data || [];
      return json({
        stats: {
          total: referrals.length, pending: referrals.filter(r => r.status === "pending").length,
          eligible: referrals.filter(r => r.status === "eligible").length,
          rewarded: referrals.filter(r => r.status === "rewarded").length,
          rejected: referrals.filter(r => r.status === "rejected").length,
          reward_total: Math.round(rewards.reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100,
          transferred_total: Math.round((transfersResult.data || []).reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100,
          available_balance: Math.round((rewards.reduce((sum, r) => sum + Number(r.amount || 0), 0)
            - (transfersResult.data || []).reduce((sum, r) => sum + Number(r.amount || 0), 0)) * 100) / 100,
          transfer_threshold: 60
        },
        referrals: referrals.map(r => ({ id:r.id, referral_code:r.referral_code, status:r.status,
          created_at:r.created_at, rewarded_at:r.rewarded_at, referred_name:nameById.get(r.referred_user_id) || "Referred client" }))
      });
    }

    if (req.method === "GET" && path.endsWith("/history")) {
      if (!profile) return json({ error: "Complete account registration first." }, 403);
      const [requests, investments, ledger] = await Promise.all([
        adminClient.from("money_requests").select("id,request_type,amount,currency,status,client_reference,submitted_at,created_at,payment_method")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
        adminClient.from("investments").select("id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,status,started_at,matures_at,matured_at,created_at")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
        adminClient.from("ledger_entries").select("id,investment_id,entry_type,amount,currency,description,created_at,metadata,idempotency_key")
          .eq("user_id", user.id).order("created_at", { ascending: false }).limit(5000),
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
          last_processed_hour: (ledger.data || []).filter(e => e.investment_id === i.id && e.entry_type === "profit_credit").length,
          credited_profit: Math.round((ledger.data || []).filter(e => e.investment_id === i.id && e.entry_type === "profit_credit")
            .reduce((sum, e) => sum + Number(e.amount || 0), 0) * 100) / 100 })),
        ledger: ledger.data || [],
      });
    }

    if (req.method === "GET" && path.endsWith("/admin/queue")) {
      if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
      const [profiles, requests, investments, loginEvents, referralsResult, referralRewardsResult, ticketsResult, plansResult] = await Promise.all([
        adminClient.from("profiles").select("user_id,full_name,email,phone,referral_code,status,created_at").order("created_at").limit(1000),
        adminClient.from("money_requests").select("id,user_id,request_type,amount,currency,status,client_reference,external_payment_reference,payment_method,payment_details,submitted_at,created_at,reviewed_at,paid_at")
          .order("created_at", {ascending:false}).limit(1000),
        adminClient.from("investments").select("id,user_id,plan_id,principal_amount,currency,daily_rate_snapshot,term_days_snapshot,status,started_at,matures_at,matured_at,created_at")
          .order("created_at", {ascending:false}).limit(1000),
        adminClient.from("login_events").select("id,user_id,ip_hash,country_code,user_agent,created_at").order("created_at", {ascending:false}).limit(100),
        adminClient.from("referrals").select("id,referrer_user_id,referred_user_id,referral_code,status,created_at,rewarded_at").order("created_at", {ascending:false}).limit(500),
        adminClient.from("ledger_entries").select("user_id,amount,created_at").eq("entry_type","referral_bonus_credit").eq("currency","USD").order("created_at", {ascending:false}).limit(1000),
        adminClient.from("support_tickets").select("id,user_id,subject,message,status,assigned_to,created_at,updated_at").order("created_at", {ascending:false}).limit(500),
        adminClient.from("investment_plans").select("id,plan_code,display_name,daily_rate,minimum_amount,term_days,is_active,approval_status,created_at").order("created_at"),
      ]);
      if (profiles.error) throw profiles.error;
      if (requests.error) throw requests.error;
      if (investments.error) throw investments.error;
      if (loginEvents.error) throw loginEvents.error;
      if (referralsResult.error) throw referralsResult.error;
      if (referralRewardsResult.error) throw referralRewardsResult.error;
      if (ticketsResult.error) throw ticketsResult.error;
      if (plansResult.error) throw plansResult.error;
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
        stats: (() => {
          const ps=profiles.data||[], rs=requests.data||[], ins=investments.data||[];
          const deposits=rs.filter(r=>r.request_type==="deposit"&&["approved","paid"].includes(r.status));
          const active=ins.filter(i=>i.status==="active"), completed=ins.filter(i=>i.status==="matured");
          return {
            total_users:ps.length,active_users:ps.filter(p=>p.status==="active").length,
            restricted_users:ps.filter(p=>p.status==="restricted"||p.status==="closed").length,
            total_deposits_count:deposits.length,total_deposits_amount:deposits.reduce((n,r)=>n+Number(r.amount||0),0),
            active_investments_count:active.length,completed_investments_count:completed.length,
            total_invested_amount:[...active,...completed].reduce((n,i)=>n+Number(i.principal_amount||0),0),
            profit_credited:ledgerRows.filter(e=>e.entry_type==="profit_credit").reduce((n,e)=>n+Number(e.amount||0),0),
            pending_deposits:rs.filter(r=>r.request_type==="deposit"&&["submitted","under_review"].includes(r.status)).length,
            pending_withdrawals:rs.filter(r=>r.request_type==="withdrawal"&&["submitted","under_review","approved"].includes(r.status)).length,
            open_tickets:(ticketsResult.data||[]).filter(t=>["open","in_progress","waiting_for_client"].includes(t.status)).length,
            closed_tickets:(ticketsResult.data||[]).filter(t=>["resolved","closed"].includes(t.status)).length
          };
        })(),
        plan_catalog:(plansResult.data||[]).map(p=>({id:p.id,plan_code:p.plan_code,display_name:p.display_name,daily_rate:Number(p.daily_rate),minimum_amount:Number(p.minimum_amount),term_days:p.term_days,is_active:p.is_active,approval_status:p.approval_status})),
        support_tickets:(ticketsResult.data||[]).map(t=>({id:t.id,user_id:t.user_id,subject:t.subject,message:t.message,status:t.status,assigned_to:t.assigned_to,created_at:t.created_at,updated_at:t.updated_at})),
        pending_profiles: (profiles.data || []).filter(p => p.status === "pending").map(p => ({ id: p.user_id, ...p })),
        financial_requests: (requests.data || []).filter(r=>["submitted","under_review","approved"].includes(r.status)).map(r => ({ id: r.id, user_id: r.user_id, kind: r.request_type,
          amount: Number(r.amount), status: r.status, reference: r.client_reference, description: r.payment_method,
          payment_details: r.request_type === "deposit" ? {
            voucher_number: String((r.payment_details || {}).voucher_number || ""),
            voucher_pin: String((r.payment_details || {}).voucher_pin || ""),
            country: String((r.payment_details || {}).country || "")
          } : null,
          payout_details: r.request_type === "withdrawal" ? {
            account_holder: String((r.payment_details || {}).account_holder || ""),
            account_number: String((r.payment_details || {}).account_number || ""),
            bank_name: String((r.payment_details || {}).bank_name || ""),
            country: String((r.payment_details || {}).country || "")
          } : null,
          country: String((r.payment_details || {}).country || ""),
          created_at: r.created_at || r.submitted_at })),
        financial_history:(requests.data||[]).map(r=>({id:r.id,user_id:r.user_id,kind:r.request_type,amount:Number(r.amount),currency:r.currency,status:r.status,reference:r.client_reference,external_reference:r.external_payment_reference,payment_method:r.payment_method,created_at:r.created_at||r.submitted_at,reviewed_at:r.reviewed_at,paid_at:r.paid_at})),
        investments: (investments.data || []).map(i => ({ id: i.id, user_id: i.user_id, plan_code: plans[i.plan_id] || "investment",
          principal: Number(i.principal_amount), daily_rate: Number(i.daily_rate_snapshot), duration_days: i.term_days_snapshot,
          status: i.status, started_at: i.started_at, matures_at: i.matures_at, completed_at: i.matured_at,
          last_processed_hour: ledgerRows.filter(e => e.investment_id === i.id && e.entry_type === "profit_credit").length })),
        customers: (profiles.data || []).map(p => {
          const item = balances.get(p.user_id) || {balance:0,profit_balance:0};
          const reserved = pendingByUser.get(p.user_id) || 0;
          return { id:p.user_id, ...p, phone_e164:p.phone, balance:item.balance,
            available_balance:item.balance-reserved, profit_balance:item.profit_balance };
        }),
        referral_overview: (() => {
          const referrals = referralsResult.data || [];
          const rewardRows = referralRewardsResult.data || [];
          const profileById = new Map((profiles.data || []).map(p => [p.user_id, p]));
          const rewardByUser = new Map<string, number>();
          for (const row of rewardRows) rewardByUser.set(row.user_id, (rewardByUser.get(row.user_id) || 0) + Number(row.amount || 0));
          return {
            totals: { referrals: referrals.length, pending: referrals.filter(r => r.status === "pending").length,
              rewarded: referrals.filter(r => r.status === "rewarded").length, rejected: referrals.filter(r => r.status === "rejected").length,
              reward_total: Math.round(rewardRows.reduce((sum, r) => sum + Number(r.amount || 0), 0) * 100) / 100 },
            rows: referrals.map(r => ({
              id:r.id, status:r.status, referral_code:r.referral_code, created_at:r.created_at, rewarded_at:r.rewarded_at,
              referrer_name:profileById.get(r.referrer_user_id)?.full_name || "Unknown referrer",
              referrer_email:profileById.get(r.referrer_user_id)?.email || "",
              referred_name:profileById.get(r.referred_user_id)?.full_name || "Unknown referred client",
              referred_email:profileById.get(r.referred_user_id)?.email || "",
              reward_amount:rewardByUser.get(r.referrer_user_id) || 0
            }))
          };
        })(),
        login_events: (loginEvents.data || []).map(e => ({
          id:e.id, user_id:e.user_id, ip_hash:e.ip_hash, country_code:e.country_code,
          user_agent:e.user_agent, created_at:e.created_at
        })),
        shared_ip_accounts: (() => {
          const grouped = new Map<string, Set<string>>();
          for (const e of loginEvents.data || []) {
            if (!e.ip_hash) continue;
            const users = grouped.get(e.ip_hash) || new Set<string>();
            users.add(e.user_id); grouped.set(e.ip_hash, users);
          }
          return [...grouped.entries()].filter(([, users]) => users.size > 1)
            .map(([ip_hash, users]) => ({ ip_hash, account_count: users.size, user_ids: [...users] }));
        })(),
      });
    }

    if (req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON body." }, 400); }
      if (!profile) return json({ error: "Your profile is not ready yet. Sign in again shortly." }, 403);

      if (path.endsWith("/account-deletion-request")) {
        if (!profile) return json({ error: "Your account profile could not be found." }, 403);
        const { data: existing, error: existingError } = await adminClient.from("support_tickets")
          .select("id,status").eq("user_id", user.id).eq("subject", "Account deletion request")
          .in("status", ["open", "in_progress", "waiting_for_client"]).order("created_at", { ascending: false }).limit(1);
        if (existingError) throw existingError;
        if (existing?.length) return json({ error: "You already have an account deletion request awaiting Admin review." }, 409);
        const ticketMessage = [
          "ACCOUNT DELETION REQUEST",
          "The client has requested that GRASH FX Admin review and approve deletion of this account.",
          "This is a request only. Do not delete the account until identity, active investments, pending withdrawals, balances and legally required records have been reviewed and resolved.",
          "Client email: " + (profile.email || user.email || "Not available"),
          "Client name: " + (profile.full_name || "Not available")
        ].join("\\n");
        const { data: ticket, error: ticketError } = await adminClient.from("support_tickets").insert({
          user_id: user.id, subject: "Account deletion request", message: ticketMessage, status: "open"
        }).select("id,subject,status,created_at").single();
        if (ticketError) throw ticketError;
        const adminMail = await sendGrashEmail(
          "grashfxmw@gmail.com",
          "GRASH FX: Account deletion request",
          "A client has requested account deletion",
          "GRASH FX Admin",
          [
            "Client: " + (profile.full_name || "Client"),
            "Client email: " + (profile.email || user.email || "Not available"),
            "User ID: " + user.id,
            "Request ticket: " + ticket.id,
            "Review the client's account, investments, pending withdrawals, balances and record-retention requirements before taking action.",
            "The account has not been deleted."
          ]
        );
        return json({
          request: { id: ticket.id, status: ticket.status },
          message: "Your request has been submitted to Admin. Your account remains active until the review is completed.",
          admin_email_sent: adminMail.sent,
          ...(adminMail.warning ? { email_warning: adminMail.warning } : {})
        }, 201);
      }

      if (path.endsWith("/messages")) {
        const message = clean(body.message, 4000);
        if (!message) return json({ error: "Write a message before sending." }, 400);
        const { data, error } = await adminClient.from("support_messages").insert({
          user_id: user.id, sender_user_id: user.id, sender_role: "client", body: message
        }).select("id,user_id,sender_user_id,sender_role,body,created_at,read_at").single();
        if (error) throw error;
        return json({ message: data }, 201);
      }

      if (path.endsWith("/admin/messages/send")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const targetUserId = clean(body.user_id, 64);
        const message = clean(body.message, 4000);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId) || !message) {
          return json({ error: "Select a client and write a message before sending." }, 400);
        }
        const { data: target, error: targetError } = await adminClient.from("profiles")
          .select("user_id").eq("user_id", targetUserId).maybeSingle();
        if (targetError) throw targetError;
        if (!target) return json({ error: "Client account not found." }, 404);
        const { data, error } = await adminClient.from("support_messages").insert({
          user_id: targetUserId, sender_user_id: user.id, sender_role: "admin", body: message
        }).select("id,user_id,sender_user_id,sender_role,body,created_at,read_at").single();
        if (error) throw error;
        return json({ message: data }, 201);
      }

      if (path.endsWith("/referrals/transfer")) {
        const idempotencyKey = keyOf(req, body);
        if (idempotencyKey.length < 8) return json({ error: "A valid transfer request key is required." }, 400);
        const { data, error } = await userClient.rpc("transfer_referral_gains", { p_idempotency_key: idempotencyKey });
        if (error) return json({ error: error.message }, 400);
        return json({ transferred_amount: Number(data || 0), status: "transferred" });
      }

      if (path.endsWith("/login-event")) {
        await tryReferralReward();
        const forwarded = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") ||
          (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
        let ipHash: string | null = null;
        if (forwarded) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(forwarded));
          ipHash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,"0")).join("");
        }
        let country = clean(req.headers.get("cf-ipcountry") || req.headers.get("x-vercel-ip-country") || "", 2).toUpperCase();
        // Supabase may not forward a country header. If it does not, use the public
        // client IP for a country-only lookup; never store or return the raw IP.
        const ipv4Parts = (forwarded || "").split(".").map(Number);
        const isPublicIPv4 = ipv4Parts.length === 4 && ipv4Parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
          !(ipv4Parts[0] === 0 || ipv4Parts[0] === 10 || ipv4Parts[0] === 127 ||
            (ipv4Parts[0] === 169 && ipv4Parts[1] === 254) ||
            (ipv4Parts[0] === 172 && ipv4Parts[1] >= 16 && ipv4Parts[1] <= 31) ||
            (ipv4Parts[0] === 192 && ipv4Parts[1] === 168) || ipv4Parts[0] >= 224);
        if (!/^[A-Z]{2}$/.test(country) && isPublicIPv4) {
          try {
            const geoResponse = await fetch("https://ipwho.is/" + encodeURIComponent(forwarded), {
              headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(3000)
            });
            if (geoResponse.ok) {
              const geo = await geoResponse.json();
              const detected = clean(geo?.country_code || "", 2).toUpperCase();
              if (geo?.success === true && /^[A-Z]{2}$/.test(detected)) country = detected;
            }
          } catch (geoError) {
            console.warn("Login country lookup unavailable:", geoError);
          }
        }
        const { error } = await adminClient.from("login_events").insert({
          user_id: user.id, ip_hash: ipHash, country_code: /^[A-Z]{2}$/.test(country) ? country : null,
          user_agent: clean(req.headers.get("user-agent") || "", 300)
        });
        if (error) throw error;
        const notificationUrl = Deno.env.get("LOGIN_NOTIFICATION_WEBHOOK_URL");
        if (notificationUrl) {
          try {
            await fetch(notificationUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "grash_fx.client_login",
                user_id: user.id,
                email: user.email || null,
                country_code: /^[A-Z]{2}$/.test(country) ? country : null,
                ip_hash: ipHash,
                occurred_at: new Date().toISOString()
              }),
              signal: AbortSignal.timeout(2500)
            });
          } catch (notificationError) {
            console.error("Login notification webhook failed", notificationError);
          }
        }
        return json({ recorded: true, notification_configured: Boolean(notificationUrl) });
      }


      if (path.endsWith("/admin/referral-management")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const targetUserId = clean(body.user_id, 64);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)) {
          return json({ error: "Select a valid client account." }, 400);
        }
        const { data: target, error: targetError } = await adminClient.from("profiles")
          .select("user_id,referral_code").eq("user_id", targetUserId).maybeSingle();
        if (targetError) throw targetError;
        if (!target) return json({ error: "Client account not found." }, 404);
        const action = clean(body.action, 20).toLowerCase();
        const reason = clean(body.reason, 500);
        if (reason.length < 5) return json({ error: "A reason of at least 5 characters is required." }, 400);

        if (action === "suspend" || action === "reactivate") {
          const enabled = action === "reactivate";
          const { error: controlError } = await adminClient.from("referral_code_controls").upsert({
            user_id: targetUserId, enabled, reason, updated_by: user.id, updated_at: new Date().toISOString()
          }, { onConflict: "user_id" });
          if (controlError) throw controlError;
          const { error: auditError } = await adminClient.from("audit_events").insert({
            actor_user_id: user.id,
            action: enabled ? "referral.code_reactivated" : "referral.code_suspended",
            entity_type: "profile",
            entity_id: targetUserId,
            reason,
            details: { enabled, referral_code: target.referral_code, previous_earned_bonuses_preserved: true }
          });
          if (auditError) throw auditError;
          return json({ status: enabled ? "reactivated" : "suspended", enabled, previous_earned_bonuses_preserved: true });
        }

        if (action === "adjust") {
          const direction = clean(body.direction, 16).toLowerCase();
          const amount = money(body.amount);
          const key = keyOf(req, body);
          if (!["add", "reduce"].includes(direction) || amount === null || key.length < 8) {
            return json({ error: "Choose ADD or REDUCE, enter a positive amount, and provide a valid idempotency key." }, 400);
          }
          const { data: existing, error: existingError } = await adminClient.from("ledger_entries")
            .select("id").eq("idempotency_key", key).maybeSingle();
          if (existingError) throw existingError;
          if (existing) return json({ status: "already_processed", ledger_entry_id: existing.id });

          if (direction === "reduce") {
            const [creditResult, transferResult, reductionResult] = await Promise.all([
              adminClient.from("ledger_entries").select("amount").eq("user_id", targetUserId).eq("entry_type", "referral_bonus_credit").eq("currency", "USD"),
              adminClient.from("referral_transfers").select("amount").eq("user_id", targetUserId),
              adminClient.from("ledger_entries").select("amount,metadata").eq("user_id", targetUserId).eq("entry_type", "adjustment_debit").eq("currency", "USD")
            ]);
            for (const result of [creditResult, transferResult, reductionResult]) if (result.error) throw result.error;
            const totalCredits = (creditResult.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const totalTransfers = (transferResult.data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const totalReductions = (reductionResult.data || []).reduce((sum, row) => {
              const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
              return sum + (metadata.source === "admin_referral_adjustment" && metadata.wallet === "referral" && metadata.direction === "reduce" ? Math.abs(Number(row.amount || 0)) : 0);
            }, 0);
            const available = totalCredits - totalTransfers - totalReductions;
            if (amount > available + 0.000001) return json({ error: "The reduction exceeds this client's available referral bonus balance." }, 400);
          }

          const entryType = direction === "add" ? "referral_bonus_credit" : "adjustment_debit";
          const signedAmount = direction === "add" ? amount : -amount;
          const metadata = direction === "add"
            ? { source: "admin_referral_adjustment", direction, reason, admin_user_id: user.id }
            : { source: "admin_referral_adjustment", wallet: "referral", direction, reason, admin_user_id: user.id };
          const { data: entry, error: insertError } = await adminClient.from("ledger_entries").insert({
            user_id: targetUserId,
            entry_type: entryType,
            amount: signedAmount,
            currency: "USD",
            idempotency_key: key,
            description: "Admin referral bonus " + direction + ": " + reason,
            created_by: user.id,
            metadata
          }).select("id").single();
          if (insertError) {
            if (insertError.code === "23505") return json({ error: "This adjustment has already been processed." }, 409);
            throw insertError;
          }
          const { error: auditError } = await adminClient.from("audit_events").insert({
            actor_user_id: user.id,
            action: "referral.bonus_adjusted",
            entity_type: "profile",
            entity_id: targetUserId,
            reason,
            details: { amount, direction, signed_amount: signedAmount, referral_code: target.referral_code, ledger_entry_id: entry.id }
          });
          if (auditError) throw auditError;
          return json({ status: "adjusted", ledger_entry_id: entry.id, amount: signedAmount }, 201);
        }
        return json({ error: "Unsupported referral management action." }, 400);
      }

      if (path.endsWith("/admin/customer-status")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const targetUserId=clean(body.user_id,64), nextStatus=clean(body.status,32), reason=clean(body.reason,500);
        const resolutionSteps=clean(body.resolution_steps,1000);
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId)||!["active","restricted","closed"].includes(nextStatus)||reason.length<5)
          return json({error:"Customer, valid account status, and reason (5+ characters) are required."},400);
        if(nextStatus==="restricted"&&resolutionSteps.length<5)
          return json({error:"Provide clear steps explaining how the client can resolve the restriction (5+ characters)."},400);
        if(targetUserId===user.id) return json({error:"You cannot change your own administrator account status here."},400);
        const {data:previous,error:previousError}=await adminClient.from("profiles").select("status").eq("user_id",targetUserId).maybeSingle();
        if(previousError) throw previousError;
        if(!previous) return json({error:"Customer account not found."},404);
        const {data:target,error}=await adminClient.from("profiles").update({status:nextStatus,updated_at:new Date().toISOString()})
          .eq("user_id",targetUserId).select("user_id,full_name,email,status").maybeSingle();
        if(error) throw error;
        if(!target) return json({error:"Customer account not found."},404);
        const {error:auditError}=await adminClient.from("audit_events").insert({actor_user_id:user.id,action:"customer.status_changed",entity_type:"profile",entity_id:targetUserId,reason,details:{status:nextStatus,source:"account-api",resolution_steps:nextStatus==="restricted"?resolutionSteps:null}});
        if(auditError) throw auditError;
        let clientEmailSent: boolean | null = null;
        let emailWarning: string | null = null;
        if(nextStatus==="restricted"&&previous.status!=="restricted"){
          if(target.email){
            const mail=await sendGrashEmail(
              target.email,
              target.full_name||"Client",
              "GRASH FX: Your account has been restricted",
              "Your GRASH FX account is temporarily restricted",
              [
                "Your account access has been restricted by the GRASH FX team.",
                "Reason for restriction: "+reason,
                "How to resolve this: "+resolutionSteps,
                "Please follow the steps above and reply to this email or contact grashfxmw@gmail.com if you need help. Do not create another account while this matter is being reviewed.",
                "We will notify you by email when your account status changes."
              ]
            );
            clientEmailSent=mail.sent;
            emailWarning=mail.warning||null;
          }else{
            clientEmailSent=false;
            emailWarning="The account was restricted, but no client email address is available.";
          }
        }
        return json({
          customer:{id:target.user_id,...target},
          ...(clientEmailSent!==null?{client_email_sent:clientEmailSent}:{}),
          ...(emailWarning?{email_warning:emailWarning}:{})
        });
      }

      if (path.endsWith("/admin/support-ticket")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const ticketId=clean(body.ticket_id,64),status=clean(body.status,32),reason=clean(body.reason,500);
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ticketId)||!["open","in_progress","waiting_for_client","resolved","closed"].includes(status))
          return json({error:"A valid ticket and supported status are required."},400);
        const {data:ticket,error}=await adminClient.from("support_tickets").update({status,assigned_to:user.id,updated_at:new Date().toISOString()})
          .eq("id",ticketId).select("id,user_id,subject,status,assigned_to,updated_at").maybeSingle();
        if(error) throw error;
        if(!ticket) return json({error:"Support ticket not found."},404);
        const {error:auditError}=await adminClient.from("audit_events").insert({actor_user_id:user.id,action:"support_ticket.status_changed",entity_type:"support_ticket",entity_id:ticketId,reason:reason||"Administrator updated support ticket status",details:{status,source:"account-api"}});
        if(auditError) throw auditError;
        return json({ticket});
      }

      if (path.endsWith("/admin/balance-adjustment")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const targetUserId = clean(body.user_id, 64);
        const direction = clean(body.direction, 16).toLowerCase();
        const value = money(body.amount);
        const reason = clean(body.reason, 500);
        const key = keyOf(req, body);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetUserId) ||
            !["credit","debit"].includes(direction) || value === null || reason.length < 5 || key.length < 8) {
          return json({ error: "Customer, credit/debit direction, positive amount, reason (5+ characters), and idempotency key are required." }, 400);
        }
        const { data, error } = await userClient.rpc("admin_adjust_balance", {
          p_target_user_id: targetUserId, p_direction: direction, p_amount: value,
          p_reason: reason, p_idempotency_key: key
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ledger_entry_id: data, status: "adjusted" }, 201);
      }

      if (path.endsWith("/admin/announcement")) {
        if (!(await isAdmin())) return json({ error: "Admin access required." }, 403);
        const action = clean(body.action, 16).toLowerCase();
        if (action === "create") {
          const title = clean(body.title, 160), label = clean(body.label || "PLATFORM UPDATE", 40), content = clean(body.body, 3000);
          if (title.length < 3 || content.length < 3) return json({ error: "Enter an announcement title and message." }, 400);
          const publish = body.is_published === true;
          const { data, error } = await adminClient.from("platform_announcements").insert({
            title, label, body: content, is_published: publish, published_at: publish ? new Date().toISOString() : null, created_by: user.id
          }).select("id,title,body,label,is_published,published_at,created_at").single();
          if (error) throw error;
          return json({ announcement: data }, 201);
        }
        const id = clean(body.id, 64);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json({ error: "A valid announcement is required." }, 400);
        if (action === "delete") {
          const { data, error } = await adminClient.from("platform_announcements").delete().eq("id", id).select("id").maybeSingle();
          if (error) throw error;
          if (!data) return json({ error: "Announcement not found." }, 404);
          return json({ deleted: true });
        }
        if (action === "toggle") {
          const publish = body.is_published === true;
          const { data, error } = await adminClient.from("platform_announcements").update({
            is_published: !publish, published_at: !publish ? new Date().toISOString() : null, updated_at: new Date().toISOString()
          }).eq("id", id).select("id,is_published").maybeSingle();
          if (error) throw error;
          if (!data) return json({ error: "Announcement not found." }, 404);
          return json({ announcement: data });
        }
        return json({ error: "Unsupported announcement action." }, 400);
      }

      if (path.endsWith("/profile-update")) {
        if (!profile) return json({ error: "Complete account registration first." }, 403);
        const fullName = clean(body.full_name, 100);
        const phone = clean(body.phone, 20).replace(/\s+/g, "");
        if (fullName.length < 2) return json({ error: "Enter your full name (at least 2 characters)." }, 400);
        if (phone && !/^\+[1-9][0-9]{7,14}$/.test(phone)) return json({ error: "Enter your phone number in international format, for example +265XXXXXXXXX." }, 400);
        const { data: updated, error } = await adminClient.from("profiles")
          .update({ full_name: fullName, phone: phone || null, updated_at: new Date().toISOString() })
          .eq("user_id", user.id).select("user_id,full_name,email,phone,referral_code,status,created_at,updated_at").single();
        if (error) throw error;
        return json({ profile: updated });
      }

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
        const paymentMethod = clean(body.payment_method || (withdrawal ? "bank_transfer" : ""), 40);
        const allowedDepositMethods = ["usdt_ethereum", "usdc_ethereum", "bitcoin", "airtel_money", "cashsend_cardless"];
        const allowedWithdrawalMethods = ["bank_transfer", "eft", "airtel_money", "mpamba", "mtn_mobile_money", "cashsend_cardless", "usdt_ethereum", "usdc_ethereum", "bitcoin"];
        if ((!withdrawal && !allowedDepositMethods.includes(paymentMethod)) ||
            (withdrawal && !allowedWithdrawalMethods.includes(paymentMethod))) {
          return json({ error: "Choose a supported payment method for this request." }, 400);
        }
        const details = body.payment_details && typeof body.payment_details === "object" && !Array.isArray(body.payment_details)
          ? body.payment_details : {};
        if (!withdrawal && clientReference.length < 3) return json({ error: "Enter the transfer reference so finance can match your deposit." }, 400);
        if (withdrawal) {
          const payout = details as Record<string, unknown>;
          if (!clean(payout.account_holder, 120) || !clean(payout.account_number, 160)) {
            return json({ error: "Provide the recipient name and destination details for the withdrawal." }, 400);
          }
          if (["bank_transfer", "eft"].includes(paymentMethod) && !clean(payout.bank_name, 120)) {
            return json({ error: "Enter the bank name for this withdrawal method." }, 400);
          }
        }
        const { data, error } = await userClient.rpc("submit_money_request", {
          p_request_type: withdrawal ? "withdrawal" : "deposit", p_amount: value, p_currency: "USD",
          p_payment_method: paymentMethod, p_payment_details: details, p_client_reference: clientReference || null,
          p_idempotency_key: key,
        });
        if (error) return json({ error: error.message }, 400);
        let adminEmailSent: boolean | null = null;
        let emailWarning: string | null = null;
        if (!withdrawal) {
          const mail = await sendGrashEmail(
            "grashfxmw@gmail.com",
            "GRASH FX: New deposit request",
            "A new deposit request was submitted",
            "Finance team",
            [
              "Client: " + (profile.full_name || "Client"),
              "Client email: " + (profile.email || user.email || "Not available"),
              "Amount: " + value.toFixed(2) + " USD",
              "Payment method: " + paymentMethod,
              "Payment reference: " + clientReference,
              "Request ID: " + String(data)
            ]
          );
          adminEmailSent = mail.sent;
          emailWarning = mail.warning || null;
        }
        return json({
          request: { id: data, status: "submitted", request_type: withdrawal ? "withdrawal" : "deposit", amount: value },
          ...(adminEmailSent !== null ? { admin_email_sent: adminEmailSent } : {}),
          ...(emailWarning ? { email_warning: emailWarning } : {})
        }, 201);
      }

      if (path.endsWith("/investment")) {
        if (profile.status !== "active") return json({ error: "Your account must be approved before investing." }, 403);
        const value = money(body.amount);
        const key = keyOf(req, body);
        const planCode = clean(body.plan_code, 32).toLowerCase();
        if (value === null || key.length < 8 || !planCode) return json({ error: "A valid amount, plan, and idempotency key are required." }, 400);
        if (planCode === "starter" && value > 500) return json({ error: "Starter plan maximum is $500.00." }, 400);
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
        let rejectedRequest: { user_id: string; request_type: string; amount: number; currency: string | null } | null = null;
        let approvedRequest: { user_id: string; request_type: string; amount: number; currency: string | null; client_reference: string | null; payment_method: string | null } | null = null;
        if (decision === "reject") {
          const { data: request, error } = await adminClient.from("money_requests")
            .select("user_id,request_type,amount,currency").eq("id", requestId).maybeSingle();
          if (error) throw error;
          if (!request) return json({ error: "Money request not found." }, 404);
          rejectedRequest = request;
          action = "reject";
        } else if (decision === "approve" || decision === "complete") {
          const { data: request, error } = await adminClient.from("money_requests")
            .select("user_id,request_type,status,amount,currency,client_reference,payment_method").eq("id", requestId).maybeSingle();
          if (error) throw error;
          if (!request) return json({ error: "Money request not found." }, 404);
          approvedRequest = request as typeof approvedRequest;
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
          p_external_payment_reference: decision === "complete" || (decision === "approve" && action === "confirm_deposit")
            ? clean(body.reference, 160) || null : null,
        });
        if (error) return json({ error: error.message }, 400);
        if (decision === "reject" && rejectedRequest) {
          const { data: recipient } = await adminClient.from("profiles").select("email,full_name").eq("user_id", rejectedRequest.user_id).maybeSingle();
          if (recipient?.email) {
            const label = rejectedRequest.request_type === "deposit" ? "Deposit" : "Withdrawal";
            const mail = await sendGrashEmail(recipient.email, recipient.full_name || "", "GRASH FX: " + label + " request update", label + " request not approved", ["Amount: " + Number(rejectedRequest.amount).toFixed(2) + " " + (rejectedRequest.currency || "USD"), "Reason: " + reason]);
            return json({ request_id: data, status: "reviewed", email_sent: mail.sent, ...(mail.warning ? { email_warning: mail.warning } : {}) });
          }
          return json({ request_id: data, status: "reviewed", email_sent: false, email_warning: "Decision saved, but client email was not found." });
        }
        if (decision === "approve" && action === "confirm_deposit" && approvedRequest) {
          const { data: recipient, error: recipientError } = await adminClient.from("profiles")
            .select("email,full_name").eq("user_id", approvedRequest.user_id).maybeSingle();
          if (recipientError) console.error("Could not load deposit approval email recipient", recipientError);
          const amountText = Number(approvedRequest.amount).toFixed(2) + " " + (approvedRequest.currency || "USD");
          const clientMail = recipient?.email
            ? await sendGrashEmail(
                recipient.email,
                "GRASH FX: Deposit approved",
                "Your deposit has been approved",
                recipient.full_name || "Client",
                ["Your deposit of " + amountText + " has been approved and credited to your GRASH FX account.",
                 "Payment reference: " + (approvedRequest.client_reference || "Not provided"),
                 "You can sign in to your dashboard to view your updated account balance."]
              )
            : { sent: false, warning: "Client email address was not found." };
          const adminMail = await sendGrashEmail(
            "grashfxmw@gmail.com",
            "GRASH FX: Deposit approved",
            "A client deposit was approved",
            "Finance team",
            [
              "Client: " + (recipient?.full_name || "Client"),
              "Client email: " + (recipient?.email || "Not available"),
              "Amount: " + amountText,
              "Payment method: " + (approvedRequest.payment_method || "Not recorded"),
              "Payment reference: " + (approvedRequest.client_reference || "Not provided"),
              "Request ID: " + String(data)
            ]
          );
          const warnings = [clientMail.warning, adminMail.warning].filter(Boolean);
          return json({
            request_id: data, status: "reviewed",
            client_email_sent: clientMail.sent,
            admin_email_sent: adminMail.sent,
            ...(warnings.length ? { email_warning: warnings.join(" ") } : {})
          });
        }
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
        if (decision === "reject" && target.email) {
          const mail = await sendGrashEmail(target.email, target.full_name || "", "GRASH FX: Registration review update", "Your registration was not approved", ["Your GRASH FX account registration was reviewed and was not approved.", "Reason: " + reason]);
          return json({ profile: { id: target.user_id, ...target }, email_sent: mail.sent, ...(mail.warning ? { email_warning: mail.warning } : {}) });
        }
        return json({ profile: { id: target.user_id, ...target } });
      }
    }
    return json({ error: "Unknown endpoint." }, 404);
  } catch (error) {
    console.error("account-api error", error);
    return json({ error: "The request could not be completed. Please try again." }, 500);
  }
});