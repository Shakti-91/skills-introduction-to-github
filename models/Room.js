const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
  roomId: {
    type: Number,
    required: true,
    unique: true,
    min: 1,
    max: 9999
  },
  createdAt: { type: Date, default: Date.now },
  messages: [messageSchema]
});

module.exports = mongoose.model('Room', roomSchema);
