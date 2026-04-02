const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const path = require('path');
const rateLimit = require('express-rate-limit');
const Room = require('./models/Room');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// MongoDB connection URL — set the MONGO_URL environment variable or fill in the string below
const MONGO_URL = process.env.MONGO_URL || '';

if (MONGO_URL) {
  mongoose
    .connect(MONGO_URL)
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));
} else {
  console.warn('MongoDB URL not set. Room data will not be persisted.');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for room API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', apiLimiter);

// In-memory room registry: roomId (number) -> Set of WebSocket clients
const rooms = new Map();

// ─── REST endpoints ────────────────────────────────────────────────────────────

// POST /api/rooms — create a new room
app.post('/api/rooms', async (req, res) => {
  const { roomId } = req.body;
  const id = parseInt(roomId, 10);

  if (!Number.isInteger(id) || id < 1 || id > 9999) {
    return res
      .status(400)
      .json({ error: 'Room ID must be a number between 1 and 9999.' });
  }

  if (rooms.has(id)) {
    return res.status(409).json({ error: 'Room already exists.' });
  }

  // Persist to MongoDB if connected
  if (mongoose.connection.readyState === 1) {
    try {
      const existing = await Room.findOne({ roomId: id });
      if (existing) {
        return res.status(409).json({ error: 'Room already exists.' });
      }
      await Room.create({ roomId: id });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to create room.' });
    }
  }

  rooms.set(id, new Set());
  return res.status(201).json({ roomId: id, message: 'Room created.' });
});

// GET /api/rooms/:roomId — check if a room exists
app.get('/api/rooms/:roomId', async (req, res) => {
  const id = parseInt(req.params.roomId, 10);

  if (!Number.isInteger(id) || id < 1 || id > 9999) {
    return res
      .status(400)
      .json({ error: 'Room ID must be a number between 1 and 9999.' });
  }

  if (rooms.has(id)) {
    return res.json({ exists: true, roomId: id });
  }

  // Fallback: check MongoDB
  if (mongoose.connection.readyState === 1) {
    try {
      const room = await Room.findOne({ roomId: id });
      if (room) {
        // Re-register the room in memory
        rooms.set(id, new Set());
        return res.json({ exists: true, roomId: id });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Failed to look up room.' });
    }
  }

  return res.status(404).json({ exists: false, error: 'Room not found.' });
});

// ─── WebSocket logic ───────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let currentRoomId = null;
  let username = null;

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON.' }));
      return;
    }

    switch (msg.type) {
      // ── join ──────────────────────────────────────────────────────────────
      case 'join': {
        const id = parseInt(msg.roomId, 10);
        const name = (msg.username || '').trim();

        if (!Number.isInteger(id) || id < 1 || id > 9999) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Room ID must be a number between 1 and 9999.'
            })
          );
          return;
        }

        if (!name) {
          ws.send(
            JSON.stringify({ type: 'error', message: 'Username is required.' })
          );
          return;
        }

        // Room must already exist
        let roomExists = rooms.has(id);
        if (!roomExists && mongoose.connection.readyState === 1) {
          try {
            const room = await Room.findOne({ roomId: id });
            if (room) {
              rooms.set(id, new Set());
              roomExists = true;
            }
          } catch {
            // ignore DB errors; rely on in-memory state
          }
        }

        if (!roomExists) {
          ws.send(
            JSON.stringify({ type: 'error', message: 'Room does not exist.' })
          );
          return;
        }

        currentRoomId = id;
        username = name;
        rooms.get(id).add(ws);

        ws.send(
          JSON.stringify({
            type: 'joined',
            roomId: id,
            message: `You joined room ${id}.`
          })
        );

        // Notify others
        broadcast(id, ws, {
          type: 'system',
          message: `${username} joined the room.`
        });
        break;
      }

      // ── message ───────────────────────────────────────────────────────────
      case 'message': {
        if (!currentRoomId || !username) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'You must join a room first.'
            })
          );
          return;
        }

        const text = (msg.text || '').trim();
        if (!text) return;

        const payload = {
          type: 'message',
          sender: username,
          text,
          timestamp: new Date().toISOString()
        };

        // Persist message to MongoDB
        if (mongoose.connection.readyState === 1) {
          try {
            await Room.findOneAndUpdate(
              { roomId: currentRoomId },
              { $push: { messages: { sender: username, text } } }
            );
          } catch {
            // non-fatal
          }
        }

        // Send to all members including sender
        broadcastAll(currentRoomId, payload);
        break;
      }

      default:
        ws.send(
          JSON.stringify({ type: 'error', message: 'Unknown message type.' })
        );
    }
  });

  ws.on('close', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      rooms.get(currentRoomId).delete(ws);
      if (username) {
        broadcast(currentRoomId, null, {
          type: 'system',
          message: `${username} left the room.`
        });
      }
    }
  });
});

// Broadcast to all clients in a room except the sender
function broadcast(roomId, sender, payload) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Broadcast to ALL clients in a room including the sender
function broadcastAll(roomId, payload) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running at http://localhost:${PORT}`);
});
