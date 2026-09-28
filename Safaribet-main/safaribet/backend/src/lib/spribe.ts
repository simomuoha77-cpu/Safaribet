/**
 * Spribe integration adapter.
 *
 * This file has the correct STRUCTURE for a Spribe aggregator integration
 * (launch URL generation, HMAC signature verification for callbacks) but the
 * exact endpoint paths, field names, and signature algorithm below are
 * placeholders based on the general shape of aggregator APIs like Spribe's —
 * NOT verified against Spribe's actual current API spec, which is only
 * available to you via your Spribe partner account manager / developer
 * portal once your integration agreement is active.
 *
 * Before going live, replace every TODO below using Spribe's real docs.
 * Do not deploy this against real money until that verification is done.
 */
import crypto from "crypto";

const SPRIBE_OPERATOR_KEY = process.env.SPRIBE_OPERATOR_KEY || "";
const SPRIBE_SECRET = process.env.SPRIBE_SECRET || "";
const SPRIBE_LAUNCH_BASE_URL = process.env.SPRIBE_LAUNCH_BASE_URL || ""; // TODO: confirm exact base URL from Spribe docs

export interface LaunchGameParams {
  userId: string;
  gameId: string; // Spribe's internal game identifier, e.g. "aviator"
  currency: string;
  returnUrl: string;
}

/**
 * Builds the URL SafariBet's frontend should open (iframe or redirect) to
 * launch a Spribe game session.
 *
 * TODO: confirm against Spribe docs:
 * - exact query param names (this assumes user_id / game / currency / operator_key / return_url / sign)
 * - whether launch requires a signed JWT instead of raw query params
 * - whether a session token must be pre-registered via a separate REST call before launch
 */
export function buildLaunchUrl(params: LaunchGameParams): string {
  if (!SPRIBE_LAUNCH_BASE_URL || !SPRIBE_OPERATOR_KEY) {
    throw new Error(
      "Spribe is not configured. Set SPRIBE_OPERATOR_KEY, SPRIBE_SECRET, and SPRIBE_LAUNCH_BASE_URL in .env"
    );
  }

  const query = new URLSearchParams({
    user_id: params.userId,
    game: params.gameId,
    currency: params.currency,
    operator_key: SPRIBE_OPERATOR_KEY,
    return_url: params.returnUrl,
  });

  const signature = signPayload(query.toString());
  query.set("sign", signature);

  return `${SPRIBE_LAUNCH_BASE_URL}?${query.toString()}`;
}

/**
 * HMAC-SHA256 signing, the most common scheme aggregators use.
 * TODO: confirm Spribe's actual algorithm (HMAC-SHA256 is a placeholder assumption)
 * and confirm exactly which fields get concatenated/signed and in what order/format.
 */
function signPayload(payload: string): string {
  if (!SPRIBE_SECRET) {
    throw new Error("SPRIBE_SECRET is not set");
  }
  return crypto.createHmac("sha256", SPRIBE_SECRET).update(payload).digest("hex");
}

/**
 * Verifies an inbound webhook signature from Spribe (bet/win/rollback callbacks).
 * TODO: confirm the exact header name Spribe sends the signature in, and the
 * exact body-signing scheme (raw JSON body vs sorted-and-concatenated fields).
 */
export function verifyWebhookSignature(rawBody: string, providedSignature: string): boolean {
  if (!SPRIBE_SECRET || !providedSignature) return false;
  const expected = signPayload(rawBody);
  // Constant-time comparison to avoid timing attacks
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSignature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
