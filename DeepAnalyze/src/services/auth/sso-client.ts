// =============================================================================
// DeepAnalyze - SSO Client (Hub /exchange)
// =============================================================================
// 与 Hub 的 /api/v1/auth/sso/exchange 交互：用 Hub 签发的 single-use ticket 换
// 取用户的 access_token + 用户信息。DA 后端调用，附 da_worker_token 自证身份。
// =============================================================================

export interface SsoExchangeResult {
  accessToken: string;
  user: {
    id: string;
    displayName: string | null;
    organizationId: string | null;
  };
}

/**
 * Exchange a Hub-issued SSO ticket for a Hub access_token + user info.
 * DA calls Hub's /api/v1/auth/sso/exchange with the worker_token proving identity.
 *
 * Returns null on any failure (network, auth, malformed response).
 */
export async function exchangeTicketWithHub(ticket: string): Promise<SsoExchangeResult | null> {
  const hubUrl = process.env.DA_HUB_URL;
  const workerToken = process.env.DA_HUB_WORKER_TOKEN;
  if (!hubUrl || !workerToken) {
    console.error("[sso] DA_HUB_URL or DA_HUB_WORKER_TOKEN not configured");
    return null;
  }

  try {
    const res = await fetch(`${hubUrl}/api/v1/auth/sso/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, da_worker_token: workerToken }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.error(`[sso] exchange failed: ${res.status} ${await res.text()}`);
      return null;
    }

    const body = await res.json() as {
      access_token: string;
      user: { id: string; display_name: string | null; organization_id: string | null };
    };

    return {
      accessToken: body.access_token,
      user: {
        id: body.user.id,
        displayName: body.user.display_name,
        organizationId: body.user.organization_id,
      },
    };
  } catch (err) {
    console.error("[sso] exchange error:", err);
    return null;
  }
}
