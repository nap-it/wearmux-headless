/**
 * Join a modality or action path beneath TOPIC_PREFIX, read at each call.
 * Leading/trailing slashes are removed from the root, but path parts are not normalized.
 * @param {...string} parts Topic path components, such as sensors and acceleration.
 * @returns {string} Topic/key with the default bwear root when TOPIC_PREFIX is unset.
 * @throws {Error} When the trimmed topic root is empty.
 * @example
 * const { topic } = require('./utils/topics');
 * console.log(topic('sensors', 'acceleration')); // bwear/sensors/acceleration
 */
function topic(...parts) {
    const prefix = (process.env.TOPIC_PREFIX || "bwear").trim().replace(/^\/+|\/+$/g, "");
    if (!prefix) throw new Error("TOPIC_PREFIX must not be empty");
    return [prefix, ...parts].join("/");
}

module.exports = { topic };
