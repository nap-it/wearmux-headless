class MessageDisplay {
    constructor(session) {
        this.session = session;
    }

    async show(text) {
        // Keep custom questions intact while removing historical gesture hints
        // and updating the known stop-request questions from older handlers.
        let message = String(text || "").replace(/\s+/g, " ").trim();
        message = message.replace(/\s+Nod yes; shake no\.?$/i, "").trim();
        if ([
            "Should the vehicle continue stopping?",
            "Keep vehicle stopped?",
            "Do you want me to stop? Answer yes (keep stopping) or no (send DENM back).",
        ].includes(message)) {
            message = "Should I stop?";
        }
        if (!message) throw new Error("A non-empty prompt is required");
        await this.session.dispatchAction({ action: "display.prompt", text: message });
    }

    async clear() {
        await this.session.dispatchAction({ action: "display.clear" });
    }
}

module.exports = { MessageDisplay };
