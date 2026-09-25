const { randomUUID } = require("crypto");
const { createPublisher, createSubscriber, selectedTransport } = require("../utils/transport");
const { ACTION_TOPIC, RESULT_TOPIC } = require("../utils/action-dispatcher");

async function main() {
    const raw = process.argv[2];
    if (!raw) {
        console.error('Usage: npm run actions:send -- \'{"action":"display.text","text":"Hello"}\'');
        process.exitCode = 1;
        return;
    }
    const command = JSON.parse(raw);
    if (!command || typeof command !== "object" || Array.isArray(command)) {
        throw new Error("Action must be a JSON object");
    }
    if (selectedTransport() === "none") {
        throw new Error("Set MESSAGE_TRANSPORT=mqtt or MESSAGE_TRANSPORT=zenoh");
    }
    if (command.id !== undefined && (typeof command.id !== "string" || !command.id)) {
        throw new Error("id must be a nonempty string");
    }
    command.id ||= randomUUID();
    const publisher = createPublisher({
        keyPrefix: ACTION_TOPIC,
    });
    const subscriber = createSubscriber({
        topicFilter: RESULT_TOPIC,
    });
    publisher.on("error", (error) => console.warn("[Actions]", error?.message || error));
    subscriber.on("error", (error) => console.warn("[Actions]", error?.message || error));
    let timer;
    let onMessage;
    try {
        await subscriber.start();
        await publisher.start();
        const resultPromise = new Promise((resolve, reject) => {
            onMessage = ({ key, payload }) => {
                if (key === RESULT_TOPIC && payload?.id === command.id) resolve(payload);
            };
            subscriber.on("message", onMessage);
            timer = setTimeout(() => reject(new Error("No action result received within 30 seconds")), 30_000);
        });
        await publisher.publish(ACTION_TOPIC, command);
        const result = await resultPromise;
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
    } finally {
        clearTimeout(timer);
        if (onMessage) subscriber.off("message", onMessage);
        await Promise.allSettled([publisher.stop(), subscriber.stop()]);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error("[Actions]", error?.message || error);
        process.exitCode = 1;
    });
}
