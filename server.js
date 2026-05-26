const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

let worker;
let router;
let announcedIp;

// Global registries
const transports = {};
const producers = {};
const consumers = {};

// Active state registries tracking real-time ERP metadata
const users = {}; // Format: { [socketId]: { name, teamId } }
const teams = []; // Format: [ { id, name, members: [socketId, ...] } ]

// Per-socket resource tracking for cleanup on disconnect
const socketData = {};

async function getPublicIp() {
  console.log("[DEBUG] [IP] Requesting public IP address...");
  const https = require("https");
  return new Promise((resolve) => {
    https.get("https://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const ip = data.trim();
        console.log(`[DEBUG] [IP] Successfully resolved public IP: ${ip}`);
        resolve(ip);
      });
    }).on("error", (err) => {
      console.warn(`[DEBUG] [IP] Error resolving public IP, defaulting to localhost: ${err.message}`);
      resolve("127.0.0.1");
    });
  });
}

async function startMediasoup() {
  console.log("[DEBUG] [MEDIASOUP] Starting Mediasoup SFU setup...");
  announcedIp = process.env.ANNOUNCED_IP || await getPublicIp();
  console.log(`[✓] Using announcedIp: ${announcedIp}`);

  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 20000,
    rtcMaxPort: 20100,
  });

  console.log(`[DEBUG] [MEDIASOUP] Worker successfully created. PID: ${worker.pid}`);

  worker.on("died", () => {
    console.error("[DEBUG] [MEDIASOUP] CRITICAL ERROR: mediasoup worker died, exiting process.");
    process.exit(1);
  });

  const mediaCodecs = [
    {
      kind: "audio",
      mimeType: "audio/opus",
      clockRate: 48000,
      channels: 2,
    },
  ];

  router = await worker.createRouter({ mediaCodecs });
  console.log("[✓] Mediasoup SFU Router initialized.");
  console.log(`[DEBUG] [MEDIASOUP] Router ID: ${router.id}`);
}

// Helper: Broadcast unified user/team state matrix to all connected ERP sockets
function sendStateUpdate() {
  console.log("[DEBUG] [STATE] Broadcasting updated state map...");
  console.log(`[DEBUG] [STATE] Active Users count: ${Object.keys(users).length}`);
  console.log(`[DEBUG] [STATE] Active Teams count: ${teams.length}`);
  io.emit("state-broadcast", { users, teams });
}

