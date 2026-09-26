const EdgeImpulseClassifier = require('../lib/ml/ei-classifier');

jest.useRealTimers();

describe('bundled BrilliantWear model', () => {
    const classifier = new EdgeImpulseClassifier();
    const another = new EdgeImpulseClassifier();
    let initialization;
    let exceptionListeners;
    let rejectionListeners;

    beforeAll(async () => {
        exceptionListeners = process.listeners('uncaughtException');
        rejectionListeners = process.listeners('unhandledRejection');
        initialization = classifier.init();
        expect(another.init()).toBe(initialization);
        await initialization;
    });

    test('loads one model without changing host error handlers', () => {
        expect(classifier.init()).toBe(initialization);
        expect(process.listeners('uncaughtException')).toEqual(exceptionListeners);
        expect(process.listeners('unhandledRejection')).toEqual(rejectionListeners);
    });

    test('exports the pinned model input contract and provenance', () => {
        expect(classifier.getProperties()).toMatchObject({
            frequency: 50,
            interval_ms: 20,
            frame_sample_count: 50,
            input_features_count: 150,
            labels: ['0_idle', '1_nod', '2_shake'],
            model_type: 'classification',
        });
        expect(classifier.getProjectInfo()).toMatchObject({
            id: 712496,
            name: 'Brilliant Frame gestures',
            owner: 'Zack Qattan',
            deploy_version: 1,
        });
        const properties = classifier.getProperties();
        properties.labels.push('changed');
        expect(classifier.getProperties().labels).toHaveLength(3);
    });

    test('classifies a complete window with the real WASM artifact', () => {
        const result = classifier.classify(new Float32Array(150));
        expect(result.results.map((r) => r.label)).toEqual(['0_idle', '1_nod', '2_shake']);
        expect(result.results.reduce((total, r) => total + r.value, 0)).toBeCloseTo(1, 2);
        for (const category of result.results) {
            expect(category.value).toBeGreaterThanOrEqual(0);
            expect(category.value).toBeLessThanOrEqual(1);
        }
    });

    test('rejects short windows and nonfinite input before native inference', () => {
        expect(() => classifier.classify(new Float32Array(90))).toThrow('Expected 150 input features');
        expect(() => classifier.classify(new Array(150).fill(NaN))).toThrow('finite numbers');
    });
});

describe('native inference allocation cleanup', () => {
    let classifier;
    let runtime;
    let result;
    let category;

    beforeEach(() => {
        category = { label: '0_idle', value: 1, delete: jest.fn() };
        result = { result: 0, anomaly: 0, size: () => 1, get: () => category, delete: jest.fn() };
        runtime = { _malloc: () => 4, _free: jest.fn(), HEAPF32: new Float32Array(200) };
        classifier = new EdgeImpulseClassifier();
        classifier._requireRuntime = () => runtime;
    });

    test('releases input, result, and categories after successful inference', () => {
        classifier._run([0, 0, 0], () => result, { model_type: 'classification' });
        expect(runtime._free).toHaveBeenCalledWith(4);
        expect(result.delete).toHaveBeenCalledTimes(1);
        expect(category.delete).toHaveBeenCalledTimes(1);
    });

    test('releases input and failed native results', () => {
        result.result = -5;
        expect(() => classifier._run([0], () => result, {})).toThrow('err code: -5');
        expect(result.delete).toHaveBeenCalledTimes(1);
        expect(runtime._free).toHaveBeenCalledWith(4);
    });

    test('releases input if the native call throws', () => {
        expect(() => classifier._run([0], () => { throw new Error('native error'); }, {})).toThrow('native error');
        expect(runtime._free).toHaveBeenCalledWith(4);
    });

    test('releases every allocated object if result conversion throws', () => {
        Object.defineProperty(category, 'label', { get: () => { throw new Error('bad label'); } });
        expect(() => classifier._run([0], () => result, {})).toThrow('bad label');
        expect(category.delete).toHaveBeenCalledTimes(1);
        expect(result.delete).toHaveBeenCalledTimes(1);
        expect(runtime._free).toHaveBeenCalledWith(4);
    });
});

describe('shared ML gesture detector', () => {
    test('uses the model window even when a legacy caller requests 30 samples', async () => {
        const MLGestureDetector = require('../lib/ml/ml-gesture-detector');
        const detector = new MLGestureDetector(30);
        await detector.ready();
        expect(detector.windowSize).toBe(50);
        expect(detector.sampleIntervalMs).toBe(20);
        const results = [];
        detector.on('ml-gesture', (result) => results.push(result));
        for (let index = 0; index < 49; index++) {
            detector.addSample({ accX: 1, accY: 0, accZ: 0 });
        }
        expect(results).toHaveLength(0);
        detector.addSample({ accX: 1, accY: 0, accZ: 0 });
        await Promise.resolve();
        expect(results).toHaveLength(1);
        expect(detector.buffer[0]).toEqual([0.25, 0, 0]);
    });
});

describe('initialization failure', () => {
    afterEach(() => jest.restoreAllMocks());

    test('rejects a corrupt model without an unhandled promise rejection', async () => {
        let FreshClassifier;
        jest.isolateModules(() => { FreshClassifier = require('../lib/ml/ei-classifier'); });
        jest.spyOn(WebAssembly, 'instantiate').mockRejectedValue(new Error('invalid WASM bytes'));
        await expect(new FreshClassifier().init()).rejects.toThrow('invalid WASM bytes');
    });

    test('bounds filesystem diagnostics', async () => {
        let FreshClassifier;
        jest.isolateModules(() => { FreshClassifier = require('../lib/ml/ei-classifier'); });
        jest.spyOn(require('node:fs'), 'readFileSync').mockImplementationOnce(() => {
            throw new Error('broken'.repeat(1000));
        });
        const message = await new FreshClassifier().init().catch((error) => error.message);
        expect(message).toMatch(/^Edge Impulse model initialization failed:/);
        expect(message.length).toBeLessThan(600);
    });
});
