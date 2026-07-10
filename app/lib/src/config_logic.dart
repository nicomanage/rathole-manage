// Dart port of src/shared/config-generator.ts — config normalization,
// validation, and rathole client.toml generation. Keep the behavior in sync
// with the web panel so both frontends accept/reject the same configs.

import 'models.dart';

const httpProxyBindAddr = '[::]:80';
const httpsProxyBindAddr = '[::]:443';
const httpServiceBindAddrPrefix = 'memory://';

class ValidationIssue {
  final String path;
  final String message;

  const ValidationIssue(this.path, this.message);
}

bool isHttpServiceType(String type) => type == 'http' || type == 'https';

bool isHttpService(RatholeService svc) => isHttpServiceType(svc.type);

bool hasHttpRoute(RatholeService svc) =>
    isHttpService(svc) || serviceHttpHosts(svc).isNotEmpty;

bool hasHttpsRoute(RatholeService svc) =>
    svc.type == 'https' && serviceHttpHosts(svc).isNotEmpty;

String defaultPublicBindAddr(int i) => '0.0.0.0:${5000 + i}';

String restorePublicBindAddr(RatholeService service, int i) {
  final bindAddr = service.bindAddr.trim();
  if (bindAddr.isEmpty || bindAddr.startsWith(httpServiceBindAddrPrefix)) {
    return defaultPublicBindAddr(i);
  }
  return service.bindAddr;
}

List<String> parseHttpHostsInput(String value) => value
    .split(RegExp(r'[\s,;]+'))
    .map((host) => host.trim())
    .where((host) => host.isNotEmpty)
    .toList();

List<String> serviceHttpHosts(RatholeService service) {
  final hosts = [
    ...?service.httpHosts,
    if (service.httpHost != null) ...parseHttpHostsInput(service.httpHost!),
  ];
  final seen = <String>{};
  final normalized = <String>[];
  for (final host in hosts) {
    final trimmed = host.trim();
    final key = trimmed.toLowerCase();
    if (trimmed.isEmpty || seen.contains(key)) continue;
    seen.add(key);
    normalized.add(trimmed);
  }
  return normalized;
}

/// Normalize persisted/API configs before editing or saving; mirrors the web
/// panel's normalizeConfig (legacy httpHost migration, memory:// bind
/// assignment, http proxy fixed addresses).
RatholeConfig normalizeConfig(RatholeConfig input) {
  final config = input.clone();
  final httpEnabled = config.http?.enabled ?? false;

  final services = <RatholeService>[];
  for (var i = 0; i < config.services.length; i++) {
    final service = config.services[i].clone();
    final httpHosts = httpEnabled ? serviceHttpHosts(service) : <String>[];
    var serviceType = service.type;
    if (!httpEnabled && isHttpService(service)) {
      serviceType = 'tcp';
    } else if (httpHosts.isNotEmpty && service.type == 'tcp') {
      serviceType = 'http';
    }
    var bindAddr = service.bindAddr;
    if (serviceType == 'tcp' && isHttpService(service)) {
      bindAddr = restorePublicBindAddr(service, i);
    }
    service
      ..type = serviceType
      ..bindAddr = bindAddr
      ..httpHost = null
      ..httpHosts = httpHosts.isNotEmpty ? httpHosts : null;
    services.add(service);
  }

  // Assign internal memory:// bind addresses to HTTP/HTTPS services.
  for (var i = 0; i < services.length; i++) {
    final service = services[i];
    if (!isHttpService(service)) continue;
    final name = service.name.trim();
    final key = name.isNotEmpty ? name : 'service_${i + 1}';
    service.bindAddr = '$httpServiceBindAddrPrefix$key';
  }

  if (config.http != null) {
    final le = config.http!.letsEncrypt;
    config.http = HttpProxyConfig(
      enabled: config.http!.enabled,
      bindAddr: httpProxyBindAddr,
      httpsBindAddr: httpsProxyBindAddr,
      letsEncrypt: le == null
          ? null
          : LetsEncryptConfig(
              enabled: le.enabled,
              email: le.email.trim(),
              staging: le.staging,
            ),
    );
  }
  config.services = services;
  return config;
}

