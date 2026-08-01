const mongoose = require('mongoose');

// Holds a registration's data (username, phone, hashed password, referral)
// temporarily while the phone number is being verified via SMS OTP. The real
// User account is only created once verifyOtp succeeds — this avoids ever
// creating a "half-registered" account for a phone number nobody actually
// proved they own.
const pendingRegistrationSchema = new mongoose.Schema({
  username:     { type: String, required: true },
  phone:        { type: String, required: true, index: true },
  passwordHash: { type: String, required: true },
  refCode:      { type: String },
  otpHash:      { type: String, required: true },
  attempts:     { type: Number, default: 0 }, // wrong-code attempts against THIS otp — capped to stop brute force
  expiresAt:    { type: Date, required: true, index: { expires: 0 } } // Mongo TTL index — auto-deletes once expired
}, { timestamps: true });

module.exports = mongoose.model('PendingRegistration', pendingRegistrationSchema);
