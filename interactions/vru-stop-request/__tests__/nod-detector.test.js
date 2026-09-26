const EventEmitter = require("events");
const { NodDetector } = require("../nod-detector");

function setup(results = [{ label: "0_idle", value: 1 }]) {
    const sensors = new EventEmitter();
    sensors.getEnabledSensors = () => ["acceleration"];
    const classifier = {
        getProperties: () => ({ interval_ms: 20, input_features_count: 150 }),
        classify: jest.fn(() => ({ results })),
    };
    const detector = new NodDetector(sensors, { classifier, confidence: 0.6 });
    const answer = jest.fn();
    const fail = jest.fn();
    const emit = (index, acceleration = { x: index, y: 4, z: -4 }) => sensors.emit("acceleration", {
        message: { timestamp: 1000 + index * 20, acceleration },
    });
    return { sensors, classifier, detector, answer, fail, emit };
}

test("uses the model's full sample window, exact xyz ordering and scaling", () => {
    const { detector, emit, classifier, answer } = setup([{ label: "1_nod", value: 0.9 }]);
    detector.start(answer);
    for (let i = 0; i < 49; i++) emit(i);
    expect(classifier.classify).not.toHaveBeenCalled();
    emit(49);
    expect(classifier.classify).toHaveBeenCalledWith(Array.from({ length: 50 }, (_, i) => [i / 4, 1, -1]).flat());
    expect(answer).toHaveBeenCalledWith("nod", expect.objectContaining({ confidence: 0.9 }));
});

test.each([
    [[{ label: "0_idle", value: 0.99 }], null],
    [[{ label: "1_nod", value: 0.6 }], null],
    [[{ label: "2_shake", value: 0.59 }], null],
    [[{ label: "1_nod", value: 0.7 }, { label: "0_idle", value: 0.8 }], null],
    [[{ label: "1_nod", value: 0.91 }, { label: "2_shake", value: 0.09 }], "nod"],
    [[{ label: "2_shake", value: 0.92 }, { label: "1_nod", value: 0.08 }], "shake"],
])("accepts only a confident winning gesture: %j", (scores, expected) => {
    const { detector, emit, answer, sensors } = setup(scores);
    detector.start(answer);
    for (let i = 0; i < 75; i++) emit(i);
    if (expected) {
        expect(answer).toHaveBeenCalledTimes(1);
        expect(answer.mock.calls[0][0]).toBe(expected);
        expect(sensors.listenerCount("acceleration")).toBe(0);
    } else {
        expect(answer).not.toHaveBeenCalled();
        detector.stop();
    }
});

test("resets after a stream gap and ignores duplicate packets", () => {
    const { detector, emit, classifier, answer } = setup();
    detector.start(answer);
    for (let i = 0; i < 49; i++) emit(i);
    emit(48);
    expect(classifier.classify).not.toHaveBeenCalled();
    for (let i = 100; i < 149; i++) emit(i);
    expect(classifier.classify).not.toHaveBeenCalled();
    emit(149);
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    detector.stop();
});

test("invalid samples and new prompts cannot reuse an old window", () => {
    const { detector, emit, classifier, answer } = setup();
    detector.start(answer);
    for (let i = 0; i < 49; i++) emit(i);
    emit(49, { x: NaN, y: 1, z: 1 });
    for (let i = 50; i < 99; i++) emit(i);
    expect(classifier.classify).not.toHaveBeenCalled();
    detector.stop();
    emit(99);
    detector.start(answer);
    emit(100);
    expect(classifier.classify).not.toHaveBeenCalled();
    detector.stop();
});

test("inference failure stops detection and reports an error without answering", () => {
    const { detector, emit, classifier, answer, fail, sensors } = setup();
    classifier.classify.mockImplementation(() => { throw new Error("inference failed"); });
    detector.start(answer, fail);
    for (let i = 0; i < 60; i++) emit(i);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({ message: "inference failed" }));
    expect(answer).not.toHaveBeenCalled();
    expect(sensors.listenerCount("acceleration")).toBe(0);
});