String? _validateHostPort(String value, String ipv6Example) {
  final input = value.trim();
  if (input.isEmpty) return 'is required.';
  if (input != value || RegExp(r'\s').hasMatch(input)) {
    return 'must not contain whitespace.';
  }
  if (RegExp(r'^[a-z][a-z0-9+.-]*://', caseSensitive: false).hasMatch(input) ||
      input.contains('/')) {
    return 'must be only host:port, without a URL scheme or path.';
  }

  String host;
  String portText;

  if (input.startsWith('[')) {
    final end = input.indexOf(']');
    if (end < 0) {
      return 'must close the IPv6 address bracket, e.g. $ipv6Example.';
    }
    host = input.substring(1, end);
    if (end + 1 >= input.length || input[end + 1] != ':') {
      return 'must put the port after the IPv6 bracket, e.g. $ipv6Example.';
    }
    portText = input.substring(end + 2);
    if (!_isValidIpv6Host(host)) {
      return 'has an invalid IPv6 address; use bracket form like $ipv6Example.';
    }
  } else {
    final firstColon = input.indexOf(':');
    final lastColon = input.lastIndexOf(':');
    if (firstColon < 0) return 'must include a port, e.g. 0.0.0.0:5000.';
    if (firstColon != lastColon) {
      return 'looks like IPv6; use bracket form like $ipv6Example.';
    }
    host = input.substring(0, lastColon);
    portText = input.substring(lastColon + 1);
    if (!_isValidHost(host)) {
      return 'has an invalid host; use an IPv4 address, hostname, localhost, or bracketed IPv6.';
    }
  }

  if (!RegExp(r'^\d+$').hasMatch(portText)) return 'port must be a whole number.';
  final port = int.tryParse(portText);
  if (port == null || port < 1 || port > 65535) {
    return 'port must be between 1 and 65535.';
  }
  return null;
}

bool _isValidHost(String host) {
  if (host.isEmpty) return false;
  if (host == 'localhost') return true;
  if (_isValidIpv4(host)) return true;
  return _isValidHostname(host);
}

bool _isValidIpv4(String host) {
  final parts = host.split('.');
  if (parts.length != 4) return false;
  return parts.every((part) {
    if (!RegExp(r'^\d{1,3}$').hasMatch(part)) return false;
    final value = int.parse(part);
    return value >= 0 && value <= 255;
  });
}

bool _isValidHostname(String host) {
  if (host.length > 253) return false;
  final normalized = host.endsWith('.') ? host.substring(0, host.length - 1) : host;
  return normalized.split('.').every((label) =>
      label.isNotEmpty &&
      label.length <= 63 &&
      RegExp(r'^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$').hasMatch(label));
}

bool _isValidIpv6Host(String host) {
  if (host.isEmpty) return false;
  try {
    Uri.parseIPv6Address(host);
    return true;
  } on FormatException {
    return false;
  }
}

String? _validateHttpHost(String value) {
  final input = value.trim();
  if (input.isEmpty) return null;
  if (input != value || RegExp(r'\s').hasMatch(input)) {
    return 'must not contain whitespace.';
  }
  if (RegExp(r'^[a-z][a-z0-9+.-]*://', caseSensitive: false).hasMatch(input) ||
      input.contains('/')) {
    return 'must be only a hostname, without a URL scheme or path.';
  }
  if (input.contains(':')) return 'must not include a port.';
  if (!_isValidHostname(input)) {
    return 'must be a valid hostname such as app.example.com.';
  }
  return null;
}

