const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// State Management
let waitingQueue = [];
const rooms = {};

// ID Generator
const generateRoomId = () => Math.random().toString(36).substring(2, 9);

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // JOIN QUEUE FOR RANDOM MATCH
    socket.on('join_queue', (userData) => {
        // Prevent duplicate queueing
        if (waitingQueue.find(p => p.id === socket.id)) return;

        console.log(`${socket.id} (${userData.name}) joined queue`);
        waitingQueue.push({ id: socket.id, name: userData.name, socket: socket });

        if (waitingQueue.length >= 2) {
            const p1 = waitingQueue.shift();
            const p2 = waitingQueue.shift();

            const roomId = generateRoomId();

            rooms[roomId] = {
                id: roomId,
                players: [p1.id, p2.id],
                playerData: {
                    [p1.id]: { name: p1.name, matchWins: 0, ready: false, card: null, rematchVote: false },
                    [p2.id]: { name: p2.name, matchWins: 0, ready: false, card: null, rematchVote: false }
                },
                round: 1,
                timer: null
            };

            p1.socket.join(roomId);
            p2.socket.join(roomId);

            // Notify both players they found a match
            io.to(p1.id).emit('match_found', { oppName: p2.name, roomId: roomId, myId: p1.id, oppId: p2.id });
            io.to(p2.id).emit('match_found', { oppName: p1.name, roomId: roomId, myId: p2.id, oppId: p1.id });

            // Start the first round after 3 seconds of buffer
            setTimeout(() => {
                startRound(roomId);
            }, 3000);
        }
    });

    // START A 20 SECOND TURN
    const startRound = (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        room.playerData[room.players[0]].ready = false;
        room.playerData[room.players[0]].card = null;
        room.playerData[room.players[1]].ready = false;
        room.playerData[room.players[1]].card = null;

        io.to(roomId).emit('round_start', { round: room.round, timeLimit: 20 });

        // Set 20-second timeout for auto-pick
        room.timer = setTimeout(() => {
            handleTimeOut(roomId);
        }, 20000); // 20s
    };

    // CARD SUBMISSION (BLIND PICK)
    socket.on('submit_card', ({ roomId, cardInfo }) => {
        const room = rooms[roomId];
        if (!room) return;

        const pData = room.playerData[socket.id];
        if (pData.ready) return; // Already submitted

        pData.ready = true;
        pData.card = cardInfo;

        // Notify opponent that this player has picked a card (BLIND)
        socket.to(roomId).emit('opponent_picked');

        // Check if both ready
        const p1Id = room.players[0];
        const p2Id = room.players[1];
        if (room.playerData[p1Id].ready && room.playerData[p2Id].ready) {
            clearTimeout(room.timer);
            resolveRound(roomId);
        }
    });

    // TIMEOUT AUTO PICK (Random fallback from Server if no submission)
    const handleTimeOut = (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        // If not ready, the client will be forced to pick a random card upon receiving this signal
        if (!room.playerData[p1Id].ready || !room.playerData[p2Id].ready) {
            io.to(roomId).emit('force_auto_pick');
        }
    };

    // BOTH CARDS SUBMITTED -> REVEAL AND CLASH
    const resolveRound = (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        const p1Card = room.playerData[p1Id].card;
        const p2Card = room.playerData[p2Id].card;

        io.to(roomId).emit('round_reveal', {
            results: {
                [p1Id]: p1Card,
                [p2Id]: p2Card
            }
        });

        room.round++;

        // Next round start is handled by the client requesting it after animation, 
        // to ensure animations don't overlap with server ticks.
    };

    // CLIENT REQUESTS NEXT ROUND AFTER ANIMATION
    socket.on('ready_next_round', (roomId) => {
        startRound(roomId);
    });

    // MATCH ENDED (Client sends result)
    socket.on('match_end', ({ roomId, winnerId }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (winnerId !== 'Draw') {
            room.playerData[winnerId].matchWins++;
        }

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        // Complete Victory Check (3 Wins)
        if (room.playerData[p1Id].matchWins >= 3 || room.playerData[p2Id].matchWins >= 3) {
            const finalWinner = room.playerData[p1Id].matchWins >= 3 ? p1Id : p2Id;
            io.to(roomId).emit('complete_victory', { winnerId: finalWinner });
            delete rooms[roomId];
        } else {
            // Enter Rematch Vote Phase
            room.playerData[p1Id].rematchVote = null;
            room.playerData[p2Id].rematchVote = null;
            io.to(roomId).emit('ask_rematch', {
                scores: {
                    [p1Id]: room.playerData[p1Id].matchWins,
                    [p2Id]: room.playerData[p2Id].matchWins
                }
            });
        }
    });

    // REMATCH VOTE
    socket.on('vote_rematch', ({ roomId, accept }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.playerData[socket.id].rematchVote = accept;

        if (accept === false) {
            io.to(roomId).emit('room_closed', { reason: 'Opponent declined rematch.' });
            delete rooms[roomId];
            return;
        }

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        if (room.playerData[p1Id].rematchVote === true && room.playerData[p2Id].rematchVote === true) {
            // Rematch accepted
            room.round = 1;
            io.to(roomId).emit('rematch_accepted');
            setTimeout(() => {
                startRound(roomId);
            }, 2000);
        }
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Remove from queue
        waitingQueue = waitingQueue.filter(p => p.id !== socket.id);

        // Remove from rooms and notify opponent
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players.includes(socket.id)) {
                io.to(roomId).emit('room_closed', { reason: 'Opponent disconnected.' });
                delete rooms[roomId];
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Chrono Link PVP Server running on port ${PORT}`);
});
