const { MessageDisplay } = require("../message-display");

test.each([
    "Should the vehicle continue stopping? Nod yes; shake no.",
    "Keep vehicle stopped?",
    "Do you want me to stop? Answer yes (keep stopping) or no (send DENM back).",
])("updates the legacy question without gesture instructions: %s", async (question) => {
    const session = { dispatchAction: jest.fn().mockResolvedValue(undefined) };
    await new MessageDisplay(session).show(question);
    expect(session.dispatchAction).toHaveBeenCalledWith({ action: "display.prompt", text: "Should I stop?" });
});

test("preserves custom question meaning and does not silently truncate", async () => {
    const session = { dispatchAction: jest.fn().mockResolvedValue(undefined) };
    const display = new MessageDisplay(session);
    const question = "Should the vehicle resume moving?";
    await display.show(`  ${question}\nNod yes; shake no.  `);
    expect(session.dispatchAction).toHaveBeenLastCalledWith({ action: "display.prompt", text: question });
    const longQuestion = "x".repeat(501);
    await display.show(longQuestion);
    expect(session.dispatchAction).toHaveBeenLastCalledWith({ action: "display.prompt", text: longQuestion });
});

test("clears through the same serialized action path", async () => {
    const session = { dispatchAction: jest.fn().mockResolvedValue(undefined) };
    await new MessageDisplay(session).clear();
    expect(session.dispatchAction).toHaveBeenCalledWith({ action: "display.clear" });
});
