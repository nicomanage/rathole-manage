import 'package:flutter_test/flutter_test.dart';
import 'package:rathole_manage_app/src/config_logic.dart';
import 'package:rathole_manage_app/src/models.dart';

RatholeConfig baseConfig() => RatholeConfig(
      bindAddr: '0.0.0.0:2333',
      defaultToken: 'secret',
      transport: 'tcp',
      services: [
        RatholeService(name: 'ssh', type: 'tcp', bindAddr: '0.0.0.0:5000'),
      ],
    );

void main() {
  group('validateConfig', () {
    test('accepts a valid config', () {
      expect(validateConfig(baseConfig()), isEmpty);
    });

    test('rejects missing control bind port', () {
      final config = baseConfig()..bindAddr = '0.0.0.0';
      final issues = validateConfig(config);
      expect(issues.map((i) => i.path), contains('bindAddr'));
    });

    test('rejects bad IPv6 without brackets', () {
      final config = baseConfig()..bindAddr = '::1:2333';
      expect(validateConfig(config), isNotEmpty);
    });

    test('accepts bracketed IPv6', () {
      final config = baseConfig()..bindAddr = '[::]:2333';
      expect(validateConfig(config), isEmpty);
    });

    test('rejects duplicate service names', () {
      final config = baseConfig()
        ..services.add(
            RatholeService(name: 'ssh', type: 'tcp', bindAddr: '0.0.0.0:5001'));
      final issues = validateConfig(config);
      expect(issues.any((i) => i.message.contains('Duplicate service name')),
          isTrue);
    });

    test('requires a token somewhere', () {
      final config = baseConfig()..defaultToken = '';
      final issues = validateConfig(config);
      expect(issues.map((i) => i.path), contains('defaultToken'));
    });

    test('requires HTTP proxy for http services', () {
      final config = baseConfig()
        ..services.add(RatholeService(
            name: 'web',
            type: 'http',
            bindAddr: 'memory://web',
            httpHosts: ['app.example.com']));
      final issues = validateConfig(config);
      expect(issues.map((i) => i.path), contains('http.enabled'));
    });

    test('http service needs at least one host', () {
      final config = baseConfig()
        ..http = HttpProxyConfig(enabled: true, bindAddr: '[::]:80')
        ..services.add(RatholeService(
            name: 'web', type: 'http', bindAddr: 'memory://web'));
      final issues = validateConfig(config);
      expect(
          issues.any((i) => i.message.contains('needs at least one HTTP host')),
          isTrue);
    });

    test('rejects duplicate HTTP hosts across services', () {
      final config = baseConfig()
        ..http = HttpProxyConfig(enabled: true, bindAddr: '[::]:80')
        ..services.addAll([
          RatholeService(
              name: 'web1',
              type: 'http',
              bindAddr: 'memory://web1',
              httpHosts: ['app.example.com']),
          RatholeService(
              name: 'web2',
              type: 'http',
              bindAddr: 'memory://web2',
              httpHosts: ['APP.example.com']),
        ]);
      final issues = validateConfig(config);
      expect(issues.any((i) => i.message.contains('Duplicate HTTP host')),
          isTrue);
    });

    test('rejects invalid port range', () {
      final config = baseConfig()..services[0].bindAddr = '0.0.0.0:70000';
      expect(validateConfig(config), isNotEmpty);
    });
  });

  group('normalizeConfig', () {
    test('migrates legacy httpHost into httpHosts', () {
      final config = baseConfig()
        ..http = HttpProxyConfig(enabled: true, bindAddr: '[::]:80')
        ..services.add(RatholeService(
            name: 'web',
            type: 'http',
            bindAddr: '0.0.0.0:8080',
            httpHost: 'a.example.com, b.example.com'));
      final normalized = normalizeConfig(config);
      final web = normalized.services[1];
      expect(web.httpHost, isNull);
      expect(web.httpHosts, ['a.example.com', 'b.example.com']);
      expect(web.bindAddr, 'memory://web');
    });

    test('downgrades http services to tcp when proxy disabled', () {
      final config = baseConfig()
        ..services.add(RatholeService(
            name: 'web',
            type: 'https',
            bindAddr: 'memory://web',
            httpHosts: ['app.example.com']));
      final normalized = normalizeConfig(config);
      final web = normalized.services[1];
      expect(web.type, 'tcp');
      expect(web.httpHosts, isNull);
      expect(web.bindAddr, '0.0.0.0:5001');
    });

    test('upgrades tcp with hosts to http when proxy enabled', () {
      final config = baseConfig()
        ..http = HttpProxyConfig(enabled: true, bindAddr: '[::]:80')
        ..services[0].httpHosts = ['ssh.example.com'];
      final normalized = normalizeConfig(config);
      expect(normalized.services[0].type, 'http');
    });

    test('pins proxy bind addresses', () {
      final config = baseConfig()
        ..http = HttpProxyConfig(enabled: true, bindAddr: '0.0.0.0:8080');
      final normalized = normalizeConfig(config);
      expect(normalized.http!.bindAddr, httpProxyBindAddr);
      expect(normalized.http!.httpsBindAddr, httpsProxyBindAddr);
    });
  });

  group('client toml generation', () {
    test('uses domain as remote host', () {
      final config = baseConfig()..domain = 'node.example.com';
      final toml = generateClientGlobalToml(config);
      expect(toml, contains('remote_addr = "node.example.com:2333"'));
      expect(toml, contains('default_token = "secret"'));
      expect(toml, contains('type = "tcp"'));
    });

    test('falls back to public IP then placeholder', () {
      final config = baseConfig();
      expect(generateClientGlobalToml(config, '203.0.113.9'),
          contains('remote_addr = "203.0.113.9:2333"'));
      expect(generateClientGlobalToml(config),
          contains('remote_addr = "your-server-host:2333"'));
    });

    test('websocket transport block', () {
      final config = baseConfig()
        ..transport = 'websocket'
        ..websocket = WebsocketConfig(tls: true);
      final toml = generateClientGlobalToml(config);
      expect(toml, contains('[client.transport.websocket]'));
      expect(toml, contains('tls = true'));
    });

    test('service block includes local hint and token', () {
      final svc = RatholeService(
          name: 'ssh',
          type: 'tcp',
          bindAddr: '0.0.0.0:5000',
          token: 't0k',
          nodelay: true);
      final toml = generateClientServiceToml(svc);
      expect(toml, contains('[client.services.ssh]'));
      expect(toml, contains('local_addr = "127.0.0.1:22"'));
      expect(toml, contains('token = "t0k"'));
      expect(toml, contains('nodelay = true'));
    });

    test('quotes service keys that are not bare TOML keys', () {
      final svc = RatholeService(
          name: 'my svc', type: 'udp', bindAddr: '0.0.0.0:53');
      final toml = generateClientServiceToml(svc);
      expect(toml, contains('[client.services."my svc"]'));
      expect(toml, contains('type = "udp"'));
    });
  });

  group('parseHttpHostsInput / serviceHttpHosts', () {
    test('splits on commas, semicolons, whitespace', () {
      expect(parseHttpHostsInput('a.com, b.com; c.com d.com'),
          ['a.com', 'b.com', 'c.com', 'd.com']);
    });

    test('dedupes case-insensitively preserving first casing', () {
      final svc = RatholeService(
          name: 'web',
          type: 'http',
          bindAddr: 'memory://web',
          httpHosts: ['App.example.com'],
          httpHost: 'app.example.com, other.example.com');
      expect(serviceHttpHosts(svc), ['App.example.com', 'other.example.com']);
    });
  });
}
