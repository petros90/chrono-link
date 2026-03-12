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
const globalUsers = {}; // Maps socket.id to user name
const tournamentRooms = {}; // Custom Tourney Rooms

// ID Generator
const generateRoomId = () => Math.random().toString(36).substring(2, 9);

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // GLOBAL LOBBY LOGIN
    socket.on('lobby_login', (userData) => {
        if (!userData || !userData.name) return;
        globalUsers[socket.id] = userData.name;
        io.emit('update_user_list', Object.values(globalUsers));
        console.log(`User registered in lobby: ${userData.name} (${socket.id})`);
    });

    // TOURNAMENT: GET ROOMS
    socket.on('get_tourney_rooms', () => {
        const publicRooms = Object.values(tournamentRooms).map(r => ({
            id: r.id, hostName: r.hostName, name: r.name, curr: r.players.length, max: r.maxPlayers, status: r.status
        }));
        socket.emit('update_tourney_rooms', publicRooms);
    });

    // TOURNAMENT: CREATE ROOM
    socket.on('create_tourney_room', (data) => {
        const roomId = generateRoomId();
        tournamentRooms[roomId] = {
            id: roomId,
            name: data.roomName || `${data.userName}님의 방`,
            hostId: socket.id,
            hostName: data.userName,
            maxPlayers: data.maxPlayers || 16,
            status: 'LOBBY', // LOBBY, PLAYING, FINISHED
            players: [{ id: socket.id, name: data.userName, status: 'ALIVE' }], // ALIVE, SPECTATOR, LEFT
            matches: {}, // active sub-matches
            bracket: null
        };
        socket.join(`tourney_${roomId}`);
        socket.emit('tourney_room_joined', tournamentRooms[roomId]);

        // Broadcast
        io.emit('update_tourney_rooms', Object.values(tournamentRooms).map(r => ({
            id: r.id, hostName: r.hostName, name: r.name, curr: r.players.length, max: r.maxPlayers, status: r.status
        })));
    });

    // TOURNAMENT: JOIN ROOM
    socket.on('join_tourney_room', (data) => {
        const room = tournamentRooms[data.roomId];
        if (!room) return socket.emit('tourney_error', '방이 존재하지 않습니다.');
        if (room.status !== 'LOBBY') return socket.emit('tourney_error', '이미 게임이 시작된 방입니다.');
        if (room.players.length >= room.maxPlayers) return socket.emit('tourney_error', '방이 가득 찼습니다.');
        if (room.players.find(p => p.id === socket.id)) return;

        room.players.push({ id: socket.id, name: data.userName, status: 'ALIVE' });
        socket.join(`tourney_${data.roomId}`);

        socket.emit('tourney_room_joined', room); // Triggers visual transition for the new joiner
        io.to(`tourney_${data.roomId}`).emit('tourney_room_updated', room); // Updates everyone else

        io.emit('update_tourney_rooms', Object.values(tournamentRooms).map(r => ({
            id: r.id, hostName: r.hostName, name: r.name, curr: r.players.length, max: r.maxPlayers, status: r.status
        })));
    });

    // TOURNAMENT: LEAVE ROOM HELPER
    const handleTourneyLeave = (sockId) => {
        for (const roomId in tournamentRooms) {
            const room = tournamentRooms[roomId];
            const pIndex = room.players.findIndex(p => p.id === sockId);
            if (pIndex !== -1) {
                if (room.status === 'LOBBY') {
                    room.players.splice(pIndex, 1);
                    if (room.players.length === 0) {
                        delete tournamentRooms[roomId];
                    } else if (room.hostId === sockId) {
                        room.hostId = room.players[0].id;
                        room.hostName = room.players[0].name;
                        io.to(`tourney_${roomId}`).emit('tourney_room_updated', room);
                    } else {
                        io.to(`tourney_${roomId}`).emit('tourney_room_updated', room);
                    }
                } else {
                    // Mark as left during game. Auto-win will be handled by the round logic later
                    room.players[pIndex].status = 'LEFT';
                    io.to(`tourney_${roomId}`).emit('tourney_room_updated', room);

                    // Auto-forfeit any currently active match
                    let needsAdvance = false;
                    if (room.bracket) {
                        for (let r = 0; r < room.bracket.length; r++) {
                            const roundArr = room.bracket[r];
                            for (let m = 0; m < roundArr.length; m++) {
                                const match = roundArr[m];
                                if (match.winner === null && match.p1 && match.p2) {
                                    if (match.p1.id === sockId || match.p2.id === sockId) {
                                        const winner = match.p1.id === sockId ? match.p2 : match.p1;
                                        match.winner = winner;
                                        match.status = 'DONE';
                                        needsAdvance = true;

                                        const matchKey = `${r}_${m}`;
                                        if (room.matches && room.matches[matchKey]) {
                                            const mState = room.matches[matchKey];
                                            clearTimeout(mState.timer);
                                            io.to(winner.id).emit('tourney_match_concluded', { winnerId: winner.id });
                                            delete room.matches[matchKey];
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if (needsAdvance) {
                        checkAndAdvanceTournament(roomId);
                    }
                }

                io.emit('update_tourney_rooms', Object.values(tournamentRooms).map(r => ({
                    id: r.id, hostName: r.hostName, name: r.name, curr: r.players.length, max: r.maxPlayers, status: r.status
                })));
                break;
            }
        }
    };

    socket.on('leave_tourney_room', () => {
        handleTourneyLeave(socket.id);
        const tourneyRooms = Array.from(socket.rooms).filter(r => r.startsWith('tourney_'));
        tourneyRooms.forEach(r => socket.leave(r));
    });

    // TOURNAMENT: BRACKET HELPERS
    const shuffle = array => {
        let currentIndex = array.length, randomIndex;
        while (currentIndex !== 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    };

    const buildBracket = (players) => {
        let size = 4;
        if (players.length > 4) size = 8;
        if (players.length > 8) size = 16;

        const shuffled = shuffle([...players]);
        const bracket = []; // Array of rounds

        const round1 = [];
        let pIndex = 0;
        const matchesCount = size / 2;
        const byes = size - players.length;

        for (let i = 0; i < matchesCount; i++) {
            if (i < byes) {
                const p1 = shuffled[pIndex++];
                round1.push({ mId: i, p1: p1, p2: null, winner: p1, status: 'DONE' });
            } else {
                const p1 = shuffled[pIndex++];
                const p2 = shuffled[pIndex++];
                round1.push({ mId: i, p1: p1, p2: p2, winner: null, status: 'WAITING' });
            }
        }
        bracket.push(round1);

        let prevRoundCount = matchesCount;
        while (prevRoundCount > 1) {
            const nextRoundCount = prevRoundCount / 2;
            const round = [];
            for (let i = 0; i < nextRoundCount; i++) {
                round.push({ mId: i, p1: null, p2: null, winner: null, status: 'WAITING' });
            }
            bracket.push(round);
            prevRoundCount = nextRoundCount;
        }
        return bracket;
    };

    const checkAndAdvanceTournament = (roomId) => {
        const room = tournamentRooms[roomId];
        if (!room) return;

        const bracket = room.bracket;
        let activeMatchesFound = false;

        // Propagate winners to next round
        for (let r = 0; r < bracket.length - 1; r++) {
            const currentRound = bracket[r];
            const nextRound = bracket[r + 1];

            for (let i = 0; i < currentRound.length; i++) {
                const match = currentRound[i];
                if (match.status === 'DONE' && match.winner) {
                    const nextMatchIndex = Math.floor(i / 2);
                    const nextMatch = nextRound[nextMatchIndex];
                    const slot = (i % 2 === 0) ? 'p1' : 'p2';
                    if (!nextMatch[slot]) {
                        nextMatch[slot] = match.winner;
                    }
                }
            }
        }

        // Check for matches that are ready to play in the CURRENT round before moving deep
        for (let r = 0; r < bracket.length; r++) {
            const round = bracket[r];
            let roundHasActiveMatches = false;

            for (let match of round) {
                if (match.status === 'WAITING' && match.p1 && match.p2) {
                    startTourneyMatch(roomId, r, match.mId, match.p1, match.p2);
                    match.status = 'PLAYING';
                    roundHasActiveMatches = true;
                    activeMatchesFound = true;
                } else if (match.status === 'PLAYING') {
                    roundHasActiveMatches = true;
                    activeMatchesFound = true;
                }
            }

            // If the current round isn't finished yet, don't cascade into the next bracket layer
            if (roundHasActiveMatches) break;
        }

        if (!activeMatchesFound) {
            const finalMatch = bracket[bracket.length - 1][0];
            if (finalMatch.status === 'DONE' && finalMatch.winner) {
                room.status = 'FINISHED';
                io.to(`tourney_${roomId}`).emit('tourney_finished', { winner: finalMatch.winner, bracket: room.bracket });

                // Immediately delete finished tournament rooms to clean up the lobby
                delete tournamentRooms[roomId];
                io.emit('update_tourney_rooms', getTourneyRooms());
            }
        } else {
            io.to(`tourney_${roomId}`).emit('tourney_bracket_update', { bracket: room.bracket, status: room.status });
        }
    };

    const startTourneyMatch = (tourneyId, roundIndex, matchId, p1, p2) => {
        const room = tournamentRooms[tourneyId];
        const matchKey = `${roundIndex}_${matchId}`;

        room.matches[matchKey] = {
            players: [p1.id, p2.id],
            mode: 'Beginner', // Tournament force standardizes to Beginner (5 cards)
            playerData: {
                [p1.id]: { name: p1.name, matchWins: 0, ready: false, card: null },
                [p2.id]: { name: p2.name, matchWins: 0, ready: false, card: null }
            },
            round: 1,
            timer: null
        };

        // Alert these specific players they are playing
        io.to(p1.id).emit('tourney_match_found', { oppName: p2.name, matchKey: matchKey, myId: p1.id, oppId: p2.id });
        io.to(p2.id).emit('tourney_match_found', { oppName: p1.name, matchKey: matchKey, myId: p2.id, oppId: p1.id });
    };

    socket.on('start_tourney', (data) => {
        const room = tournamentRooms[data.roomId];
        if (!room) return;
        if (room.hostId !== socket.id) return socket.emit('tourney_error', '방장만 시작할 수 있습니다.');
        if (room.players.length < 4) return socket.emit('tourney_error', '최소 4명 이상의 플레이어가 필요합니다.');

        room.status = 'BRACKET_REVEAL';
        room.bracket = buildBracket(room.players);

        io.to(`tourney_${room.id}`).emit('tourney_started', { bracket: room.bracket });

        // Broadcast rooms change
        io.emit('update_tourney_rooms', Object.values(tournamentRooms).map(r => ({
            id: r.id, hostName: r.hostName, name: r.name, curr: r.players.length, max: r.maxPlayers, status: r.status
        })));

        // Reveal bracket for 5 seconds before playing
        setTimeout(() => {
            room.status = 'PLAYING';
            checkAndAdvanceTournament(room.id);
        }, 5000);
    });

    // TOURNAMENT: MATCH GAMEPLAY LOGIC
    const startTourneyRound = (tourneyId, matchKey) => {
        const room = tournamentRooms[tourneyId];
        if (!room) return;
        const matchState = room.matches[matchKey];
        if (!matchState) return;

        matchState.playerData[matchState.players[0]].ready = false;
        matchState.playerData[matchState.players[0]].card = null;
        matchState.playerData[matchState.players[1]].ready = false;
        matchState.playerData[matchState.players[1]].card = null;

        io.to(matchState.players[0]).emit('tourney_round_start', { round: matchState.round, timeLimit: 20 });
        io.to(matchState.players[1]).emit('tourney_round_start', { round: matchState.round, timeLimit: 20 });

        matchState.timer = setTimeout(() => {
            handleTourneyTimeOut(tourneyId, matchKey);
        }, 20000);
    };

    const handleTourneyTimeOut = (tourneyId, matchKey) => {
        const room = tournamentRooms[tourneyId];
        if (!room) return;
        const matchState = room.matches[matchKey];
        if (!matchState) return;

        clearTimeout(matchState.timer);

        const p1Id = matchState.players[0];
        const p2Id = matchState.players[1];

        const forcePick = (pId) => {
            const pData = matchState.playerData[pId];
            if (!pData.ready) {
                if (pData.deck && pData.deck.length > 0) {
                    const avail = pData.deck.filter(c => !c.used);
                    if (avail.length > 0) {
                        const pick = avail[Math.floor(Math.random() * avail.length)];
                        pick.used = true;
                        pData.card = pick;
                        pData.ready = true;
                    } else {
                        // Fallback preventing empty deck client crash
                        pData.card = { avatar: "fire", grade: 1, power: 1 };
                        pData.ready = true;
                    }
                } else {
                    // Fallback to prevent null crashes if deck was missing
                    pData.card = { avatar: "fire", grade: 1, power: 1 };
                    pData.ready = true;
                }
            }
        };

        if (!matchState.playerData[p1Id].ready || !matchState.playerData[p2Id].ready) {
            forcePick(p1Id);
            forcePick(p2Id);
            resolveTourneyRound(tourneyId, matchKey);
        }
    };

    socket.on('send_tourney_deck', ({ tourneyId, matchKey, deck }) => {
        const room = tournamentRooms[tourneyId];
        if (!room) return;
        const matchState = room.matches[matchKey];
        if (!matchState) return;

        matchState.playerData[socket.id].deck = deck;

        const p1Id = matchState.players[0];
        const p2Id = matchState.players[1];

        if (matchState.playerData[p1Id].deck && matchState.playerData[p2Id].deck) {
            io.to(p1Id).emit('tourney_decks_synced', { oppDeck: matchState.playerData[p2Id].deck });
            io.to(p2Id).emit('tourney_decks_synced', { oppDeck: matchState.playerData[p1Id].deck });

            setTimeout(() => {
                startTourneyRound(tourneyId, matchKey);
            }, 1000);
        }
    });

    socket.on('submit_tourney_card', ({ tourneyId, matchKey, cardInfo }) => {
        const room = tournamentRooms[tourneyId];
        if (!room) return;
        const matchState = room.matches[matchKey];
        if (!matchState) return;

        const pData = matchState.playerData[socket.id];
        if (!pData || pData.ready) return;

        // Prevent empty card submission crashes
        if (!cardInfo) {
            cardInfo = { avatar: "fire", grade: 1, power: 1 };
        }

        pData.ready = true;
        pData.card = cardInfo;

        if (pData.deck) {
            const deckCard = pData.deck.find(c => c.avatar === cardInfo.avatar && c.grade === cardInfo.grade && !c.used);
            if (deckCard) deckCard.used = true;
        }

        const p1Id = matchState.players[0];
        const p2Id = matchState.players[1];

        socket.to(p1Id === socket.id ? p2Id : p1Id).emit('tourney_opponent_picked');

        if (matchState.playerData[p1Id].ready && matchState.playerData[p2Id].ready) {
            clearTimeout(matchState.timer);
            resolveTourneyRound(tourneyId, matchKey);
        }
    });

    const resolveTourneyRound = (tourneyId, matchKey) => {
        const room = tournamentRooms[tourneyId];
        if (!room) return;
        const matchState = room.matches[matchKey];
        if (!matchState) return;

        const p1Id = matchState.players[0];
        const p2Id = matchState.players[1];

        const p1Card = matchState.playerData[p1Id].card;
        const p2Card = matchState.playerData[p2Id].card;

        io.to(p1Id).emit('tourney_round_reveal', { results: { [p1Id]: p1Card, [p2Id]: p2Card } });
        io.to(p2Id).emit('tourney_round_reveal', { results: { [p1Id]: p1Card, [p2Id]: p2Card } });

        matchState.round++;

        setTimeout(() => {
            if (tournamentRooms[tourneyId] && tournamentRooms[tourneyId].matches[matchKey]) {
                const updatedMatch = tournamentRooms[tourneyId].matches[matchKey];
                if (updatedMatch.round <= 5 && updatedMatch.playerData[p1Id].matchWins < 3 && updatedMatch.playerData[p2Id].matchWins < 3) {
                    startTourneyRound(tourneyId, matchKey);
                } else {
                    // INFINITE HANG PREVENTION: If clients crashed and didn't report match_end
                    setTimeout(() => {
                        if (tournamentRooms[tourneyId] && tournamentRooms[tourneyId].matches[matchKey]) {
                            const p1Wins = updatedMatch.playerData[p1Id].matchWins;
                            const p2Wins = updatedMatch.playerData[p2Id].matchWins;
                            let winnerId = p1Wins > p2Wins ? p1Id : (p2Wins > p1Wins ? p2Id : 'Draw');

                            // Simulate client behavior to force end
                            const [rIdx, mIdx] = matchKey.split('_').map(Number);
                            const bracketMatch = tournamentRooms[tourneyId].bracket[rIdx][mIdx];
                            if (bracketMatch.status !== 'DONE') {
                                if (winnerId === 'Draw') {
                                    winnerId = Math.random() < 0.5 ? p1Id : p2Id;
                                }
                                bracketMatch.winner = tournamentRooms[tourneyId].players.find(p => p.id === winnerId) || { id: winnerId, name: "알수없음" };
                                bracketMatch.status = 'DONE';
                                io.to(p1Id).emit('tourney_match_concluded', { winnerId: winnerId });
                                io.to(p2Id).emit('tourney_match_concluded', { winnerId: winnerId });
                                delete tournamentRooms[tourneyId].matches[matchKey];
                                checkAndAdvanceTournament(tourneyId);
                            }
                        }
                    }, 5000);
                }
            }
        }, 6000);
    };

    socket.on('tourney_match_end', ({ tourneyId, matchKey, winnerId }) => {
        const room = tournamentRooms[tourneyId];
        if (!room) return;
        const matchState = room.matches[matchKey];
        if (!matchState) return;

        const [rIdx, mIdx] = matchKey.split('_').map(Number);
        const bracketMatch = room.bracket[rIdx][mIdx];
        if (bracketMatch.status === 'DONE') return; // Prevent duplicate end events

        // Tiebreaker for Tournament Draw (Randomly force a winner to advance bracket safely)
        let resolvedWinnerId = winnerId;
        if (resolvedWinnerId === 'Draw') {
            resolvedWinnerId = Math.random() < 0.5 ? matchState.players[0] : matchState.players[1];
        }

        const validWinnerObj = room.players.find(p => p.id === resolvedWinnerId);

        // Fallback: if player object is totally lost due to disconnects before resolution
        if (!validWinnerObj) {
            bracketMatch.winner = { id: resolvedWinnerId, name: "알수없음" };
        } else {
            bracketMatch.winner = validWinnerObj;
        }

        bracketMatch.status = 'DONE';

        io.to(matchState.players[0]).emit('tourney_match_concluded', { winnerId: resolvedWinnerId });
        io.to(matchState.players[1]).emit('tourney_match_concluded', { winnerId: resolvedWinnerId });

        delete room.matches[matchKey]; // Clean up memory

        checkAndAdvanceTournament(tourneyId);
    });

    // JOIN QUEUE FOR RANDOM MATCH
    socket.on('join_queue', (userData) => {
        // Prevent duplicate queueing
        if (waitingQueue.find(p => p.id === socket.id)) return;

        const mode = userData.mode || 'Beginner'; // Default to Beginner if missing
        const pName = userData.name || "알수없음";
        console.log(`${socket.id} (${pName}) joined queue for [${mode}]`);
        waitingQueue.push({ id: socket.id, name: pName, mode: mode, socket: socket });

        // Find another player in the queue with the SAME mode
        const myIndex = waitingQueue.findIndex(p => p.id === socket.id);
        const matchIndex = waitingQueue.findIndex((p, idx) => p.mode === mode && idx !== myIndex);

        if (matchIndex !== -1) {
            // Match found!
            // .splice returns an array of the removed elements, we just need the first item
            const p1 = waitingQueue.splice(Math.max(myIndex, matchIndex), 1)[0];
            const p2 = waitingQueue.splice(Math.min(myIndex, matchIndex), 1)[0];

            const roomId = generateRoomId();

            rooms[roomId] = {
                id: roomId,
                players: [p1.id, p2.id],
                mode: mode,
                playerData: {
                    [p1.id]: { name: p1.name, matchWins: 0, ready: false, card: null, rematchVote: false },
                    [p2.id]: { name: p2.name, matchWins: 0, ready: false, card: null, rematchVote: false }
                },
                round: 1,
                timer: null
            };

            p1.socket.join(roomId);
            p2.socket.join(roomId);

            // Notify both players they found a match with the correct mode
            io.to(p1.id).emit('match_found', { oppName: p2.name, roomId: roomId, myId: p1.id, oppId: p2.id, mode: mode });
            io.to(p2.id).emit('match_found', { oppName: p1.name, roomId: roomId, myId: p2.id, oppId: p1.id, mode: mode });

            // Wait for clients to generate and send their decks before starting the round.
        }
    });

    // CANCEL QUEUE
    socket.on('cancel_queue', () => {
        const userInQueue = waitingQueue.find(p => p.id === socket.id);
        if (userInQueue) {
            waitingQueue = waitingQueue.filter(p => p.id !== socket.id);
            console.log(`${socket.id} (${userInQueue.name}) cancelled matchmaking.`);
        }
    });

    // SYNC DECKS FOR PVP
    socket.on('send_deck', ({ roomId, deck }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.playerData[socket.id].deck = deck;

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        if (room.playerData[p1Id].deck && room.playerData[p2Id].deck) {
            io.to(p1Id).emit('decks_synced', { oppDeck: room.playerData[p2Id].deck });
            io.to(p2Id).emit('decks_synced', { oppDeck: room.playerData[p1Id].deck });

            // Start the first round after 1 second buffer
            setTimeout(() => {
                startRound(roomId);
            }, 1000);
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

        if (pData.deck) {
            const deckCard = pData.deck.find(c => c.avatar === cardInfo.avatar && c.grade === cardInfo.grade && !c.used);
            if (deckCard) deckCard.used = true;
        }

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

        // Clear timer to prevent overlapping loops when auto-pick executes
        clearTimeout(room.timer);

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        const forcePick = (pId) => {
            const pData = room.playerData[pId];
            if (!pData.ready && pData.deck) {
                const avail = pData.deck.filter(c => !c.used);
                if (avail.length > 0) {
                    const pick = avail[Math.floor(Math.random() * avail.length)];
                    pick.used = true;
                    pData.card = pick;
                    pData.ready = true;
                }
            }
        };

        // If not ready, server autonomously picks to prevent hanging logic if client disconnected/backgrounded
        if (!room.playerData[p1Id].ready || !room.playerData[p2Id].ready) {
            forcePick(p1Id);
            forcePick(p2Id);
            resolveRound(roomId);
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

        // After 6 seconds (to allow frontend animations to finish), server autonomously starts the next round 
        // IF the match hasn't naturally ended. This prevents duplicate client requests.
        setTimeout(() => {
            if (rooms[roomId]) { // Check if match wasn't destroyed
                const isExpert = (room.mode === 'Expert');
                const maxRounds = isExpert ? 7 : 5;
                const maxWins = isExpert ? 4 : 3;

                // Match end condition checked defensively before automatically queuing the next turn
                if (room.round <= maxRounds && room.playerData[p1Id].matchWins < maxWins && room.playerData[p2Id].matchWins < maxWins) {
                    startRound(roomId);
                }
            }
        }, 6000);
    };

    // MATCH ENDED (Client sends result)
    socket.on('match_end', ({ roomId, winnerId }) => {
        const room = rooms[roomId];
        if (!room) return;

        // Prevent late timer triggers from spawning a new round after match concludes
        clearTimeout(room.timer);

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
            io.to(roomId).emit('room_closed', { reason: '상대방이 재대결을 거절했습니다.' });
            delete rooms[roomId];
            return;
        }

        const p1Id = room.players[0];
        const p2Id = room.players[1];

        if (room.playerData[p1Id].rematchVote === true && room.playerData[p2Id].rematchVote === true) {
            // Rematch accepted
            room.round = 1;
            // Clear prev decks to enforce new shuffle
            room.playerData[p1Id].deck = null;
            room.playerData[p2Id].deck = null;
            io.to(roomId).emit('rematch_accepted');
            // Client will receive rematch_accepted, run startPvpGame(), and send a new deck
        }
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);

        // Remove from global lobby
        if (globalUsers[socket.id]) {
            delete globalUsers[socket.id];
            io.emit('update_user_list', Object.values(globalUsers));
        }

        // Remove from queue
        waitingQueue = waitingQueue.filter(p => p.id !== socket.id);

        handleTourneyLeave(socket.id);

        // Remove from rooms and notify opponent
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.players.includes(socket.id)) {
                const remainingPlayerId = room.players.find(id => id !== socket.id);
                if (remainingPlayerId) {
                    io.to(remainingPlayerId).emit('complete_victory', {
                        winnerId: remainingPlayerId,
                        reason: '상대방이 접속을 종료하여 게임에서 승리했습니다!'
                    });
                }
                delete rooms[roomId];
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Chrono Link PVP Server running on port ${PORT}`);
});
