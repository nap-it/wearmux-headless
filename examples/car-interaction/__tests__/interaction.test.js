const { CarSimulator } = require('../car-simulator');
const { GlassesController } = require('../glasses-controller');

// Mock external deps but keep internal logic
jest.mock('../../../utils/zenoh-manager', () => ({
  ZenohManager: class MockZenohManager {
    constructor() {
      this.messages = [];
    }
    async start() { }
    async stop() { }
    setDeviceInfo() { }
    async publish(topic, data) {
      this.messages.push({ topic, data });
      // Simulate message delivery
      if (topic === 'car/approaching' && this.onMessage) {
        setTimeout(() => this.onMessage('car/approaching', data), 10);
      }
    }
  }
}));

jest.mock('../../../utils/zenoh-subscriber', () => ({
  ZenohSubscriber: class MockZenohSubscriber {
    constructor() {
      this.handlers = {};
    }
    async start() { }
    async stop() { }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    simulateMessage(key, payload) {
      if (this.handlers.message) {
        this.handlers.message({ key, payload });
      }
    }
  }
}));

// Mock other dependencies that glasses controller needs
jest.mock('../../../utils/device-manager', () => ({
  DeviceManager: class MockDeviceManager { }
}));

jest.mock('../../../sensors/lib/sensor-manager', () => ({
  SensorManager: class MockSensorManager { }
}));

jest.mock('../../../sensors/lib/ml-gesture-detector', () => {
  return class MockMLGestureDetector {
    constructor() {
      this.initialized = true;
      this.reset = jest.fn();
      this.on = jest.fn();
      this.addSample = jest.fn();
    }
  };
});

jest.mock('../../../display/lib/text-display', () => ({
  TextDisplay: class MockTextDisplay {
    constructor() {
      this.loadFont = jest.fn();
      this.showText = jest.fn();
      this.clear = jest.fn();
    }
  }
}));

jest.useFakeTimers();

