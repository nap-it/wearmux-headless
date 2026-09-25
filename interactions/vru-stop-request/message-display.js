class MessageDisplay {
    constructor(session) {
        this.session = session;
    }

    async show(text) {
        const message = String(text || "").trim();
        if (!message) throw new Error("A non-empty prompt is required");
        await this.session.dispatchAction({ action: "display.text", text: message.slice(0, 500) });
    }

    async clear() {
        await this.session.dispatchAction({ action: "display.clear" });
    }
}

module.exports = { MessageDisplay };
