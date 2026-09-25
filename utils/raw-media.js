const { randomUUID } = require("crypto");
const { topic } = require("./topics");

// Send binary media as a metadata record followed by ordered base64 chunks.
async function publishRawMedia(publisher, modality, buffer, meta) {
    const frameId = `${meta.device?.id || "device"}-${randomUUID()}`;
    const encoded = buffer.toString("base64");
    const chunkSize = Math.max(1024, Number(process.env.RAW_CHUNK_SIZE || 30000));
    const totalChunks = Math.ceil(encoded.length / chunkSize);
    // A unique frame ID lets consumers reassemble interleaved streams from several devices.
    await publisher.publish(topic(modality, "raw", "meta"), {
        ts: Date.now(), frameId, totalChunks, encoding: "base64", bytes: buffer.length, ...meta,
    });
    for (let idx = 0; idx < totalChunks; idx++) {
        await publisher.publish(topic(modality, "raw", "chunk"), {
            ts: Date.now(), frameId, device: meta.device, idx,
            data: encoded.slice(idx * chunkSize, (idx + 1) * chunkSize),
        });
    }
}

module.exports = { publishRawMedia };
