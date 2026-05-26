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
  const https = require("https");
  return new Promise((resolve) => {
    https.get("https://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim()));
    }).on("error", () => resolve("127.0.0.1"));
  });
}

async function startMediasoup() {
  announcedIp = process.env.ANNOUNCED_IP || await getPublicIp();
  console.log(`[✓] Using announcedIp: ${announcedIp}`);

  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: 20000,
    rtcMaxPort: 20100,
  });

  worker.on("died", () => {
    console.error("mediasoup worker died, exiting");
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
}

// Helper: Broadcast unified user/team state matrix to all connected ERP sockets
function sendStateUpdate() {
  io.emit("state-broadcast", { users, teams });
}

// Start socket handling only AFTER router is ready to avoid race conditions
startMediasoup()
  .then(() => {
    io.on("connection", (socket) => {
      console.log("[+]", socket.id);

      socketData[socket.id] = {
        transportIds: [],
        producerIds: [],
        consumerIds: [],
      };

      // Send router capabilities to client immediately upon connection
      socket.emit("routerRtpCapabilities", router.rtpCapabilities);

      /* ─── ERP Context & Identity Mapping ─── */
      socket.on("sync-profile-context", ({ name, teamId }) => {
        users[socket.id] = { name, teamId: teamId || null };
        if (teamId) {
          socket.join(teamId);
          const targetTeam = teams.find((t) => t.id === teamId);
          if (targetTeam && !targetTeam.members.includes(socket.id)) {
            targetTeam.members.push(socket.id);
          }
        }
        sendStateUpdate();
      });

      socket.on("cmd-create-team", ({ name }) => {
        const teamId = "team-" + Date.now();
        const newTeam = { id: teamId, name, members: [socket.id] };

        // Remove from current team rooms first if any
        if (users[socket.id] && users[socket.id].teamId) {
          const oldTeamId = users[socket.id].teamId;
          socket.leave(oldTeamId);
          const oldTeam = teams.find((t) => t.id === oldTeamId);
          if (oldTeam)
            oldTeam.members = oldTeam.members.filter((m) => m !== socket.id);
        }

        teams.push(newTeam);
        if (users[socket.id]) users[socket.id].teamId = teamId;

        socket.join(teamId);
        sendStateUpdate();
      });

      socket.on("cmd-join-team", ({ teamId }) => {
        // Clear previous team mapping dependencies
        if (users[socket.id] && users[socket.id].teamId) {
          const oldTeamId = users[socket.id].teamId;
          socket.leave(oldTeamId);
          const oldTeam = teams.find((t) => t.id === oldTeamId);
          if (oldTeam)
            oldTeam.members = oldTeam.members.filter((m) => m !== socket.id);
        }

        const targetTeam = teams.find((t) => t.id === teamId);
        if (targetTeam && !targetTeam.members.includes(socket.id)) {
          targetTeam.members.push(socket.id);
        }

        if (users[socket.id]) users[socket.id].teamId = teamId;

        socket.join(teamId);
        sendStateUpdate();
      });

      socket.on("cmd-leave-team", () => {
        if (users[socket.id] && users[socket.id].teamId) {
          const oldTeamId = users[socket.id].teamId;
          socket.leave(oldTeamId);
          const oldTeam = teams.find((t) => t.id === oldTeamId);
          if (oldTeam)
            oldTeam.members = oldTeam.members.filter((m) => m !== socket.id);
          users[socket.id].teamId = null;
        }
        sendStateUpdate();
      });

      /* ─── Push-To-Talk Realtime Signaling ─── */
      socket.on("ptt-signal-send-start", ({ scope, targetId }) => {
        // Direct Whisper routes to specific socket, Team Radio routes to specific project room
        if (scope === "direct") {
          socket.to(targetId).emit("ptt-signal-start", {
            senderSocketId: socket.id,
            scope,
            targetId,
          });
        } else if (scope === "team") {
          socket.to(targetId).emit("ptt-signal-start", {
            senderSocketId: socket.id,
            scope,
            targetId,
          });
        }
      });

      socket.on("ptt-signal-send-stop", () => {
        const user = users[socket.id];
        if (user && user.teamId) {
          socket
            .to(user.teamId)
            .emit("ptt-signal-stop", { senderSocketId: socket.id });
        }
        // Always fallback broadcast across all nodes to ensure clean global state termination
        socket.broadcast.emit("ptt-signal-stop", { senderSocketId: socket.id });
      });

      /* ─── WebRTC Transport Routines ─── */
      socket.on("createWebRtcTransport", async ({ sender }, callback) => {
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

          transports[transport.id] = transport;
          socketData[socket.id].transportIds.push(transport.id);

          callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          });
        } catch (err) {
          console.error("createWebRtcTransport error:", err.message);
          callback({ error: err.message });
        }
      });

      socket.on(
        "transport-connect",
        async ({ transportId, dtlsParameters }) => {
          const transport = transports[transportId];
          if (transport) {
            try {
              await transport.connect({ dtlsParameters });
            } catch (err) {
              console.error("transport-connect error:", err.message);
            }
          }
        },
      );

      socket.on(
        "transport-produce",
        async ({ transportId, kind, rtpParameters }, callback) => {
          try {
            const transport = transports[transportId];
            if (!transport) return callback({ error: "Transport not found" });

            const producer = await transport.produce({ kind, rtpParameters });

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
              socket
                .to(user.teamId)
                .emit("new-producer", { producerId: producer.id });
            } else {
              socket.broadcast.emit("new-producer", {
                producerId: producer.id,
              });
            }
          } catch (err) {
            console.error("transport-produce error:", err.message);
            callback({ error: err.message });
          }
        },
      );

      socket.on(
        "transport-consume",
        async ({ transportId, producerId, rtpCapabilities }, callback) => {
          try {
            const producerRecord = producers[producerId];
            if (!producerRecord)
              return callback({ error: "Target producer context missing" });

            if (!router.canConsume({ producerId, rtpCapabilities })) {
              return callback({ error: "Cannot consume" });
            }

            const transport = transports[transportId];
            if (!transport) return callback({ error: "Transport not found" });

            const consumer = await transport.consume({
              producerId,
              rtpCapabilities,
              paused: false,
            });

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
            console.error("transport-consume error:", err.message);
            callback({ error: err.message });
          }
        },
      );

      socket.on("get-producers", (callback) => {
        const user = users[socket.id];
        // Filter down to only output producers belonging to the user's active team space
        const relevantProducerIds = Object.keys(producers).filter((pid) => {
          const ownerId = producers[pid].ownerSocketId;
          if (ownerId === socket.id) return false; // Skip self
          if (!user || !user.teamId) return true; // If lobby fallback, share all paths
          return users[ownerId] && users[ownerId].teamId === user.teamId;
        });
        callback(relevantProducerIds);
      });

      /* ─── Resource Disconnect Teardown Cleanups ─── */
      socket.on("disconnect", () => {
        console.log("[-]", socket.id);
        const data = socketData[socket.id];

        // Clean metadata registries
        delete users[socket.id];
        teams.forEach(
          (t) => (t.members = t.members.filter((m) => m !== socket.id)),
        );
        sendStateUpdate();

        if (!data) return;

        // Gracefully terminate low-level WebRTC objects to prevent server VRAM leaks
        for (const consumerId of data.consumerIds) {
          if (consumers[consumerId]) {
            consumers[consumerId].close();
            delete consumers[consumerId];
          }
        }
        for (const producerId of data.producerIds) {
          if (producers[producerId]) {
            producers[producerId].producerInstance.close();
            delete producers[producerId];
            // Notify active tracking layers to clean up the closed track line
            io.emit("producer-closed", { producerId });
          }
        }
        for (const transportId of data.transportIds) {
          if (transports[transportId]) {
            transports[transportId].close();
            delete transports[transportId];
          }
        }
        delete socketData[socket.id];
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
