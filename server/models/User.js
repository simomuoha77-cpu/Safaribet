const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 24 },
  phone:        { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  balance:      { type: Number, default: 0, min: 0 },
  bonus:        { type: Number, default: 0, min: 0 },
  role:         { type: String, enum: ['user','admin'], default: 'user' },
  isActive:     { type: Boolean, default: true },
  loginAttempts:{ type: Number, default: 0 },
  lockUntil:    { type: Date },
  lastLogin:    { type: Date },
  createdAt:    { type: Date, default: Date.now }
}, { timestamps: true });

userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.methods.comparePassword = async function(pwd) {
  return bcrypt.compare(pwd, this.passwordHash);
};

userSchema.methods.incLoginAttempts = async function() {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= 5 && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + 15 * 60 * 1000 }; // 15 min
  }
  return this.updateOne(updates);
};

// Never expose password
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
