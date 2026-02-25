/**
 * Configuration and Constants for Car Interaction Demo
 */

const ZENOH_TOPICS = {
  CAR_APPROACHING: "car/approaching",
  CAR_CONFIRMATION: "car/confirmation",
  GESTURE_RESPONSE: "gesture/response",
  CAR_PUB_PREFIX: "car",
  GESTURE_PUB_PREFIX: "gesture",
  CAR_SUB_EXPRESSION: "car/**",
};

const GESTURE_TYPES = {
  NOD: "nod",
  SHAKE: "shake",
  TIMEOUT: "timeout",
};

const STATE = {
  IDLE: "idle",
  WAITING_FOR_GESTURE: "waiting_for_gesture",
  SHOWING_CONFIRMATION: "showing_confirmation",
};

const CAR_CONFIG = {
  UDS_PUB_PATH: `/tmp/bsole-zenoh-car-pub-${process.pid}.sock`,
  UDS_SUB_PATH: `/tmp/bsole-zenoh-car-sub-${process.pid}.sock`,
  MIN_APPROACH_DELAY: 5000,
  MAX_APPROACH_DELAY: 15000,
  RESPONSE_TIMEOUT: 8000,
  ERROR_RETRY_DELAY: 5000,
  STOP_DURATION: 2000,
  PASS_DURATION: 1500,
  RESUME_DELAY: 1000,
};

const GLASSES_CONFIG = {
  UDS_PUB_PATH: `/tmp/bsole-zenoh-glasses-pub-${process.pid}.sock`,
  UDS_SUB_PATH: `/tmp/bsole-zenoh-glasses-sub-${process.pid}.sock`,

  // Display colors
  COLOR_ATTENTION: "#FFFF00",
  COLOR_CONFIRM: "#00FF00",
  COLOR_WARNING: "#FF8800",

  // Delays (ms)
  ML_INIT_POLL_INTERVAL_MS: 50,
  FEEDBACK_DISPLAY_MS: 1000,
  TIMEOUT_DISPLAY_MS: 2000,
  CONFIRMATION_DISPLAY_MS: 3000,

  // ML detector
  ML_WINDOW_SIZE: 30, // 30 samples = 1.5s at 20Hz

  // Sensor config defaults
  DEFAULT_SENSOR_RATE: 20,
  DEFAULT_FONT_SIZE: 24,
  DEFAULT_GESTURE_CONFIDENCE: 0.5,
  DEFAULT_NOD_CONFIDENCE: 0.8,
  DEFAULT_SHAKE_CONFIDENCE: 0.8,
  DEFAULT_GESTURE_TIMEOUT_MS: 8000,

  // Display messages
  MSG_READY: "Ready\nWaiting for car...",
  MSG_TIMEOUT: "No response\nCar will proceed",
  MSG_DEFAULT_APPROACH: "Car approaching\nAllow to stop?",
  MSG_DEFAULT_CONFIRMATION: "Car confirmed",
};

module.exports = {
  ZENOH_TOPICS,
  GESTURE_TYPES,
  STATE,
  CAR_CONFIG,
  GLASSES_CONFIG,
};
