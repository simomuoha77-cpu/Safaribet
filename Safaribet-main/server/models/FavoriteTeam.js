const mongoose = require('mongoose');

const favoriteTeamSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  team:   { type: String, required: true },
  sport:  { type: String, default: 'football' }
}, { timestamps: true });
favoriteTeamSchema.index({ userId: 1, team: 1 }, { unique: true });

module.exports = mongoose.model('FavoriteTeam', favoriteTeamSchema);
