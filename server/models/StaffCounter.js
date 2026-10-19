const mongoose = require('mongoose');
/** Atomic counters (ticket numbers). */
const staffCounterSchema = new mongoose.Schema({ _id: { type: String }, seq: { type: Number, default: 0 } });
module.exports = mongoose.model('StaffCounter', staffCounterSchema);
