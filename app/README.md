# rathole-manage mobile app

A Flutter (Android/iOS) companion app for the rathole-manage panel, built with
[shadcn_ui](https://pub.dev/packages/shadcn_ui) 0.55 to match the web
dashboard's shadcn look. Feature parity with the web panel:

- sign in with your panel account (enter the panel URL once; the session
  cookie is stored on-device)
- live instance list over the panel WebSocket, with process state, service
  count, endpoint, and last-seen
- instance detail: CPU/memory/uptime/version metrics, start / stop / restart /
  delete, rename
- full server config editing with the same validation rules as the web UI
  (control channel, transport, HTTP proxy + Let's Encrypt, services with HTTP
  hosts / tokens / nodelay) and Save & push to the agent
- generated rathole `client.toml` snippets with copy-to-clipboard
- per-month traffic accounting and live per-service counters
- live log streaming
- agent setup instructions with token reveal (admin)
- global settings and user management (admin only), change password

## Layout

- `lib/src/models.dart` — Dart mirror of `src/shared/types.ts`
- `lib/src/config_logic.dart` — port of `src/shared/config-generator.ts`
  (normalization, validation, client.toml); covered by `test/config_logic_test.dart`
- `lib/src/api.dart` — REST client; replays the `rathole_session` cookie
- `lib/src/app_state.dart` — session + live instance store over `/api/ws`
  with exponential-backoff reconnect
- `lib/src/pages/` — login, dashboard, instance detail (config / services /
  client / traffic / logs / agent), global settings, users

## Develop

```bash
flutter pub get
flutter analyze
flutter test
flutter run            # with a connected device / emulator
flutter build apk      # Android release build
```

The panel must be reachable over HTTPS (the session cookie is `Secure`, and
Android/iOS block cleartext HTTP by default).
