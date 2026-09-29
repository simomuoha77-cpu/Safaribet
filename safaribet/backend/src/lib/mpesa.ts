/**
 * Safaricom Daraja API adapter (M-Pesa).
 *
 * This follows Safaricom's publicly documented Daraja API v2 endpoints and
 * request/response shapes (developer.safaricom.co.ke), which are stable and
 * public — unlike Spribe's, this spec doesn't require a private partner
 * agreement to read. Sandbox credentials are free to obtain by creating an
 * app at https://developer.safaricom.co.ke.
 *
 * Still confirm before going live:
 * - Sandbox vs production base URL switch (sandbox.safaricom.co.ke vs api.safaricom.co.ke)
 * - Your exact shortcode/passkey from Safaricom once you have a production app
 * - B2C (withdrawal) requires a separate application + additional approval from Safaricom,
 *   distinct from the STK Push (C2B/deposit) application
 */
import { z } from "zod";

const MPESA_ENV = process.env.MPESA_ENV === "production" ? "production" : "sandbox";
const BASE_URL =
  MPESA_ENV === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || "";
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || "";
const SHORTCODE = process.env.MPESA_SHORTCODE || "";
const PASSKEY = process.env.MPESA_PASSKEY || "";
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL || "";

function assertConfigured() {
  if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY || !CALLBACK_URL) {
    throw new Error(
      "M-Pesa is not configured. Set MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, and MPESA_CALLBACK_URL in .env"
    );
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * OAuth token — Daraja tokens are valid for 3600s. We cache in-memory and
 * refresh a little early to avoid edge-of-expiry failures.
 */
async function getAccessToken(): Promise<string> {
  assertConfigured();

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }

  const credentials = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!res.ok) {
    throw new Error(`M-Pesa auth failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: string };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
  };
  return cachedToken.token;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function stkPassword(ts: string): string {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString("base64");
}

export interface StkPushParams {
  phoneNumber: string; // format 2547XXXXXXXX
  amount: number; // whole KES, no decimals per Daraja spec
  accountReference: string; // shows on the user's M-Pesa prompt, e.g. a deposit ID
  transactionDesc: string;
}

export interface StkPushResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode: string;
  responseDescription: string;
}

/**
 * Initiates an STK Push ("Lipa na M-Pesa Online") — sends a payment prompt
 * to the user's phone. The actual payment result arrives asynchronously via
 * the callback URL, handled in routes/payments.ts, not in this function's
 * return value.
 */
export async function initiateStkPush(params: StkPushParams): Promise<StkPushResult> {
  assertConfigured();
  const token = await getAccessToken();
  const ts = timestamp();

  const body = {
    BusinessShortCode: SHORTCODE,
    Password: stkPassword(ts),
    Timestamp: ts,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(params.amount),
    PartyA: params.phoneNumber,
    PartyB: SHORTCODE,
    PhoneNumber: params.phoneNumber,
    CallBackURL: CALLBACK_URL,
    AccountReference: params.accountReference,
    TransactionDesc: params.transactionDesc,
  };

  const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`STK Push failed: ${JSON.stringify(data)}`);
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription,
  };
}

// ------------------------------------------------------------------
// STK Push callback payload — this is what Safaricom POSTs to CALLBACK_URL
// after the user approves/declines/times out on their phone.
// ------------------------------------------------------------------
export const stkCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string(),
      CheckoutRequestID: z.string(),
      ResultCode: z.number(),
      ResultDesc: z.string(),
      CallbackMetadata: z
        .object({
          Item: z.array(
            z.object({
              Name: z.string(),
              Value: z.union([z.string(), z.number()]).optional(),
            })
          ),
        })
        .optional(),
    }),
  }),
});

export type StkCallbackPayload = z.infer<typeof stkCallbackSchema>;

export function extractCallbackMetadata(payload: StkCallbackPayload) {
  const items = payload.Body.stkCallback.CallbackMetadata?.Item ?? [];
  const get = (name: string) => items.find((i) => i.Name === name)?.Value;
  return {
    amount: get("Amount") as number | undefined,
    mpesaReceiptNumber: get("MpesaReceiptNumber") as string | undefined,
    transactionDate: get("TransactionDate") as number | undefined,
    phoneNumber: get("PhoneNumber") as string | undefined,
  };
}

// ------------------------------------------------------------------
// B2C (withdrawal / payout to customer). Requires a separate Safaricom
// application + approval beyond the basic STK Push sandbox app — the
// initiator credentials and security credential below are NOT the same
// as the STK Push consumer key/secret.
// ------------------------------------------------------------------
const B2C_INITIATOR_NAME = process.env.MPESA_B2C_INITIATOR_NAME || "";
const B2C_SECURITY_CREDENTIAL = process.env.MPESA_B2C_SECURITY_CREDENTIAL || "";
const B2C_RESULT_URL = process.env.MPESA_B2C_RESULT_URL || "";
const B2C_TIMEOUT_URL = process.env.MPESA_B2C_TIMEOUT_URL || "";

export interface B2CPayoutParams {
  phoneNumber: string;
  amount: number;
  remarks: string;
  occasion?: string;
}

export async function initiateB2CPayout(params: B2CPayoutParams) {
  if (!B2C_INITIATOR_NAME || !B2C_SECURITY_CREDENTIAL || !B2C_RESULT_URL || !B2C_TIMEOUT_URL) {
    throw new Error(
      "M-Pesa B2C (withdrawals) is not configured. Set MPESA_B2C_INITIATOR_NAME, MPESA_B2C_SECURITY_CREDENTIAL, MPESA_B2C_RESULT_URL, and MPESA_B2C_TIMEOUT_URL in .env. " +
        "These require a separate B2C application approved by Safaricom, distinct from STK Push."
    );
  }

  const token = await getAccessToken();

  const body = {
    InitiatorName: B2C_INITIATOR_NAME,
    SecurityCredential: B2C_SECURITY_CREDENTIAL,
    CommandID: "BusinessPayment",
    Amount: Math.round(params.amount),
    PartyA: SHORTCODE,
    PartyB: params.phoneNumber,
    Remarks: params.remarks,
    QueueTimeOutURL: B2C_TIMEOUT_URL,
    ResultURL: B2C_RESULT_URL,
    Occasion: params.occasion || "",
  };

  const res = await fetch(`${BASE_URL}/mpesa/b2c/v1/paymentrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`B2C payout failed: ${JSON.stringify(data)}`);
  }
  return data as { ConversationID: string; OriginatorConversationID: string; ResponseDescription: string };
}
