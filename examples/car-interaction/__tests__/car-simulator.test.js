const { CarSimulator } = require('../car-simulator');

describe('CarSimulator', () => {
  let sim;

  beforeEach(() => {
    sim = new CarSimulator();
  });

  test('starts with approach count 0', () => {
    expect(sim.approachCount).toBe(0);
  });

  test('starts not waiting for response', () => {
    expect(sim.isWaitingForResponse).toBe(false);
  });

  test('has required config', () => {
    expect(sim.config.MIN_APPROACH_DELAY).toBe(5000);
    expect(sim.config.MAX_APPROACH_DELAY).toBe(15000);
    expect(sim.config.RESPONSE_TIMEOUT).toBe(8000);
  });

  test('cleanup method exists', () => {
    expect(typeof sim.cleanup).toBe('function');
  });

  test('can increment approach count', () => {
    const initial = sim.approachCount;
    sim.approachCount++;
    expect(sim.approachCount).toBe(initial + 1);
  });

  test('can toggle waiting state', () => {
    expect(sim.isWaitingForResponse).toBe(false);
    sim.isWaitingForResponse = true;
    expect(sim.isWaitingForResponse).toBe(true);
    sim.isWaitingForResponse = false;
    expect(sim.isWaitingForResponse).toBe(false);
  });
});