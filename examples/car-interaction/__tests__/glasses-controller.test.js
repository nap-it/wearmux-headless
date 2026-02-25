const { GlassesController } = require('../glasses-controller');
const { STATE, GLASSES_CONFIG, ZENOH_TOPICS } = require('../constants');

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
    expect(ctrl.config.DEFAULT_SENSOR_RATE).toBe(GLASSES_CONFIG.DEFAULT_SENSOR_RATE);
    expect(ctrl.config.DEFAULT_GESTURE_TIMEOUT_MS).toBe(GLASSES_CONFIG.DEFAULT_GESTURE_TIMEOUT_MS);
    expect(ctrl.config.DEFAULT_FONT_SIZE).toBe(GLASSES_CONFIG.DEFAULT_FONT_SIZE);
    expect(ctrl.config.DEFAULT_GESTURE_CONFIDENCE).toBe(GLASSES_CONFIG.DEFAULT_GESTURE_CONFIDENCE);
    expect(ctrl.config.DEFAULT_NOD_CONFIDENCE).toBe(GLASSES_CONFIG.DEFAULT_NOD_CONFIDENCE);
    expect(ctrl.config.DEFAULT_SHAKE_CONFIDENCE).toBe(GLASSES_CONFIG.DEFAULT_SHAKE_CONFIDENCE);
  });

  test('state constants are exported and correct', () => {
    expect(STATE.IDLE).toBe('idle');
    expect(STATE.WAITING_FOR_GESTURE).toBe('waiting_for_gesture');
    expect(STATE.SHOWING_CONFIRMATION).toBe('showing_confirmation');
  });

  test('CONSTANTS exports expected keys', () => {
    expect(GLASSES_CONFIG.COLOR_ATTENTION).toBe('#FFFF00');
    expect(GLASSES_CONFIG.COLOR_CONFIRM).toBe('#00FF00');
    expect(GLASSES_CONFIG.COLOR_WARNING).toBe('#FF8800');
    expect(ZENOH_TOPICS.CAR_APPROACHING).toBe('car/approaching');
    expect(ZENOH_TOPICS.CAR_CONFIRMATION).toBe('car/confirmation');
    expect(ZENOH_TOPICS.GESTURE_RESPONSE).toBe('gesture/response');
  });

  test('cleanup method exists', () => {
    expect(typeof ctrl.cleanup).toBe('function');
  });
});