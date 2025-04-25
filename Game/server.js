const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const rooms = {};

const wordPool = [
  { word: 'chair', hint: 'Furniture related' },
  { word: 'apple', hint: 'Fruit related' },
  { word: 'dog', hint: 'Animal related' },
  { word: 'car', hint: 'Vehicle related' },
  { word: 'piano', hint: 'Instrument related' },
  { word: 'computer', hint: 'Technology related' }
];

app.use(express.static('public'));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).send("Something went wrong on the server!");
});

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  let roomId = '';
  let username = '';

  socket.on('joinRoom', ({ username: user, roomId: room }) => {
    try {
      if (!user || !room) {
        return socket.emit('error', { message: 'Username and room ID are required' });
      }

      username = user;
      roomId = room;

      // Create room if it doesn't exist
      if (!rooms[roomId]) {
        rooms[roomId] = {
          players: [],
          isGameRunning: false,
          gameData: null,
          currentPlayerIndex: 0,
          timerInterval: null,
        };
      }

      // Check if username already exists in the room
      const existingPlayer = rooms[roomId].players.find(p => p.username === username);
      if (existingPlayer) {
        // User is rejoining, use their existing score
        socket.join(roomId);
        socket.emit('joinedRoom', { 
          isHost: rooms[roomId].players[0].username === username,
          gameInProgress: rooms[roomId].isGameRunning
        });
        
        // Send current game data if game is running
        if (rooms[roomId].isGameRunning && rooms[roomId].gameData) {
          socket.emit('gameStarted', rooms[roomId].gameData);
        } else {
          socket.emit('waitingForHost');
        }
      } else {
        // New player joining
        rooms[roomId].players.push({ username, score: 0, socketId: socket.id });
        socket.join(roomId);
        socket.emit('joinedRoom', { 
          isHost: rooms[roomId].players.length === 1,
          gameInProgress: rooms[roomId].isGameRunning
        });
        
        if (rooms[roomId].isGameRunning) {
          socket.emit('gameStarted', rooms[roomId].gameData);
        } else {
          socket.emit('waitingForHost');
        }
      }
      
      // Broadcast updated player list to everyone in the room
      io.to(roomId).emit('playerUpdate', { players: rooms[roomId].players });
      console.log(`${username} joined room ${roomId}`);
    } catch (error) {
      console.error("Error in joinRoom:", error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  socket.on('startGame', (roomId) => {
    try {
      const room = rooms[roomId];
      if (!room) {
        return socket.emit('error', { message: 'Room does not exist' });
      }
      
      if (room.isGameRunning) {
        return socket.emit('error', { message: 'Game is already running' });
      }
      
      // Check if user is the host (first player)
      if (room.players.length > 0 && room.players[0].socketId !== socket.id) {
        return socket.emit('error', { message: 'Only the host can start the game' });
      }

      room.isGameRunning = true;
      room.gameData = generateRandomGameData(roomId);
      io.to(roomId).emit('gameStarted', room.gameData);
      startGameTimer(roomId);
      console.log(`Game started in room ${roomId}`);
    } catch (error) {
      console.error("Error in startGame:", error);
      socket.emit('error', { message: 'Failed to start game' });
    }
  });

  socket.on('guessWord', ({ roomId, guess }) => {
    try {
      const room = rooms[roomId];
      if (!room || !room.isGameRunning) {
        return socket.emit('error', { message: 'Game is not running' });
      }

      if (!guess) {
        return socket.emit('error', { message: 'No guess provided' });
      }

      // Find the player who made the guess
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIndex === -1) {
        return socket.emit('error', { message: 'Player not found in room' });
      }

      if (room.gameData.word.toLowerCase() === guess.toLowerCase()) {
        // Correct guess
        clearInterval(room.timerInterval);
        
        // Update score for the player who guessed correctly
        room.players[playerIndex].score += 1;
        
        // Emit word guessed event with winner info
        io.to(roomId).emit('wordGuessed', { 
          word: room.gameData.word,
          winner: room.players[playerIndex].username 
        });
        
        io.to(roomId).emit('playerUpdate', { players: room.players });
        io.to(roomId).emit('gameOver');
        console.log(`${room.players[playerIndex].username} guessed correctly in room ${roomId}`);
      } else {
        // Incorrect guess
        socket.emit('incorrectGuess');
      }
    } catch (error) {
      console.error("Error in guessWord:", error);
      socket.emit('error', { message: 'Error processing guess' });
    }
  });
  // Add these handlers in the socket.io connection block
socket.on('leaveRoom', () => {
    try {
      if (!roomId || !rooms[roomId]) {
        return socket.emit('error', { message: 'You are not in a room' });
      }
      
      // Remove player from room
      const playerIndex = rooms[roomId].players.findIndex(p => p.socketId === socket.id);
      if (playerIndex !== -1) {
        console.log(`${username} left room ${roomId}`);
        rooms[roomId].players.splice(playerIndex, 1);
        
        // Leave the socket.io room
        socket.leave(roomId);
        
        // Notify remaining players
        io.to(roomId).emit('playerUpdate', { players: rooms[roomId].players });
        
        // If room is empty, clean up
        if (rooms[roomId].players.length === 0) {
          console.log(`Room ${roomId} is empty, cleaning up`);
          clearInterval(rooms[roomId].timerInterval);
          delete rooms[roomId];
        }
        // If host left, assign a new host
        else if (playerIndex === 0 && rooms[roomId].players.length > 0) {
          io.to(rooms[roomId].players[0].socketId).emit('becomeHost');
          console.log(`New host assigned in room ${roomId}: ${rooms[roomId].players[0].username}`);
        }
        
        socket.emit('leftRoom');
      }
    } catch (error) {
      console.error("Error in leaveRoom:", error);
      socket.emit('error', { message: 'Failed to leave room' });
    }
  });
  
  socket.on('deleteRoom', () => {
    try {
      if (!roomId || !rooms[roomId]) {
        return socket.emit('error', { message: 'Room does not exist' });
      }
      
      // Check if user is the host (first player)
      if (rooms[roomId].players.length > 0 && rooms[roomId].players[0].socketId !== socket.id) {
        return socket.emit('error', { message: 'Only the host can delete the room' });
      }
      
      console.log(`Room ${roomId} deleted by host ${username}`);
      
      // Notify all players in the room that it's being deleted
      io.to(roomId).emit('roomDeleted');
      
      // Clean up room resources
      clearInterval(rooms[roomId].timerInterval);
      delete rooms[roomId];
    } catch (error) {
      console.error("Error in deleteRoom:", error);
      socket.emit('error', { message: 'Failed to delete room' });
    }
  });
  socket.on('startNextGame', (roomId) => {
    try {
      const room = rooms[roomId];
      if (!room) {
        return socket.emit('error', { message: 'Room does not exist' });
      }
      
      // Only host can start next game
      if (room.players.length > 0 && room.players[0].socketId !== socket.id) {
        return socket.emit('error', { message: 'Only the host can start the next game' });
      }

      room.isGameRunning = true;
      room.gameData = generateRandomGameData(roomId);
      io.to(roomId).emit('gameStarted', room.gameData);
      startGameTimer(roomId);
      console.log(`New game started in room ${roomId}`);
    } catch (error) {
      console.error("Error in startNextGame:", error);
      socket.emit('error', { message: 'Failed to start next game' });
    }
  });

  socket.on('disconnect', () => {
    try {
      console.log('Client disconnected:', socket.id);
      
      // Find and remove the player from their room
      if (roomId && rooms[roomId]) {
        const playerIndex = rooms[roomId].players.findIndex(p => p.socketId === socket.id);
        
        if (playerIndex !== -1) {
          console.log(`${rooms[roomId].players[playerIndex].username} left room ${roomId}`);
          
          // We keep the player in the room with disconnected status to preserve scores
          rooms[roomId].players[playerIndex].connected = false;
          
          // Notify remaining players
          io.to(roomId).emit('playerUpdate', { players: rooms[roomId].players });
          
          // If room is empty or only has disconnected players, clean up
          const connectedPlayers = rooms[roomId].players.filter(p => p.connected !== false);
          if (connectedPlayers.length === 0) {
            console.log(`Room ${roomId} is empty, cleaning up`);
            clearInterval(rooms[roomId].timerInterval);
            delete rooms[roomId];
          }
          // If host left, assign a new host
          else if (playerIndex === 0 && connectedPlayers.length > 0) {
            io.to(connectedPlayers[0].socketId).emit('becomeHost');
            console.log(`New host assigned in room ${roomId}: ${connectedPlayers[0].username}`);
          }
        }
      }
    } catch (error) {
      console.error("Error in disconnect handler:", error);
    }
  });

  function generateRandomGameData(roomId) {
    const randomIndex = Math.floor(Math.random() * wordPool.length);
    const selectedWord = wordPool[randomIndex];
    return {
      hint: selectedWord.hint,
      word: selectedWord.word,
      players: rooms[roomId].players,
    };
  }

  function startGameTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    // Clear any existing timer
    if (room.timerInterval) {
      clearInterval(room.timerInterval);
    }
    
    let timeLeft = 120;
    room.timerInterval = setInterval(() => {
      timeLeft -= 1;
      io.to(roomId).emit('timerUpdate', { timeLeft });
      
      // Reveal a random letter every 30 seconds
      if (timeLeft > 0 && timeLeft % 30 === 0) {
        io.to(roomId).emit('revealLetter');
      }
      
      if (timeLeft <= 0) {
        clearInterval(room.timerInterval);
        room.isGameRunning = false;
        io.to(roomId).emit('timeUp', { correctWord: room.gameData.word });
        io.to(roomId).emit('gameOver');
      }
    }, 1000);
  }
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});