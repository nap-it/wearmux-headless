#!/usr/bin/env node
// Standalone MQTT broker using Aedes.
// Mirrors the Docker Zenoh router pattern but runs as a plain Node process.
//
// Env vars:
//   MQTT_BROKER_PORT   Port to listen on (default: 1883)
//   MQTT_BROKER_HOST   Bind address (default: 0.0.0.0)

const Aedes = require("aedes");
const net = require("net");

const PORT = Number(process.env.MQTT_BROKER_PORT) || 1883;
const HOST = process.env.MQTT_BROKER_HOST || "0.0.0.0";

const aedes = Aedes();
const server = net.createServer(aedes.handle);

aedes.on("client", (client) => {
    console.log(`[mqtt-broker] client connected: ${client?.id}`);
});
aedes.on("clientDisconnect", (client) => {
    console.log(`[mqtt-broker] client disconnected: ${client?.id}`);
});
aedes.on("publish", (packet, client) => {
    if (!client) return;
    console.log(`[mqtt-broker] publish ${packet.topic} (${packet.payload?.length ?? 0} bytes) from ${client.id}`);
});
aedes.on("subscribe", (subs, client) => {
    const topics = subs.map((s) => s.topic).join(", ");
    console.log(`[mqtt-broker] ${client?.id} subscribed: ${topics}`);
});

server.listen(PORT, HOST, () => {
    console.log(`[mqtt-broker] listening on mqtt://${HOST}:${PORT}`);
});

const shutdown = () => {
    console.log("\n[mqtt-broker] shutting down...");
    server.close(() => {
        aedes.close(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
