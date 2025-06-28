const express = require("express");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'https://electric-football.netlify.app/',
    methods: ['GET', 'POST']
  }
});

const rooms = {}; // Track users in each room

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on("join_room", (room, name) => {
    socket.join(room);

    if (!rooms[room]) {
      rooms[room] = [];
    }

    // Add player to room if not full
    if (rooms[room].length < 2) {
      const playerNumber = rooms[room].length + 1;
      rooms[room].push({ id: socket.id, name });

      socket.emit("assigned_player", playerNumber);
      io.to(room).emit("player_joined", { name, playerNumber });
      console.log(`${name} joined room ${room} as Player ${playerNumber}`);
    } else {
      socket.emit("room_full");
    }

    // Store room info on socket for later use
    socket.data.room = room;
  });

  socket.on("route_started", (data) => {
    // data is expected to have routeStarted and roomId properties
    const { routeStarted, roomId } = data;
    socket.to(roomId).emit("route_started", routeStarted);
  });

  socket.on("sack_timer_update", ({ sackTimeRemaining, roomId }) => {
    if (roomId) {
      socket.to(roomId).emit("sack_timer_update", sackTimeRemaining);
    }
  });


  socket.on('place_character', (data) => {
    const { room, position } = data;
    console.log("character placed at: " + position.x + ", " + position.y + " in room: " + room)
    socket.to(room).emit('character_placed', data);
  });

  socket.on("assign_route", (data) => {
  const { room, playerId, routeName } = data;
  if (room) {
    // Broadcast to all clients in the room including sender
    io.to(room).emit("route_assigned", { playerId, routeName });
  }
});

  socket.on("assign_zone", (data) => {
    const { room, playerId, zoneType, zoneCircle, assignedOffensiveId } = data;
    if (room) {
      io.to(room).emit("zone_assigned", {
        playerId,
        zoneType,
        zoneCircle,
        assignedOffensiveId,
      });
    }
  });

    socket.on("zone_area_assigned", (data) => {
    const { playerId, zoneType, zoneCircle, room } = data;
    if (room) {
      io.to(room).emit("zone_area_assigned", {
        playerId,
        zoneType,
        zoneCircle,
      });
    }
  });

  socket.on("update_character_position", ({ playerId, position, room }) => {
    socket.to(room).emit("character_position_updated", { playerId, position });
  });


  socket.on("ready_to_catch", (playerIds) => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit("ready_to_catch", playerIds);
    }
  });

  socket.on("play_outcome", (data) => {
    const { outcome, completedYards, roomId } = data;

    if (roomId) {
      socket.to(roomId).emit("play_outcome", {
        outcome,
        completedYards
      });
    }
  });

  socket.on("switch_sides", ({ roomId, outcome, yardLine }) => {
    io.to(roomId).emit("switch_sides", { outcome, yardLine });
  });

  socket.on("play_reset", (data) => {

    const { newYardLine, newDown, newDistance, newFirstDownStartY } = data;

    console.log(newYardLine, newDown, newDistance, newFirstDownStartY);

    io.to(data.roomId).emit("play_reset", {
      newYardLine,
      newDown,
      newDistance,
      newFirstDownStartY
    });
  });

  socket.on("player_positions_update", (data) => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit("player_positions_updated", data);
    }
  });
  socket.on("disconnect", () => {
    console.log(`User Disconnected: (${socket.id})`);

    // Remove player from room
    for (const roomKey in rooms) {
      rooms[roomKey] = rooms[roomKey].filter(p => p.id !== socket.id);
      if (rooms[roomKey].length === 0) {
        delete rooms[roomKey]; // cleanup empty room
      }
    }
  });
});

server.listen(process.env.PORT || 3001, () => {
  console.log("SERVER RUNNING");
});