/// Validate a config, returning human-readable problems (empty = ok).
List<ValidationIssue> validateConfig(RatholeConfig config) {
  final issues = <ValidationIssue>[];

  final controlBindError = _validateHostPort(config.bindAddr, '[::]:2333');
  if (controlBindError != null) {
    issues.add(ValidationIssue(
        'bindAddr', 'Control channel bind address $controlBindError'));
  }

  final httpEnabled = config.http?.enabled ?? false;
  final letsEncryptEnabled = config.http?.letsEncrypt?.enabled ?? false;
  final httpRoutes = config.services.where(hasHttpRoute).toList();
  final letsEncryptActive =
      letsEncryptEnabled && config.services.any(hasHttpsRoute);
  if (httpEnabled || httpRoutes.isNotEmpty) {
    final httpBindAddr = config.http?.bindAddr.trim().isNotEmpty == true
        ? config.http!.bindAddr.trim()
        : httpProxyBindAddr;
    if (httpBindAddr != httpProxyBindAddr) {
      issues.add(ValidationIssue(
          'http.bindAddr', 'HTTP proxy always listens on $httpProxyBindAddr.'));
    }
  }
  if (!httpEnabled && httpRoutes.isNotEmpty) {
    issues.add(const ValidationIssue(
        'http.enabled', 'Enable the HTTP proxy before assigning HTTP hosts.'));
  }
  if (letsEncryptActive) {
    final httpsBindAddr = config.http?.httpsBindAddr?.trim().isNotEmpty == true
        ? config.http!.httpsBindAddr!.trim()
        : httpsProxyBindAddr;
    if (httpsBindAddr != httpsProxyBindAddr) {
      issues.add(ValidationIssue('http.httpsBindAddr',
          'HTTPS proxy always listens on $httpsProxyBindAddr.'));
    }
  }

  final seenHttpHosts = <String>{};
  final seen = <String>{};
  for (var i = 0; i < config.services.length; i++) {
    final svc = config.services[i];
    final base = 'services[$i]';
    final label = svc.name.isNotEmpty ? svc.name : '$i';
    if (svc.name.trim().isEmpty) {
      issues.add(ValidationIssue('$base.name', 'Service name is required.'));
    } else if (seen.contains(svc.name)) {
      issues.add(
          ValidationIssue('$base.name', 'Duplicate service name "${svc.name}".'));
    }
    seen.add(svc.name);

    if (!isHttpService(svc)) {
      final publicBindError = _validateHostPort(svc.bindAddr, '[::]:5000');
      if (publicBindError != null) {
        issues.add(ValidationIssue('$base.bindAddr',
            'Service "$label" public bind address $publicBindError'));
      }
    }

    final httpHosts = serviceHttpHosts(svc);
    if (isHttpService(svc) && httpHosts.isEmpty) {
      issues.add(ValidationIssue(
          '$base.httpHosts', 'Service "$label" needs at least one HTTP host.'));
    }
    if (httpHosts.isNotEmpty) {
      if (svc.type == 'udp') {
        issues.add(ValidationIssue('$base.httpHosts',
            'Service "$label" cannot be UDP and receive HTTP proxy traffic.'));
      }
      if (svc.type == 'tcp') {
        issues.add(ValidationIssue('$base.httpHosts',
            'Service "$label" must be HTTP or HTTPS to use an HTTP host.'));
      }
      for (var hostIndex = 0; hostIndex < httpHosts.length; hostIndex++) {
        final httpHost = httpHosts[hostIndex];
        final httpHostError = _validateHttpHost(httpHost);
        if (httpHostError != null) {
          issues.add(ValidationIssue('$base.httpHosts',
              'Service "$label" HTTP host ${hostIndex + 1} $httpHostError'));
        }
        final key = httpHost.toLowerCase();
        if (seenHttpHosts.contains(key)) {
          issues.add(ValidationIssue(
              '$base.httpHosts', 'Duplicate HTTP host "$httpHost".'));
        }
        seenHttpHosts.add(key);
      }
    }
  }

  final hasDefault = config.defaultToken?.trim().isNotEmpty ?? false;
  final missingTokens =
      config.services.where((s) => s.token?.trim().isNotEmpty != true);
  if (!hasDefault && missingTokens.isNotEmpty) {
    issues.add(const ValidationIssue(
        'defaultToken',
        'Set a default token, or give every service its own token. '
            'rathole requires a token for each service.'));
  }

  return issues;
}

// ---- client.toml generation ------------------------------------------------

String _q(String value) =>
    '"${value.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"';

String _serviceKey(String name) =>
    RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(name) ? name : _q(name);

