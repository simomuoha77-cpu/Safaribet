// Shared helper: verify inbound M-Pesa/Daraja callbacks (STK push results, B2C results,
// B2C timeouts) actually originate from Safaricom's known Daraja callback IP ranges.
// Daraja does not cryptographically sign callback payloads, so IP-source verification
// is the primary defense against forged "payment succeeded" / "withdrawal succeeded"
// callbacks being posted directly to these endpoints by an attacker.

const SAFARICOM_CALLBACK_CIDRS = [
  '196.201.214.0/24', '196.201.213.0/24', '196.201.212.0/24',
  '196.201.211.0/24', '35.90.31.0/24'
];

function ipInCidr(ip, cidr) {
  try {
    const [range, bits] = cidr.split('/');
    const mask = ~(2 ** (32 - Number(bits)) - 1);
    const ipNum = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    const rangeNum = range.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  } catch { return false; }
}

function isFromSafaricom(req) {
  if (process.env.MPESA_ENV !== 'production') return true; // sandbox testing — skip IP check
  if (process.env.MPESA_SKIP_IP_CHECK === 'true') return true; // explicit opt-out if Render's IP forwarding misbehaves
  const raw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ip = raw.replace('::ffff:', '');
  return SAFARICOM_CALLBACK_CIDRS.some(cidr => ipInCidr(ip, cidr));
}

module.exports = { isFromSafaricom };
