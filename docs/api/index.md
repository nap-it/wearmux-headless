# WearMux Headless documentation

WearMux Headless is the Node.js host for acquiring data and sending feedback across compatible wearables. It uses capability-based device sessions and modality modules, with MQTT or Zenoh for application integration. Device access is provided by the [Brilliant Wear JavaScript SDK](https://github.com/brilliantsole/BrilliantWear-JavaScript-SDK); see [Brilliant Wear](https://brilliantwear.com/) for hardware information.

## Start here

- [Project overview and quick start](../../README.md): supported devices, requirements, citation, contacts, and license.
- [Technical guide](../technical-guide.md): configuration, commands, messaging, Docker, and troubleshooting.
- [Developer integration guide](integration.md): embed the host, manage resources, and add device or transport integrations.
- [Message contracts](message-contract.md): identities, time bases, raw media framing, and action outcomes.
- [Direct Wear OS developer guide](wearos.md): watch setup, discovery, protocol, rate semantics, and current client requirements.

## Core interfaces

| Responsibility | Reference |
| --- | --- |
| Discover and run several devices | {@link DeviceFleet} |
| Connect one device | {@link DeviceManager} |
| Accept direct Wi-Fi watch connections | {@link WearOsServer}, {@link WearOsDevice}, {@link WEAROS_SENSORS} |
| Coordinate one connected device's capabilities | {@link DeviceSession} |
| Camera acquisition and browser viewing | {@link CameraSession} |
| Microphone acquisition, levels, and streaming | {@link MicrophoneSession}, {@link RtspPublisher} |
| Sensor configuration and event forwarding | {@link SensorManager} |
| Display rendering | {@link DisplayManager}, {@link TextDisplay}, {@link PromptDisplay} |
| Validate and dispatch feedback | {@link ActionDispatcher} |
| Select messaging backends | {@link selectedTransport}, {@link createPublisher}, {@link createSubscriber} |
| MQTT publishing/subscription | {@link MqttManager}, {@link MqttSubscriber} |
| Zenoh publishing/subscription | {@link ZenohManager}, {@link ZenohSubscriber} |
| Load settings and construct messages | {@link Config}, {@link loadConfigFile}, {@link topic}, {@link publishRawMedia} |

Classes and methods link to their source. The reference covers the host's integration interfaces; examples, inference implementations, third-party code, and internal helpers are outside its scope.

## Shared interfaces and payloads

| Contract | Reference |
| --- | --- |
| Device identity and advertised capabilities | {@link DeviceIdentity}, {@link DeviceCapabilities} |
| Backend interfaces and configuration | {@link Publisher}, {@link Subscriber}, {@link TransportOptions}, {@link TransportMessage} |
| Sensor and media observations | {@link SensorEnvelope}, {@link CameraImage}, {@link MicrophoneLevel} |
| Raw media framing | {@link RawMediaMetadata}, {@link RawMediaChunk} |
| Feedback commands and outcomes | {@link ActionCommand}, {@link ActionResult} |
| Rendering and INI settings | {@link DisplayRenderOptions}, {@link ParsedIni} |
| Direct watch settings and packets | {@link WearOsServerOptions}, {@link WearOsHello}, {@link WearOsSensorPacket}, {@link WearOsHostCommand}, {@link WearOsDiscoveryReply} |
| Local watch events | {@link WearOsConnectionEvent}, {@link WearOsSensorEvent} |
