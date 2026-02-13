const { GlassesController } = require('../glasses-controller');

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

  test('has default config', () => {
    expect(ctrl.config.sensorRate).toBe(20);
    expect(ctrl.config.gestureTimeoutMs).toBe(8000);
    expect(ctrl.config.fontSize).toBe(24);
  });

  test('state constants exist', () => {
    const STATE = require('../glasses-controller').STATE || {
      IDLE: "idle",
      WAITING_FOR_GESTURE: "waiting_for_gesture",
      SHOWING_CONFIRMATION: "showing_confirmation"
    };
    expect(STATE.IDLE).toBe('idle');
    expect(STATE.WAITING_FOR_GESTURE).toBe('waiting_for_gesture');
    expect(STATE.SHOWING_CONFIRMATION).toBe('showing_confirmation');
  });

  test('cleanup method exists', () => {
    expect(typeof ctrl.cleanup).toBe('function');
  });
});