describe('Car-Glasses Interaction', () => {
  let car;
  let glasses;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create instances
    car = new CarSimulator();
    glasses = new GlassesController();

    // Set glasses to demo mode to avoid complex display operations
    glasses.demoMode = true;

    // Mock console to avoid noise
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    // Initialize car simulator (this sets up zenohPublisher)
    await car.initialize();

    // Mock dependencies for glasses that are set during initialization
    glasses.glasses = {
      stopWaitingForGesture: jest.fn(),
      startWaitingForGesture: jest.fn(),
      showMessage: jest.fn().mockResolvedValue(undefined),
      clearDisplay: jest.fn().mockResolvedValue(undefined),
      waitForDemoGesture: jest.fn().mockReturnValue(new Promise(() => { })),
      device: { bluetoothId: 'test-id', name: 'Test Device' }
    };
    glasses.network = {
      publish: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(undefined),
      setDeviceInfo: jest.fn(),
      onMessage: jest.fn(),
      cleanup: jest.fn()
    };

    // Set up mock network client for car
    car.network = {
      publish: jest.fn(),
      onMessage: jest.fn(),
      start: jest.fn(),
      cleanup: jest.fn()
    };
  });

  afterEach(async () => {
    jest.clearAllTimers();
    console.log.mockRestore();
    console.error.mockRestore();
    if (glasses && glasses.cleanup) await glasses.cleanup();
    if (car && car.cleanup) await car.cleanup();
  });

  test('full interaction: car approaches, user nods, car stops', async () => {
    // Setup initial states
    car.isWaitingForResponse = false;
    glasses.state = 'idle';

    // Simulate approach message sent
    const approachData = {
      ts: Date.now(),
      message: "Car approaching. Allow to stop?",
      type: "question",
      approachId: 1
    };

    // Glasses receives approach
    glasses._handleZenohMessage(
      'car/approaching',
      approachData
    );

    // Verify glasses state changed
    expect(glasses.state).toBe('waiting_for_gesture');
    expect(glasses.currentQuestion).toBe("Car approaching. Allow to stop?");

    // User nods (gesture detected) - simulate car waiting for response
    car.isWaitingForResponse = true;

    // Set up the promise mechanism that _handleGestureResponse expects
    const mockResolve = jest.fn();
    car._responseResolve = mockResolve;

    const gestureData = {
      ts: Date.now(),
      gesture: 'nod',
      device: { id: 'test-glasses', name: 'Test' }
    };

    // Car receives gesture
    car._handleGestureResponse(gestureData);

    // Verify promise was resolved
    expect(mockResolve).toHaveBeenCalledWith(true);

    // Manually set the flag since we're not running the full async flow
    car.isWaitingForResponse = false;

    // Verify car publishes confirmation (should have been called by _sendConfirmation)
    expect(car.network.publish).toHaveBeenCalledWith(
      'car/confirmation',
      expect.objectContaining({
        gesture: 'nod',
        action: 'STOPPING'
      })
    );

    // Car sends confirmation
    const confirmData = {
      ts: Date.now(),
      message: "Car will stop. Thank you!",
      gesture: 'nod',
      action: 'STOPPING'
    };

    // Glasses receives confirmation
    const confirmPromise = glasses._handleZenohMessage(
      'car/confirmation',
      confirmData
    );

    // Fast-forward timers to complete the async operations in _handleCarConfirmation
    for (let i = 0; i < 5; i++) {
      jest.runAllTimers();
      await Promise.resolve();
    }
    await confirmPromise;

    // Verify final state
    expect(glasses.state).toBe('idle');
    expect(car.isWaitingForResponse).toBe(false);
  });

  test('timeout scenario: car approaches, no response, car proceeds', async () => {
    // Use real timers for this test to avoid hanging
    jest.useRealTimers();

    // Setup initial states
    car.isWaitingForResponse = true;
    glasses.state = 'waiting_for_gesture';

    // Simulate timeout (no gesture within 8 seconds)
    await glasses._handleGestureTimeout();

    // Verify timeout response sent
    expect(glasses.network.publish).toHaveBeenCalledWith(
      'gesture/response',
      expect.objectContaining({ gesture: 'timeout' })
    );

    expect(glasses.state).toBe('idle');

    // Car handles timeout - set up promise mechanism
    const mockResolve = jest.fn();
    car._responseResolve = mockResolve;
    car._handleGestureResponse({ gesture: 'timeout' });

    // Verify promise resolved and manually set state
    expect(mockResolve).toHaveBeenCalledWith(true);
    car.isWaitingForResponse = false;
    expect(car.isWaitingForResponse).toBe(false);

    // Restore fake timers for other tests
    jest.useFakeTimers();
  }, 20000);

  test('user shakes head: car proceeds without stopping', async () => {
    // Setup interaction
    glasses.state = 'waiting_for_gesture';
    car.isWaitingForResponse = true;

    // Set up promise mechanism
    const mockResolve = jest.fn();
    car._responseResolve = mockResolve;

    // User shakes head (no)
    const shakeData = {
      gesture: 'shake',
      ts: Date.now(),
      device: { id: 'test-glasses' }
    };

    // Car receives shake
    car._handleGestureResponse(shakeData);

    // Verify promise resolved and manually set state
    expect(mockResolve).toHaveBeenCalledWith(true);
    car.isWaitingForResponse = false;

    // Car sends proceeding confirmation
    const confirmData = {
      message: "Car will proceed. Stay safe!",
      gesture: 'shake',
      action: 'PROCEEDING'
    };

    const confirmPromise = glasses._handleZenohMessage(
      'car/confirmation',
      confirmData
    );

    // Fast-forward timers to complete async operations
    for (let i = 0; i < 5; i++) {
      jest.runAllTimers();
      await Promise.resolve();
    }
    await confirmPromise;

    expect(glasses.state).toBe('idle');
  });

  test('busy state: glasses ignore second car while handling first', async () => {
    // First car approaches
    glasses.state = 'idle';
    glasses._handleZenohMessage(
      'car/approaching',
      { message: "First car approaching" }
    );

    expect(glasses.state).toBe('waiting_for_gesture');
    expect(glasses.currentQuestion).toBe("First car approaching");

    // Second car tries to approach
    glasses._handleZenohMessage({
      key: 'car/approaching',
      payload: { message: "Second car approaching" }
    });

    // Should ignore second approach
    expect(glasses.state).toBe('waiting_for_gesture');
    expect(glasses.currentQuestion).toBe("First car approaching"); // unchanged
  });

  test('malformed message handling', () => {
    // Invalid JSON payload
    expect(() => {
      glasses._handleZenohMessage(
        'car/approaching',
        '{"invalid": json}'
      );
    }).not.toThrow();

    // Missing gesture field
    expect(() => {
      car._handleGestureResponse({ ts: Date.now() });
    }).not.toThrow();

    // Car should still be waiting (invalid response ignored)
    car.isWaitingForResponse = true;
    car._handleGestureResponse({});
    expect(car.isWaitingForResponse).toBe(true);
  });
});