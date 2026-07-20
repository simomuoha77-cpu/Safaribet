// Flexible auth — reads JWT from Authorization header OR sb_token cookie
// Used for browser navigation (GET requests) where headers can't be set
const jwt  = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  // Try Authorization header first
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  }

  // Fall back to cookie (set by casino page before navigation)
  if (!token && req.cookies?.sb_token) {
    token = req.cookies.sb_token;
  }

  // Fall back to query param as last resort
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-passwordHash -loginAttempts -lockUntil');
    if (!user || !user.isActive) return res.redirect('/login');
    req.user = user;
    next();
  } catch(e) {
    return res.redirect('/login');
  }
};
