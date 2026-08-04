const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// A stable signing secret is required so tokens survive server restarts —
// if ADMIN_JWT_SECRET isn't set, derive a deterministic fallback from
// ADMIN_PASSWORD (if present) so existing deployments don't break outright,
// but warn loudly since this fallback is weaker than a dedicated secret.
let JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.ADMIN_PASSWORD) {
    JWT_SECRET = crypto.createHash('sha256').update('safaribet-admin-jwt:' + process.env.ADMIN_PASSWORD).digest('hex');
    console.warn('[adminAuth] ADMIN_JWT_SECRET not set — deriving a fallback from ADMIN_PASSWORD. Set ADMIN_JWT_SECRET explicitly for stronger security.');
  } else {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[adminAuth] ADMIN_JWT_SECRET not set — using a random secret for this process only. All admin sessions will be invalidated on every restart until you set ADMIN_JWT_SECRET.');
  }
}

const TOKEN_TTL = '12h';

function issueAdminToken(admin) {
  return jwt.sign({ sub: String(admin._id), username: admin.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Express middleware — verifies a Bearer JWT issued by /api/admin-auth/login.
// This is now the ONLY way into any /admin-prefixed route anywhere in the app;
// the old shared x-admin-secret header check has been fully removed.
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Not authenticated — please log in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload; // { sub, username, iat, exp }
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Session expired or invalid — please log in again.' });
  }
}

module.exports = { requireAdmin, issueAdminToken, JWT_SECRET, TOKEN_TTL };
