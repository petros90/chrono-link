# Chrono Link - V1.73 Development Log & Porting Guide

## 1. Project Overview
- **Name**: Chrono Link
- **Version**: v1.73 (Round Timer UX Sync & Anti-Mispick)
- **Framework**: HTML5, Vanilla JavaScript, CSS3
- **Server**: Node.js + Express + Socket.io (Hosted on Render)
- **Deployment**: `https://chrono-link.onrender.com`

---

## 2. Core Architecture & Resolution Log

### A. Tournament "Infinite Stalemate" (Match 2 Freeze) Resolved
The biggest blocker during v1.70 ~ v1.72 was the second match of any tournament round completely freezing after both players submitted cards.
**Root Causes & Fixes**:
1. **Server `matchWins` Increment Bug**: The server relied on `updatedMatch.playerData[p1Id].matchWins < 3`, but `matchWins` was never incremented on the server; it was only tracked locally. Fixed by implementing strict 5-element (Fire, Water, Earth, Wood, Metal) resolution rules directly inside `server.js`.
2. **Double Submit Race Condition**: If players clicked cards rapidly, `resolveTourneyRound` executed twice simultaneously. Fixed by introducing the `matchState.resolving = true` lock.
3. **Client Ghost Lock (`isBattling`)**: When the server sent `tourney_round_start`, the previous round's Javascript `sleep` animation was still running on the phone. This caused the client to accidentally flip `isBattling = false` and then `true` randomly, ignoring inputs.
    - **Fix**: Added a Critical Failsafe inside the `tourney_round_start` socket listener to forcefully unlock the UI (`isBattling = false; pvpTurnSubmitted = false;`).

### B. Round Timer UX Sync & Anti-Mispick (v1.73)
- **Issue**: The server timeout was aggressively changed, meaning a player could tap a card during the 3.5s intermission *before* the new round bar appeared, only to have their selection wiped when the actual `tourney_round_start` event arrived.
- **Fix**: The `isBattling` flag is now gracefully maintained as `true` through the end of a PVP interaction until the explicit `tourney_round_start` or `match_end` packet is received. Server timeout was optimized to `8000ms` for robust mobile rendering and client `sleep` was adjusted.

### C. Server Crash (Render Exited with status 1)
- **Issue**: When a player disconnected mid-tournament and a logic loop tried to read `socket.id` of an undefined player, Node.js threw an Uncaught Exception and restarted the server, terminating all active matches.
- **Fix**: Implemented `process.on('uncaughtException')` in `server.js` to trap errors, log them cleanly, and prevent the server from flatlining.

---

## 3. How to Port & Continue Development

To continue development on another computer, follow these exact steps:

### 1. Environment Setup
- Install **Node.js** (v18+ recommended).
- Clone the repository from Github:
  ```bash
  git clone https://github.com/petros90/chrono-link.git
  ```
- Install dependencies:
  ```bash
  cd chrono-link/server
  npm install
  ```

### 2. Local Testing
- Start the backend WebSockets server:
  ```bash
  cd chrono-link/server
  node server.js
  ```
- Start the frontend HTTP server (in the root `chrono-link` directory):
  ```bash
  python3 -m http.server 8081
  ```
- Access the game locally via `http://localhost:8081`. 

### 3. Deployment
- The project is linked to **Render** web services.
- Pushing to the `main` branch (`git push origin main`) will automatically trigger a deployment to `https://chrono-link.onrender.com`.

---

## 4. Current Remaining Tasks & Roadmap
- [ ] **Rankings/Leaderboard Display**: Currently, Firebase stores victories, but the in-game UI for leaderboard relies on placeholder elements.
- [ ] **Detailed Error Handling**: Continue bullet-proofing the `disconnect` logic in Tournaments to instantly forfeit users who drop connection, routing the remaining player to the next Bracket Node seamlessly.
- [ ] **Animation Polish**: Fine-tune the "Shatter" and "Drop-Shadow" CSS limits to prevent z-index glitching on older iOS Safari builds.