({String host, String port}) _splitHostPort(String addr) {
  final s = addr.trim();
  if (s.startsWith('[')) {
    final end = s.indexOf(']');
    var port = s.substring(end + 2 <= s.length ? end + 2 : s.length);
    if (port.startsWith(':')) port = port.substring(1);
    return (host: s.substring(0, end + 1), port: port);
  }
  final idx = s.lastIndexOf(':');
  return idx < 0
      ? (host: s, port: '')
      : (host: s.substring(0, idx), port: s.substring(idx + 1));
}

String _remoteHost(RatholeConfig config, String? publicIp) {
  final domain = config.domain?.trim();
  if (domain != null && domain.isNotEmpty) return domain;
  if (publicIp?.trim().isNotEmpty ?? false) return publicIp!.trim();
  final host = _splitHostPort(config.bindAddr).host;
  if (host.isNotEmpty && !['0.0.0.0', '::', '[::]'].contains(host)) return host;
  return 'your-server-host';
}

String _hostPort(String host, String port) {
  final needsBrackets = host.contains(':') && !host.startsWith('[');
  return '${needsBrackets ? '[$host]' : host}:${port.isNotEmpty ? port : '2333'}';
}

String _localHint(String name) {
  final n = name.toLowerCase();
  if (n.contains('ssh')) return '127.0.0.1:22';
  if (n.contains('http') || n.contains('web')) return '127.0.0.1:80';
  if (n.contains('rdp')) return '127.0.0.1:3389';
  if (n.contains('vnc')) return '127.0.0.1:5900';
  return '127.0.0.1:8080';
}

String _serviceLocalHint(RatholeService service) =>
    hasHttpRoute(service) ? '127.0.0.1:80' : _localHint(service.name);

String _ratholeServiceType(RatholeService service) =>
    service.type == 'udp' ? 'udp' : 'tcp';

List<String> _clientGlobalLines(RatholeConfig config, String? publicIp) {
  final port = _splitHostPort(config.bindAddr).port;
  final out = [
    '[client]',
    'remote_addr = ${_q(_hostPort(_remoteHost(config, publicIp), port))}',
  ];
  if (config.defaultToken?.trim().isNotEmpty ?? false) {
    out.add('default_token = ${_q(config.defaultToken!)}');
  }
  out
    ..add('')
    ..add('[client.transport]')
    ..add('type = ${_q(config.transport)}');
  if (config.transport == 'tls' && config.tls != null) {
    out.add('[client.transport.tls]');
    final tls = config.tls!;
    if (tls.trustedRoot != null) out.add('trusted_root = ${_q(tls.trustedRoot!)}');
    if (tls.hostname != null) out.add('hostname = ${_q(tls.hostname!)}');
  } else if (config.transport == 'noise' && config.noise != null) {
    out.add('[client.transport.noise]');
    final noise = config.noise!;
    if (noise.pattern != null) out.add('pattern = ${_q(noise.pattern!)}');
    if (noise.remotePublicKey != null) {
      out.add('remote_public_key = ${_q(noise.remotePublicKey!)}');
    }
  } else if (config.transport == 'websocket') {
    out
      ..add('[client.transport.websocket]')
      ..add('tls = ${config.websocket?.tls == true ? 'true' : 'false'}');
  }
  return out;
}

List<String> _clientServiceLines(RatholeService svc) {
  final out = [
    '[client.services.${_serviceKey(svc.name)}]',
    'type = ${_q(_ratholeServiceType(svc))}',
    'local_addr = ${_q(_serviceLocalHint(svc))}',
  ];
  if (svc.token?.trim().isNotEmpty ?? false) {
    out.add('token = ${_q(svc.token!)}');
  }
  if (svc.nodelay != null) out.add('nodelay = ${svc.nodelay! ? 'true' : 'false'}');
  return out;
}

String generateClientGlobalToml(RatholeConfig config, [String? publicIp]) {
  final lines = [
    '# rathole client — global section. Run with `rathole client.toml`.',
    '',
    ..._clientGlobalLines(config, publicIp),
  ];
  return '${lines.join('\n').trimRight()}\n';
}

String generateClientServiceToml(RatholeService svc) {
  final lines = [
    '# adjust local_addr to your local service',
    ..._clientServiceLines(svc),
  ];
  return '${lines.join('\n').trimRight()}\n';
}