// Start socket handling only AFTER router is ready to avoid race conditions
startMediasoup()
  .then(() => {
    console.log("[DEBUG] [SOCKET] SFU fully prepared. Configuring Socket.io listeners...");
    
    io.on("connection", (socket) => {
      console.log(`[+] [SOCKET] Client connected. Socket ID: ${socket.id}`);

      socketData[socket.id] = {
        transportIds: [],
        producerIds: [],
        consumerIds: [],
      };
      
      console.log(`[DEBUG] [SOCKET] Allocated socket resource tracker for ${socket.id}`);

      // Send router capabilities to client immediately upon connection
      console.log(`[DEBUG] [SOCKET] Dispatching routerRtpCapabilities to ${socket.id}`);
      socket.emit("routerRtpCapabilities", router.rtpCapabilities);

      /* ─── ERP Context & Identity Mapping ─── */
      socket.on("sync-profile-context", ({ name, teamId }) => {
        console.log(`[DEBUG] [PROFILE] 'sync-profile-context' requested by ${socket.id}. Name: "${name}", Team ID: "${teamId}"`);
        
        users[socket.id] = { name, teamId: teamId || null };
        if (teamId) {
          console.log(`[DEBUG] [PROFILE] Socket ${socket.id} joining room channel: ${teamId}`);
          socket.join(teamId);
          const targetTeam = teams.find((t) => t.id === teamId);
          if (targetTeam) {
            if (!targetTeam.members.includes(socket.id)) {
              targetTeam.members.push(socket.id);
              console.log(`[DEBUG] [PROFILE] Added socket ${socket.id} to member list of team ${teamId}`);
            } else {
              console.log(`[DEBUG] [PROFILE] Socket ${socket.id} already exists in member list of team ${teamId}`);
            }
          } else {
            console.warn(`[DEBUG] [PROFILE] Warning: Target team ${teamId} not found in registered teams.`);
          }
        }
        sendStateUpdate();
      });

      socket.on("cmd-create-team", ({ name }) => {
        const teamId = "team-" + Date.now();
        console.log(`[DEBUG] [TEAM] 'cmd-create-team' action called by ${socket.id}. Requested name: "${name}". Generated ID: ${teamId}`);
        const newTeam = { id: teamId, name, members: [socket.id] };

        // Remove from current team rooms first if any
        if (users[socket.id] && users[socket.id].teamId) {
          const oldTeamId = users[socket.id].teamId;
          console.log(`[DEBUG] [TEAM] Socket ${socket.id} is leaving existing team ${oldTeamId} prior to creating a new one.`);
          socket.leave(oldTeamId);
          const oldTeam = teams.find((t) => t.id === oldTeamId);
          if (oldTeam) {
            oldTeam.members = oldTeam.members.filter((m) => m !== socket.id);
            console.log(`[DEBUG] [TEAM] Removed ${socket.id} from former team list of ${oldTeamId}`);
          }
        }

        teams.push(newTeam);
        if (users[socket.id]) {
          users[socket.id].teamId = teamId;
        }

        socket.join(teamId);
        console.log(`[DEBUG] [TEAM] Socket ${socket.id} joined room channel for new team ${teamId}`);
        sendStateUpdate();
      });

      socket.on("cmd-join-team", ({ teamId }) => {
        console.log(`[DEBUG] [TEAM] 'cmd-join-team' called by ${socket.id} for target team: ${teamId}`);
        
        // Clear previous team mapping dependencies
        if (users[socket.id] && users[socket.id].teamId) {
          const oldTeamId = users[socket.id].teamId;
          console.log(`[DEBUG] [TEAM] Socket ${socket.id} is leaving previous team ${oldTeamId}`);
          socket.leave(oldTeamId);
          const oldTeam = teams.find((t) => t.id === oldTeamId);
          if (oldTeam) {
            oldTeam.members = oldTeam.members.filter((m) => m !== socket.id);
            console.log(`[DEBUG] [TEAM] Removed ${socket.id} from former team list of ${oldTeamId}`);
          }
        }

        const targetTeam = teams.find((t) => t.id === teamId);
        if (targetTeam) {
          if (!targetTeam.members.includes(socket.id)) {
            targetTeam.members.push(socket.id);
            console.log(`[DEBUG] [TEAM] Added ${socket.id} to member list of team ${teamId}`);
          }
        } else {
          console.warn(`[DEBUG] [TEAM] Failed to find target team ${teamId} during join command.`);
        }

        if (users[socket.id]) {
          users[socket.id].teamId = teamId;
        }

        socket.join(teamId);
        console.log(`[DEBUG] [TEAM] Socket ${socket.id} joined room channel ${teamId}`);
        sendStateUpdate();
      });

      socket.on("cmd-leave-team", () => {
        console.log(`[DEBUG] [TEAM] 'cmd-leave-team' executed by socket: ${socket.id}`);
        if (users[socket.id] && users[socket.id].teamId) {
          const oldTeamId = users[socket.id].teamId;
          socket.leave(oldTeamId);
          console.log(`[DEBUG] [TEAM] Socket ${socket.id} left room channel ${oldTeamId}`);
          const oldTeam = teams.find((t) => t.id === oldTeamId);
          if (oldTeam) {
            oldTeam.members = oldTeam.members.filter((m) => m !== socket.id);
            console.log(`[DEBUG] [TEAM] Cleaned up socket from previous member array for ${oldTeamId}`);
          }
          users[socket.id].teamId = null;
        } else {
          console.log(`[DEBUG] [TEAM] Socket ${socket.id} had no active team workspace mapped.`);
        }
        sendStateUpdate();
      });

      /* ─── Push-To-Talk Realtime Signaling ─── */
      socket.on("ptt-signal-send-start", ({ scope, targetId }) => {
        console.log(`[DEBUG] [PTT] 'ptt-signal-send-start' request received. Sender: ${socket.id}, Scope: "${scope}", TargetId: "${targetId}"`);
        
        // Direct Whisper routes to specific socket, Team Radio routes to specific project room
        if (scope === "direct") {
          console.log(`[DEBUG] [PTT] Routing direct whisper to socket ID: ${targetId}`);
          socket.to(targetId).emit("ptt-signal-start", {
            senderSocketId: socket.id,
            scope,
            targetId,
          });
        } else if (scope === "team") {
          console.log(`[DEBUG] [PTT] Routing team broadcast to room ID: ${targetId}`);
          socket.to(targetId).emit("ptt-signal-start", {
            senderSocketId: socket.id,
            scope,
            targetId,
          });
        } else {
          console.warn(`[DEBUG] [PTT] Unsupported PTT scope encountered: "${scope}"`);
        }
      });

      socket.on("ptt-signal-send-stop", () => {
        console.log(`[DEBUG] [PTT] 'ptt-signal-send-stop' requested by: ${socket.id}`);
        const user = users[socket.id];
        if (user && user.teamId) {
          console.log(`[DEBUG] [PTT] Broadcasting stop signal to team room: ${user.teamId}`);
          socket
            .to(user.teamId)
            .emit("ptt-signal-stop", { senderSocketId: socket.id });
        } else {
          console.log(`[DEBUG] [PTT] Socket ${socket.id} has no mapped team to signal stop. Informing all connections via broadcast.`);
        }
        // Always fallback broadcast across all nodes to ensure clean global state termination
        socket.broadcast.emit("ptt-signal-stop", { senderSocketId: socket.id });
      });

      /* ─── WebRTC Transport Routines ─── */
      socket.on("createWebRtcTransport", async ({ sender }, callback) => {
        console.log(`[DEBUG] [WEBRTC] 'createWebRtcTransport' request received from ${socket.id}. Sender role: ${sender}`);
        try {
          const transport = await router.createWebRtcTransport({
            listenIps: [
              {
                ip: "0.0.0.0",
                announcedIp,
              },
            ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
          });

          console.log(`[DEBUG] [WEBRTC] WebRtcTransport created. ID: ${transport.id}`);

          transports[transport.id] = transport;
          socketData[socket.id].transportIds.push(transport.id);

          console.log(`[DEBUG] [WEBRTC] Registered transport mapping for client: ${socket.id}`);

          callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          });
        } catch (err) {
          console.error(`[DEBUG] [WEBRTC] Error creating WebRtcTransport: ${err.message}`, err);
          callback({ error: err.message });
        }
      });

      socket.on(
        "transport-connect",
        async ({ transportId, dtlsParameters }) => {
          console.log(`[DEBUG] [WEBRTC] 'transport-connect' for transport: ${transportId} from client: ${socket.id}`);
          const transport = transports[transportId];
          if (transport) {
            try {
              await transport.connect({ dtlsParameters });
              console.log(`[DEBUG] [WEBRTC] Successfully connected transport: ${transportId}`);
            } catch (err) {
              console.error(`[DEBUG] [WEBRTC] transport-connect execution error: ${err.message}`, err);
            }
          } else {
            console.warn(`[DEBUG] [WEBRTC] Transport connection failed. Transport ID not found: ${transportId}`);
          }
        },
      );

      socket.on(
        "transport-produce",
        async ({ transportId, kind, rtpParameters }, callback) => {
          console.log(`[DEBUG] [WEBRTC] 'transport-produce' request on transport ${transportId}. Kind: ${kind}, Sender: ${socket.id}`);
          try {
            const transport = transports[transportId];
            if (!transport) {
              console.warn(`[DEBUG] [WEBRTC] Produce failed: Transport ID ${transportId} does not exist`);
              return callback({ error: "Transport not found" });
            }

            const producer = await transport.produce({ kind, rtpParameters });
            console.log(`[DEBUG] [WEBRTC] Producer established on server. Producer ID: ${producer.id}`);

            // Map producer identity back to its originating socket ID
            producers[producer.id] = {
              producerInstance: producer,
              ownerSocketId: socket.id,
            };
            socketData[socket.id].producerIds.push(producer.id);

            callback({ id: producer.id });

            // Distribute new incoming feed notices *only* to appropriate project scope boundaries
            const user = users[socket.id];
            if (user && user.teamId) {
              console.log(`[DEBUG] [WEBRTC] Broadcasting 'new-producer' event for ID: ${producer.id} to team room: ${user.teamId}`);
              socket
                .to(user.teamId)
                .emit("new-producer", { producerId: producer.id });
            } else {
              console.log(`[DEBUG] [WEBRTC] User not in team; broadcasting 'new-producer' event globally for ID: ${producer.id}`);
              socket.broadcast.emit("new-producer", {
                producerId: producer.id,
              });
            }
          } catch (err) {
            console.error(`[DEBUG] [WEBRTC] transport-produce execution error: ${err.message}`, err);
            callback({ error: err.message });
          }
        },
      );

      socket.on(
        "transport-consume",
        async ({ transportId, producerId, rtpCapabilities }, callback) => {
          console.log(`[DEBUG] [WEBRTC] 'transport-consume' requested by ${socket.id} for Producer ${producerId} on Transport ${transportId}`);
          try {
            const producerRecord = producers[producerId];
            if (!producerRecord) {
              console.warn(`[DEBUG] [WEBRTC] Consume request failed: Producer context for ID ${producerId} does not exist`);
              return callback({ error: "Target producer context missing" });
            }

            if (!router.canConsume({ producerId, rtpCapabilities })) {
              console.warn(`[DEBUG] [WEBRTC] Router cannot consume track from Producer ID: ${producerId}`);
              return callback({ error: "Cannot consume" });
            }

            const transport = transports[transportId];
            if (!transport) {
              console.warn(`[DEBUG] [WEBRTC] Consume request failed: Transport ID ${transportId} does not exist`);
              return callback({ error: "Transport not found" });
            }

            const consumer = await transport.consume({
              producerId,
              rtpCapabilities,
              paused: false,
            });

            console.log(`[DEBUG] [WEBRTC] Consumer established. Consumer ID: ${consumer.id}, Mapping to owner: ${producerRecord.ownerSocketId}`);

            consumers[consumer.id] = consumer;
            socketData[socket.id].consumerIds.push(consumer.id);

            callback({
              id: consumer.id,
              producerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              ownerSocketId: producerRecord.ownerSocketId, // CRITICAL: Tells client who owns the stream
            });
          } catch (err) {
            console.error(`[DEBUG] [WEBRTC] transport-consume execution error: ${err.message}`, err);
            callback({ error: err.message });
          }
        },
      );

      socket.on("get-producers", (callback) => {
        console.log(`[DEBUG] [WEBRTC] 'get-producers' requested by ${socket.id}`);
        const user = users[socket.id];
        
        // Filter down to only output producers belonging to the user's active team space
        const relevantProducerIds = Object.keys(producers).filter((pid) => {
          const ownerId = producers[pid].ownerSocketId;
          if (ownerId === socket.id) return false; // Skip self
          if (!user || !user.teamId) {
            console.log(`[DEBUG] [WEBRTC] Including Producer ${pid} (Owner: ${ownerId}) for user ${socket.id} (Lobby environment fallback)`);
            return true; // If lobby fallback, share all paths
          }
          
          const isSameTeam = users[ownerId] && users[ownerId].teamId === user.teamId;
          if (isSameTeam) {
            console.log(`[DEBUG] [WEBRTC] Including Producer ${pid} (Owner: ${ownerId}) for user ${socket.id} (Matching Team Space: ${user.teamId})`);
          }
          return isSameTeam;
        });

        console.log(`[DEBUG] [WEBRTC] Returning ${relevantProducerIds.length} relevant producers to socket ${socket.id}`);
        callback(relevantProducerIds);
      });

      /* ─── Resource Disconnect Teardown Cleanups ─── */
      socket.on("disconnect", () => {
        console.log(`[-] [SOCKET] Client disconnected. Socket ID: ${socket.id}`);
        const data = socketData[socket.id];

        // Clean metadata registries
        delete users[socket.id];
        teams.forEach((t) => {
          const origLength = t.members.length;
          t.members = t.members.filter((m) => m !== socket.id);
          if (t.members.length !== origLength) {
            console.log(`[DEBUG] [CLEANUP] Removed socket ${socket.id} from team ID: ${t.id}`);
          }
        });
        sendStateUpdate();

        if (!data) {
          console.log(`[DEBUG] [CLEANUP] No tracked WebRTC resources registered for ${socket.id}. Cleanup completed.`);
          return;
        }

        console.log(`[DEBUG] [CLEANUP] Commencing cleanup of WebRTC entities for disconnected socket ${socket.id}...`);

        // Gracefully terminate low-level WebRTC objects to prevent server VRAM leaks
        for (const consumerId of data.consumerIds) {
          if (consumers[consumerId]) {
            console.log(`[DEBUG] [CLEANUP] Closing consumer ${consumerId}`);
            consumers[consumerId].close();
            delete consumers[consumerId];
          }
        }
        
        for (const producerId of data.producerIds) {
          if (producers[producerId]) {
            console.log(`[DEBUG] [CLEANUP] Closing producer ${producerId}`);
            producers[producerId].producerInstance.close();
            delete producers[producerId];
            
            // Notify active tracking layers to clean up the closed track line
            console.log(`[DEBUG] [CLEANUP] Broadcasting 'producer-closed' notification for ${producerId}`);
            io.emit("producer-closed", { producerId });
          }
        }
        
        for (const transportId of data.transportIds) {
          if (transports[transportId]) {
            console.log(`[DEBUG] [CLEANUP] Closing transport ${transportId}`);
            transports[transportId].close();
            delete transports[transportId];
          }
        }
        
        delete socketData[socket.id];
        console.log(`[DEBUG] [CLEANUP] Completed WebRTC entity teardown for disconnected socket ${socket.id}`);
      });
    });

    server.listen(process.env.PORT || 3000, () =>
      console.log(`SFU Voice Server running on port ${process.env.PORT || 3000}`),
    );
  })
  .catch((err) => {
    console.error("Failed to start mediasoup:", err);
    process.exit(1);
  });