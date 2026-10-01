const EventEmitter = require("events");
jest.mock("../../../utils/transport", () => ({
    createSubscriber: jest.fn(),
    selectedTransport: () => "mqtt",
}));
const { createSubscriber } = require("../../../utils/transport");
const { NodDetector } = require("../nod-detector");
const { VruStopRequestInteraction, ANSWER_TOPIC } = require("..");

let interaction, session, publisher, classifier;
beforeEach(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const subscriber = new EventEmitter();
    subscriber.start = jest.fn().mockResolvedValue();
    subscriber.stop = jest.fn().mockResolvedValue();
    createSubscriber.mockReturnValue(subscriber);
    classifier = {
        getProperties: () => ({ interval_ms: 20, input_features_count: 150 }),
        classify: jest.fn(() => ({ results: [{ label: "2_shake", value: 0.9 }] })),
    };
    jest.spyOn(NodDetector, "loadClassifier").mockResolvedValue(classifier);
    const sensors = new EventEmitter();
    sensors.getEnabledSensors = () => ["acceleration"];
    session = {
        ready: true, device: { isConnected: true }, info: { id: "glasses" },
        capabilities: { display: true, sensors: ["acceleration"] }, sensors,
        dispatchAction: jest.fn().mockResolvedValue(),
    };
    publisher = { publish: jest.fn().mockResolvedValue() };
    interaction = new VruStopRequestInteraction({ publisher, getSessions: () => [session] });
    await interaction.start();
});
afterEach(async () => {
    await interaction.stop();
    jest.restoreAllMocks();
    jest.clearAllTimers();
});
function samples(start = 0) {
    for (let i = start; i < start + 50; i++) {
        session.sensors.emit("acceleration", {
            message: { timestamp: 1000 + i * 20, acceleration: { x: 0, y: 0, z: 1 } },
        });
    }
}
function answerPublishes() {
    return publisher.publish.mock.calls.filter(([topic]) => topic === ANSWER_TOPIC);
}

test.each([["1_nod", "yes"], ["2_shake", "no"]])("%s answers only after display, with the original prompt ID", async (label, answer) => {
    classifier.classify.mockReturnValue({ results: [{ label, value: 0.9 }] });
    let finishDisplay;
    session.dispatchAction.mockImplementationOnce(() => new Promise((resolve) => { finishDisplay = resolve; }));
    const showing = interaction.handlePrompt({ prompt_id: "one", question: "Should I stop?" });
    samples();
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(answerPublishes()).toHaveLength(0);
    finishDisplay();
    await showing;
    samples(50);
    samples(100);
    await jest.advanceTimersByTimeAsync(0);
    expect(answerPublishes()).toHaveLength(1);
    expect(publisher.publish).toHaveBeenCalledWith(ANSWER_TOPIC, expect.objectContaining({ prompt_id: "one", answer }));
    expect(session.dispatchAction).toHaveBeenLastCalledWith({ action: "display.clear" });
    expect(interaction.active).toBeNull();
});

test("a timeout during display transfer never starts detection or publishes an answer", async () => {
    let finishDisplay;
    session.dispatchAction.mockImplementationOnce(() => new Promise((resolve) => { finishDisplay = resolve; }));
    const showing = interaction.handlePrompt({ prompt_id: "expired", timeout_s: 1 });
    await jest.advanceTimersByTimeAsync(501);
    finishDisplay();
    await showing;
    samples();
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(answerPublishes()).toHaveLength(0);
    expect(session.sensors.listenerCount("acceleration")).toBe(0);
});

test("model failure clears the question and leaves the handler's timeout policy in control", async () => {
    classifier.classify.mockImplementation(() => { throw new Error("bad model"); });
    await interaction.handlePrompt({ prompt_id: "one" });
    samples();
    await jest.advanceTimersByTimeAsync(0);
    expect(answerPublishes()).toHaveLength(0);
    expect(session.dispatchAction).toHaveBeenLastCalledWith({ action: "display.clear" });
    expect(interaction.active).toBeNull();
});
