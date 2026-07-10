// REST client for the rathole-manage Worker API.
//
// The panel authenticates with an HMAC-signed `rathole_session` cookie set by
// POST /api/login. Mobile HTTP clients don't have a browser cookie jar, so the
// cookie value is captured from Set-Cookie here and replayed on every request
// (and on the WebSocket upgrade).

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

const sessionCookieName = 'rathole_session';

class ApiException implements Exception {
  final int status;
  final String message;

  const ApiException(this.status, this.message);

  @override
  String toString() => message;
}

class ApiClient {
  /// Panel origin, e.g. `https://panel.example.com` (no trailing slash).
  String baseUrl = '';

  /// Value of the `rathole_session` cookie, when signed in.
  String? sessionCookie;

  final http.Client _client = http.Client();

  bool get hasSession => sessionCookie != null && sessionCookie!.isNotEmpty;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> _headers({bool json = false}) => {
        if (json) 'content-type': 'application/json',
        if (hasSession) 'cookie': '$sessionCookieName=$sessionCookie',
      };

  void _captureCookie(http.Response res) {
    final setCookie = res.headers['set-cookie'];
    if (setCookie == null) return;
    final match =
        RegExp('$sessionCookieName=([^;,\\s]*)').firstMatch(setCookie);
    if (match == null) return;
    final value = match.group(1)!;
    sessionCookie = value.isEmpty ? null : value;
  }

  Future<Map<String, dynamic>> _req(
    String method,
    String path, {
    Object? body,
  }) async {
    final request = http.Request(method, _uri(path))
      ..headers.addAll(_headers(json: body != null));
    if (body != null) request.body = jsonEncode(body);
    final res = await http.Response.fromStream(await _client.send(request));
    _captureCookie(res);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      String message = res.reasonPhrase ?? 'Request failed';
      try {
        final decoded = jsonDecode(res.body) as Map<String, dynamic>;
        final error = decoded['error'] as String?;
        final issues = (decoded['issues'] as List?)
            ?.map((issue) => (issue as Map<String, dynamic>)['message'])
            .whereType<String>()
            .join(' ');
        message = [
          if (error != null && error.isNotEmpty) error else message,
          if (issues != null && issues.isNotEmpty) issues,
        ].join(': ');
      } catch (_) {}
      throw ApiException(res.statusCode, message);
    }
    if (res.statusCode == 204 || res.body.isEmpty) return {};
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  // ---- auth -----------------------------------------------------------------

  Future<bool> login(String username, String password) async {
    try {
      await _req('POST', '/api/login',
          body: {'username': username, 'password': password});
      return hasSession;
    } on ApiException {
      return false;
    }
  }

  Future<SessionState> session() async {
    try {
      final json = await _req('GET', '/api/session');
      return SessionState.fromJson(json);
    } catch (_) {
      return const SessionState(authenticated: false);
    }
  }

  Future<void> logout() async {
    try {
      await _req('POST', '/api/logout');
    } finally {
      sessionCookie = null;
    }
  }

  Future<void> changePassword(String currentPassword, String newPassword) =>
      _req('POST', '/api/account/password', body: {
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      });

  // ---- users (admin) ----------------------------------------------------------

  Future<List<UserView>> listUsers() async {
    final json = await _req('GET', '/api/users');
    return (json['users'] as List)
        .map((u) => UserView.fromJson(u as Map<String, dynamic>))
        .toList();
  }

  Future<UserView> createUser(String username, String password, String role) async {
    final json = await _req('POST', '/api/users',
        body: {'username': username, 'password': password, 'role': role});
    return UserView.fromJson(json['user'] as Map<String, dynamic>);
  }

  Future<UserView> updateUser(String id, {String? role, String? password}) async {
    final json = await _req('PATCH', '/api/users/$id', body: {
      'role': ?role,
      'password': ?password,
    });
    return UserView.fromJson(json['user'] as Map<String, dynamic>);
  }

  Future<void> deleteUser(String id) => _req('DELETE', '/api/users/$id');

  // ---- settings -----------------------------------------------------------------

  Future<GlobalSettings> getSettings() async {
    final json = await _req('GET', '/api/settings');
    return GlobalSettings.fromJson(json['settings'] as Map<String, dynamic>);
  }

  Future<GlobalSettings> updateSettings(GlobalSettings settings) async {
    final json = await _req('PUT', '/api/settings', body: settings.toJson());
    return GlobalSettings.fromJson(json['settings'] as Map<String, dynamic>);
  }

  // ---- instances ----------------------------------------------------------------

  Future<List<InstanceView>> listInstances() async {
    final json = await _req('GET', '/api/instances');
    return (json['instances'] as List)
        .map((i) => InstanceView.fromJson(i as Map<String, dynamic>))
        .toList();
  }

  Future<InstanceView> updateInstance(String id,
      {String? name, RatholeConfig? config}) async {
    final json = await _req('PUT', '/api/instances/$id', body: {
      'name': ?name,
      'config': ?config?.toJson(),
    });
    return InstanceView.fromJson(json['instance'] as Map<String, dynamic>);
  }

  Future<void> deleteInstance(String id) => _req('DELETE', '/api/instances/$id');

  Future<String> revealToken(String id) async {
    final json = await _req('GET', '/api/instances/$id/reveal');
    return json['agentToken'] as String;
  }

  /// Returns true when the agent was online and received the command.
  Future<bool> sendCommand(String id, String command) async {
    final json = await _req('POST', '/api/instances/$id/command',
        body: {'command': command});
    return json['delivered'] as bool? ?? false;
  }

  /// ws(s):// URL for the live dashboard socket.
  Uri wsUri() {
    final base = Uri.parse(baseUrl);
    return base.replace(
      scheme: base.scheme == 'https' ? 'wss' : 'ws',
      path: '/api/ws',
    );
  }
}
