// App-wide state: session, live instance map, and the hub WebSocket.
//
// Mirrors the web panel's useHubSocket hook: REST loads queryable state, the
// WebSocket delivers live instance deltas and the rolling log stream for the
// subscribed instance, with exponential-backoff reconnect.

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';
import 'models.dart';

enum ConnState { connecting, open, closed }

const _prefsServerUrl = 'serverUrl';
const _prefsSessionCookie = 'sessionCookie';

class AppState extends ChangeNotifier {
  final ApiClient api = ApiClient();

  SessionState session = const SessionState(authenticated: false);
  ConnState conn = ConnState.connecting;
  bool loading = true;
  String? loadError;

  final Map<String, InstanceView> _instances = {};
  final List<LogLine> logs = [];

  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  Timer? _reconnectTimer;
  int _retry = 0;
  bool _closed = true;
  bool _initialLoadSettled = false;
  String? _logSub;

  bool get isAdmin => session.isAdmin;

  List<InstanceView> get instances {
    final list = _instances.values.toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    return list;
  }

  InstanceView? instance(String id) => _instances[id];

  // ---- persistence ----------------------------------------------------------

  /// Restore the saved server URL + session cookie; returns true when a
  /// previous session exists and is still valid.
  Future<bool> restore() async {
    final prefs = await SharedPreferences.getInstance();
    api.baseUrl = prefs.getString(_prefsServerUrl) ?? '';
    api.sessionCookie = prefs.getString(_prefsSessionCookie);
    if (api.baseUrl.isEmpty || !api.hasSession) return false;
    final s = await api.session();
    if (!s.authenticated) return false;
    session = s;
    notifyListeners();
    return true;
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefsServerUrl, api.baseUrl);
    final cookie = api.sessionCookie;
    if (cookie == null) {
      await prefs.remove(_prefsSessionCookie);
    } else {
      await prefs.setString(_prefsSessionCookie, cookie);
    }
  }

  Future<String?> savedServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_prefsServerUrl);
  }

  // ---- auth -------------------------------------------------------------------

  Future<bool> login(String serverUrl, String username, String password) async {
    var url = serverUrl.trim();
    while (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }
    api.baseUrl = url;
    final ok = await api.login(username.trim(), password);
    if (!ok) return false;
    session = await api.session();
    await _persist();
    notifyListeners();
    return session.authenticated;
  }

  Future<void> logout() async {
    disconnect();
    try {
      await api.logout();
    } catch (_) {}
    session = const SessionState(authenticated: false);
    _instances.clear();
    logs.clear();
    loading = true;
    _initialLoadSettled = false;
    await _persist();
    notifyListeners();
  }

  // ---- REST refresh -------------------------------------------------------------

  Future<void> refresh() async {
    try {
      final loaded = await api.listInstances();
      _instances
        ..clear()
        ..addEntries(loaded.map((i) => MapEntry(i.id, i)));
      loadError = null;
    } catch (error) {
      loadError = error.toString();
    } finally {
      if (!_initialLoadSettled) {
        _initialLoadSettled = true;
        loading = false;
      }
      notifyListeners();
    }
  }

  // ---- WebSocket -----------------------------------------------------------------

  void connect() {
    _closed = false;
    unawaited(refresh());
    _connect();
  }

  void disconnect() {
    _closed = true;
    _reconnectTimer?.cancel();
    _wsSub?.cancel();
    _ws?.sink.close();
    _ws = null;
    conn = ConnState.closed;
  }

  void _connect() {
    if (_closed) return;
    conn = ConnState.connecting;
    notifyListeners();

    final channel = IOWebSocketChannel.connect(
      api.wsUri(),
      headers: {
        if (api.hasSession) 'Cookie': '$sessionCookieName=${api.sessionCookie}',
      },
      connectTimeout: const Duration(seconds: 15),
      customClient: HttpClient(),
    );
    _ws = channel;

    channel.ready.then((_) {
      if (_closed || _ws != channel) return;
      _retry = 0;
      conn = ConnState.open;
      notifyListeners();
      unawaited(refresh());
      final sub = _logSub;
      if (sub != null) {
        _send({'type': 'subscribe_logs', 'instanceId': sub});
      }
    }).catchError((_) {});

    _wsSub = channel.stream.listen(
      _onMessage,
      onDone: () => _onClosed(channel),
      onError: (_) => _onClosed(channel),
      cancelOnError: true,
    );
  }

  void _onClosed(WebSocketChannel channel) {
    if (_ws != channel) return;
    _ws = null;
    conn = ConnState.closed;
    notifyListeners();
    if (_closed) return;
    final delay = math.min(1000 * math.pow(2, _retry).toInt(), 15000);
    _retry++;
    _reconnectTimer = Timer(Duration(milliseconds: delay), _connect);
  }

  void _send(Map<String, dynamic> msg) {
    final ws = _ws;
    if (ws != null && conn == ConnState.open) {
      ws.sink.add(jsonEncode(msg));
    }
  }

  void _onMessage(dynamic data) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(data as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'instance_update':
        final instance =
            InstanceView.fromJson(msg['instance'] as Map<String, dynamic>);
        _instances[instance.id] = instance;
        notifyListeners();
      case 'instance_removed':
        _instances.remove(msg['instanceId'] as String);
        notifyListeners();
      case 'log':
        logs.add(LogLine(
          instanceId: msg['instanceId'] as String,
          line: msg['line'] as String,
          stream: msg['stream'] as String?,
          ts: (msg['ts'] as num?)?.toInt() ??
              DateTime.now().millisecondsSinceEpoch,
        ));
        if (logs.length > 500) logs.removeRange(0, logs.length - 500);
        notifyListeners();
    }
  }

  void subscribeLogs(String instanceId) {
    if (_logSub != null && _logSub != instanceId) {
      _send({'type': 'unsubscribe_logs', 'instanceId': _logSub});
    }
    _logSub = instanceId;
    logs.clear();
    _send({'type': 'subscribe_logs', 'instanceId': instanceId});
    notifyListeners();
  }

  void unsubscribeLogs() {
    if (_logSub != null) {
      _send({'type': 'unsubscribe_logs', 'instanceId': _logSub});
    }
    _logSub = null;
  }

  @override
  void dispose() {
    disconnect();
    super.dispose();
  }
}
