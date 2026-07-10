// Dart mirror of src/shared/types.ts — the shapes exchanged with the
// rathole-manage Cloudflare Worker over REST and WebSocket.

const transportTypes = ['tcp', 'tls', 'noise', 'websocket'];
const serviceTypes = ['tcp', 'udp', 'http', 'https'];
const roles = ['admin', 'viewer'];

class TrafficStat {
  int bytesIn;
  int bytesOut;

  TrafficStat({this.bytesIn = 0, this.bytesOut = 0});

  factory TrafficStat.fromJson(Map<String, dynamic> json) => TrafficStat(
        bytesIn: (json['bytesIn'] as num?)?.toInt() ?? 0,
        bytesOut: (json['bytesOut'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() => {'bytesIn': bytesIn, 'bytesOut': bytesOut};
}

class AgentMetrics {
  final double? cpuPercent;
  final double? memoryMb;
  final int? uptimeSeconds;
  final String? ratholeVersion;
  final String? agentVersion;
  final String? hostname;
  final bool? configInSync;

  const AgentMetrics({
    this.cpuPercent,
    this.memoryMb,
    this.uptimeSeconds,
    this.ratholeVersion,
    this.agentVersion,
    this.hostname,
    this.configInSync,
  });

  factory AgentMetrics.fromJson(Map<String, dynamic> json) => AgentMetrics(
        cpuPercent: (json['cpuPercent'] as num?)?.toDouble(),
        memoryMb: (json['memoryMb'] as num?)?.toDouble(),
        uptimeSeconds: (json['uptimeSeconds'] as num?)?.toInt(),
        ratholeVersion: json['ratholeVersion'] as String?,
        agentVersion: json['agentVersion'] as String?,
        hostname: json['hostname'] as String?,
        configInSync: json['configInSync'] as bool?,
      );
}

class RatholeService {
  String name;
  String type;
  String bindAddr;
  List<String>? httpHosts;
  String? httpHost;
  String? token;
  bool? nodelay;

  RatholeService({
    required this.name,
    required this.type,
    required this.bindAddr,
    this.httpHosts,
    this.httpHost,
    this.token,
    this.nodelay,
  });

  factory RatholeService.fromJson(Map<String, dynamic> json) => RatholeService(
        name: json['name'] as String? ?? '',
        type: json['type'] as String? ?? 'tcp',
        bindAddr: json['bindAddr'] as String? ?? '',
        httpHosts: (json['httpHosts'] as List?)?.cast<String>(),
        httpHost: json['httpHost'] as String?,
        token: json['token'] as String?,
        nodelay: json['nodelay'] as bool?,
      );

  Map<String, dynamic> toJson() => {
        'name': name,
        'type': type,
        'bindAddr': bindAddr,
        if (httpHosts != null) 'httpHosts': httpHosts,
        if (httpHost != null) 'httpHost': httpHost,
        if (token != null) 'token': token,
        if (nodelay != null) 'nodelay': nodelay,
      };

  RatholeService clone() => RatholeService.fromJson(toJson());
}

class LetsEncryptConfig {
  bool enabled;
  String email;
  bool staging;

  LetsEncryptConfig({this.enabled = false, this.email = '', this.staging = false});

  factory LetsEncryptConfig.fromJson(Map<String, dynamic> json) => LetsEncryptConfig(
        enabled: json['enabled'] as bool? ?? false,
        email: json['email'] as String? ?? '',
        staging: json['staging'] as bool? ?? false,
      );

  Map<String, dynamic> toJson() =>
      {'enabled': enabled, 'email': email, 'staging': staging};
}

class HttpProxyConfig {
  bool enabled;
  String bindAddr;
  String? httpsBindAddr;
  LetsEncryptConfig? letsEncrypt;

  HttpProxyConfig({
    this.enabled = false,
    this.bindAddr = '',
    this.httpsBindAddr,
    this.letsEncrypt,
  });

  factory HttpProxyConfig.fromJson(Map<String, dynamic> json) => HttpProxyConfig(
        enabled: json['enabled'] as bool? ?? false,
        bindAddr: json['bindAddr'] as String? ?? '',
        httpsBindAddr: json['httpsBindAddr'] as String?,
        letsEncrypt: json['letsEncrypt'] == null
            ? null
            : LetsEncryptConfig.fromJson(json['letsEncrypt'] as Map<String, dynamic>),
      );

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'bindAddr': bindAddr,
        if (httpsBindAddr != null) 'httpsBindAddr': httpsBindAddr,
        if (letsEncrypt != null) 'letsEncrypt': letsEncrypt!.toJson(),
      };
}

class TlsConfig {
  String? pkcsPath;
  String? keystorePassword;
  String? trustedRoot;
  String? hostname;

  TlsConfig({this.pkcsPath, this.keystorePassword, this.trustedRoot, this.hostname});

  factory TlsConfig.fromJson(Map<String, dynamic> json) => TlsConfig(
        pkcsPath: json['pkcsPath'] as String?,
        keystorePassword: json['keystorePassword'] as String?,
        trustedRoot: json['trustedRoot'] as String?,
        hostname: json['hostname'] as String?,
      );

  Map<String, dynamic> toJson() => {
        if (pkcsPath != null) 'pkcsPath': pkcsPath,
        if (keystorePassword != null) 'keystorePassword': keystorePassword,
        if (trustedRoot != null) 'trustedRoot': trustedRoot,
        if (hostname != null) 'hostname': hostname,
      };
}

class NoiseConfig {
  String? pattern;
  String? localPrivateKey;
  String? remotePublicKey;

  NoiseConfig({this.pattern, this.localPrivateKey, this.remotePublicKey});

  factory NoiseConfig.fromJson(Map<String, dynamic> json) => NoiseConfig(
        pattern: json['pattern'] as String?,
        localPrivateKey: json['localPrivateKey'] as String?,
        remotePublicKey: json['remotePublicKey'] as String?,
      );

  Map<String, dynamic> toJson() => {
        if (pattern != null) 'pattern': pattern,
        if (localPrivateKey != null) 'localPrivateKey': localPrivateKey,
        if (remotePublicKey != null) 'remotePublicKey': remotePublicKey,
      };
}

class WebsocketConfig {
  bool? tls;

  WebsocketConfig({this.tls});

  factory WebsocketConfig.fromJson(Map<String, dynamic> json) =>
      WebsocketConfig(tls: json['tls'] as bool?);

  Map<String, dynamic> toJson() => {if (tls != null) 'tls': tls};
}

class RatholeConfig {
  String bindAddr;
  String? domain;
  String? defaultToken;
  String transport;
  TlsConfig? tls;
  NoiseConfig? noise;
  WebsocketConfig? websocket;
  HttpProxyConfig? http;
  int? heartbeatInterval;
  List<RatholeService> services;

  RatholeConfig({
    required this.bindAddr,
    this.domain,
    this.defaultToken,
    required this.transport,
    this.tls,
    this.noise,
    this.websocket,
    this.http,
    this.heartbeatInterval,
    required this.services,
  });

  factory RatholeConfig.fromJson(Map<String, dynamic> json) => RatholeConfig(
        bindAddr: json['bindAddr'] as String? ?? '',
        domain: json['domain'] as String?,
        defaultToken: json['defaultToken'] as String?,
        transport: json['transport'] as String? ?? 'tcp',
        tls: json['tls'] == null
            ? null
            : TlsConfig.fromJson(json['tls'] as Map<String, dynamic>),
        noise: json['noise'] == null
            ? null
            : NoiseConfig.fromJson(json['noise'] as Map<String, dynamic>),
        websocket: json['websocket'] == null
            ? null
            : WebsocketConfig.fromJson(json['websocket'] as Map<String, dynamic>),
        http: json['http'] == null
            ? null
            : HttpProxyConfig.fromJson(json['http'] as Map<String, dynamic>),
        heartbeatInterval: (json['heartbeatInterval'] as num?)?.toInt(),
        services: ((json['services'] as List?) ?? [])
            .map((s) => RatholeService.fromJson(s as Map<String, dynamic>))
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'bindAddr': bindAddr,
        if (domain != null) 'domain': domain,
        if (defaultToken != null) 'defaultToken': defaultToken,
        'transport': transport,
        if (tls != null) 'tls': tls!.toJson(),
        if (noise != null) 'noise': noise!.toJson(),
        if (websocket != null) 'websocket': websocket!.toJson(),
        if (http != null) 'http': http!.toJson(),
        if (heartbeatInterval != null) 'heartbeatInterval': heartbeatInterval,
        'services': services.map((s) => s.toJson()).toList(),
      };

  RatholeConfig clone() => RatholeConfig.fromJson(toJson());
}

class GlobalSettings {
  String defaultBindAddr;
  String defaultTransport;
  int? defaultHeartbeatInterval;

  GlobalSettings({
    this.defaultBindAddr = '0.0.0.0:2333',
    this.defaultTransport = 'tcp',
    this.defaultHeartbeatInterval,
  });

  factory GlobalSettings.fromJson(Map<String, dynamic> json) => GlobalSettings(
        defaultBindAddr: json['defaultBindAddr'] as String? ?? '0.0.0.0:2333',
        defaultTransport: json['defaultTransport'] as String? ?? 'tcp',
        defaultHeartbeatInterval: (json['defaultHeartbeatInterval'] as num?)?.toInt(),
      );

  Map<String, dynamic> toJson() => {
        'defaultBindAddr': defaultBindAddr,
        'defaultTransport': defaultTransport,
        'defaultHeartbeatInterval': defaultHeartbeatInterval,
      };
}

class UserView {
  final String id;
  final String username;
  final String role;
  final int createdAt;
  final int updatedAt;

  const UserView({
    required this.id,
    required this.username,
    required this.role,
    required this.createdAt,
    required this.updatedAt,
  });

  factory UserView.fromJson(Map<String, dynamic> json) => UserView(
        id: json['id'] as String,
        username: json['username'] as String,
        role: json['role'] as String? ?? 'viewer',
        createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
        updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      );
}

class InstanceView {
  final String id;
  final String name;
  final String? publicIp;
  final RatholeConfig config;
  final String status; // online | offline | unknown
  final String processState; // running | stopped | errored | unknown
  final String? desiredProcessState;
  final int? lastSeen;
  final AgentMetrics? metrics;
  final Map<String, bool>? serviceStatus;
  final Map<String, TrafficStat>? traffic;
  final Map<String, TrafficStat>? monthlyTraffic;
  final int createdAt;
  final int updatedAt;

  const InstanceView({
    required this.id,
    required this.name,
    this.publicIp,
    required this.config,
    required this.status,
    required this.processState,
    this.desiredProcessState,
    this.lastSeen,
    this.metrics,
    this.serviceStatus,
    this.traffic,
    this.monthlyTraffic,
    required this.createdAt,
    required this.updatedAt,
  });

  factory InstanceView.fromJson(Map<String, dynamic> json) => InstanceView(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        publicIp: json['publicIp'] as String?,
        config: RatholeConfig.fromJson(json['config'] as Map<String, dynamic>),
        status: json['status'] as String? ?? 'unknown',
        processState: json['processState'] as String? ?? 'unknown',
        desiredProcessState: json['desiredProcessState'] as String?,
        lastSeen: (json['lastSeen'] as num?)?.toInt(),
        metrics: json['metrics'] == null
            ? null
            : AgentMetrics.fromJson(json['metrics'] as Map<String, dynamic>),
        serviceStatus: (json['serviceStatus'] as Map<String, dynamic>?)
            ?.map((k, v) => MapEntry(k, v as bool)),
        traffic: (json['traffic'] as Map<String, dynamic>?)?.map(
            (k, v) => MapEntry(k, TrafficStat.fromJson(v as Map<String, dynamic>))),
        monthlyTraffic: (json['monthlyTraffic'] as Map<String, dynamic>?)?.map(
            (k, v) => MapEntry(k, TrafficStat.fromJson(v as Map<String, dynamic>))),
        createdAt: (json['createdAt'] as num?)?.toInt() ?? 0,
        updatedAt: (json['updatedAt'] as num?)?.toInt() ?? 0,
      );
}

class LogLine {
  final String instanceId;
  final String line;
  final String? stream; // stdout | stderr
  final int ts;

  const LogLine({
    required this.instanceId,
    required this.line,
    this.stream,
    required this.ts,
  });
}

class SessionState {
  final bool authenticated;
  final String? username;
  final String? role;

  const SessionState({this.authenticated = false, this.username, this.role});

  bool get isAdmin => role == 'admin';

  factory SessionState.fromJson(Map<String, dynamic> json) => SessionState(
        authenticated: json['authenticated'] as bool? ?? false,
        username: json['username'] as String?,
        role: json['role'] as String?,
      );
}
