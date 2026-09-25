function topic(...parts) {
    const prefix = (process.env.TOPIC_PREFIX || "bwear").trim().replace(/^\/+|\/+$/g, "");
    if (!prefix) throw new Error("TOPIC_PREFIX must not be empty");
    return [prefix, ...parts].join("/");
}

module.exports = { topic };
