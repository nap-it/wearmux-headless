# WearMux on Droidspaces

Use two checkouts: `wearmux-headless` branch `feature-android-bluetooth` and the existing `wearmux-android` branch `feature-bluetooth-headless-bridge`. Build/install the normal Android `:app` APK; there is no separate bridge application. Its Dev / Lab → Overview panel contains the bridge controls.

This transport supports Brilliant Labs Frame running the custom BrilliantSole/BrilliantWear firmware, as used by the Pi. Stock Frame firmware uses a different GATT service and Lua protocol and is not supported by this adapter. Android forwards raw characteristic bytes; headless retains display rendering, 50 Hz sensor decoding, gesture inference, and MQTT interaction handling.

## Container deployment

Git checkout plus Docker Compose keeps updates repeatable. In Debian, clone the headless repository and check out `feature-android-bluetooth`. Generate a shared token locally on the phone and save it in the ignored environment file:

```sh
umask 077
printf 'ANDROID_BLE_BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env.android
```

Use `Dockerfile.android` for the phone, which does not compile or load Noble/HCI. Build an ARM64 image on an ARM64 Mac/Pi or with Docker Buildx, then transfer it to Debian if building on the phone is slow:

```sh
docker build --platform linux/arm64 -f Dockerfile.android -t wearmux-headless:android-ble .
docker save wearmux-headless:android-ble | gzip > wearmux-headless-android.tar.gz
# Transfer the archive, then on the phone:
gzip -dc wearmux-headless-android.tar.gz | sudo docker load
sudo docker compose --env-file .env.android -f docker-compose.android.yml up -d --no-build
curl http://127.0.0.1:8765/healthz
```

For on-phone builds replace `--no-build` with `--build`. The bridge container runs as a regular user and needs no Bluetooth hardware mounts or privileged Docker mode. The surrounding Debian/Droidspaces configuration still needs to support Docker. The VRU request handler and ITS radio services can stay on the Pi during testing; avoid running a second handler against the same MQTT interaction topics.

## Android connection

Install the updated WearMux Android APK, grant nearby-device and notification permissions, enable Bluetooth, and open Dev / Lab → Overview. Enter `ws://172.28.178.197:8765/android-ble` (the observed Debian address on this phone), the token from `.env.android`, and optionally the glasses' MAC/name. Start the bridge. This address is an example from the current phone and may change after Droidspaces restarts. Android and Debian have separate loopback/network namespaces: using `127.0.0.1` on Android does not reach Debian unless you explicitly forward that port.

The `/healthz` response distinguishes a running listener (`ok`), authenticated Android connection (`bridgeConnected`), and fully initialized glasses capabilities (`deviceConnected`). An Android BLE connection alone does not prove display/gesture readiness. Only one Android peer and one peripheral are supported at a time. Stopping the bridge releases BLE ownership back to the normal Android glasses client.

For access outside the trusted local device/network, place TLS in front of the listener and use `wss://`. Never put the token in a URL, commit it to Git, or copy it into logs.

## Validation

```sh
npm run test:android-ble
npx jest --runInBand
```

The wire tests use the actual browser BrilliantSole SDK with a simulated Android peer. They check authentication, strict frames, complete TLV writes within ATT MTU, metadata/display initialization, malformed notifications, and write timeout teardown. Physical notification delivery, display appearance and gesture recognition still need a powered-on Frame and the installed Android app.
