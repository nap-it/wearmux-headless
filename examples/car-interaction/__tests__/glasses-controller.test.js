const { GlassesController, CONSTANTS, STATE } = require('../glasses-controller');

describe('GlassesController', () => {
  let ctrl;

  beforeEach(() => {
    ctrl = new GlassesController();
  });

  test('starts in idle state', () => {
    expect(ctrl.state).toBe('idle');
  });

  test('demo mode from env', () => {
    process.env.DEMO_MODE = '1';
    ctrl = new GlassesController();
    expect(ctrl.demoMode).toBe(true);
    delete process.env.DEMO_MODE;
  });

  test('has default config from CONSTANTS', () => {
    expect(ctrl.config.sensorRate).toBe(CONSTANTS.DEFAULT_SENSOR_RATE);
    expect(ctrl.config.gestureTimeoutMs).toBe(CONSTANTS.DEFAULT_GESTURE_TIMEOUT_MS);
    expect(ctrl.config.fontSize).toBe(CONSTANTS.DEFAULT_FONT_SIZE);
    expect(ctrl.config.gestureConfidenceThreshold).toBe(CONSTANTS.DEFAULT_GESTURE_CONFIDENCE);
    expect(ctrl.config.nodConfidenceThreshold).toBe(CONSTANTS.DEFAULT_NOD_CONFIDENCE);
    expect(ctrl.config.shakeConfidenceThreshold).toBe(CONSTANTS.DEFAULT_SHAKE_CONFIDENCE);
  });

  test('state constants are exported and correct', () => {
    expect(STATE.IDLE).toBe('idle');
    expect(STATE.WAITING_FOR_GESTURE).toBe('waiting_for_gesture');
    expect(STATE.SHOWING_CONFIRMATION).toBe('showing_confirmation');
  });

  test('CONSTANTS exports expected keys', () => {
    expect(CONSTANTS.COLOR_ATTENTION).toBe('#FFFF00');
    expect(CONSTANTS.COLOR_CONFIRM).toBe('#00FF00');
    expect(CONSTANTS.COLOR_WARNING).toBe('#FF8800');
    expect(CONSTANTS.ZENOH_CAR_APPROACHING_KEY).toBe('car/approaching');
    expect(CONSTANTS.ZENOH_CAR_CONFIRMATION_KEY).toBe('car/confirmation');
    expect(CONSTANTS.ZENOH_GESTURE_RESPONSE_TOPIC).toBe('gesture/response');
  });

  test('cleanup method exists', () => {
    expect(typeof ctrl.cleanup).toBe('function');
  });
});