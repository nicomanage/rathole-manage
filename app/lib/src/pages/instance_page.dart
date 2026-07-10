import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import '../../main.dart';
import '../config_logic.dart';
import '../models.dart';
import '../utils.dart';
import '../widgets/common.dart';

const _transports = transportTypes;
const _basicServiceTypes = ['tcp', 'udp'];
const _httpServiceTypes = ['tcp', 'udp', 'http', 'https'];

/// Instance detail: metrics, remote control, and tabs for configuration,
/// services, client config, traffic, live logs, and agent setup — the mobile
/// equivalent of the web InstanceDetail page.
class InstancePage extends StatefulWidget {
  final String instanceId;

  const InstancePage({super.key, required this.instanceId});

  @override
  State<InstancePage> createState() => _InstancePageState();
}

class _InstancePageState extends State<InstancePage> {
  String? _pendingCommand;
  String _tab = 'config';

  @override
  void initState() {
    super.initState();
    AppScope.of(context).subscribeLogs(widget.instanceId);
  }

  @override
  void dispose() {
    AppScope.of(context).unsubscribeLogs();
    super.dispose();
  }

  Future<void> _runCommand(String command) async {
    final state = AppScope.of(context);
    setState(() => _pendingCommand = command);
    try {
      final delivered =
          await state.api.sendCommand(widget.instanceId, command);
      if (!mounted) return;
      if (delivered) {
        showToast(context, '$command command sent');
      } else {
        showToast(context, 'Agent is offline', error: true);
      }
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _pendingCommand = null);
    }
  }

  Future<void> _rename(InstanceView instance) async {
    final state = AppScope.of(context);
    final controller = TextEditingController(text: instance.name);
    await showShadDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => ShadDialog(
          title: const Text('Rename node'),
          description: const Text('Set a display name for this node.'),
          actions: [
            ShadButton.outline(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            ShadButton(
              onPressed: controller.text.trim().isEmpty ||
                      controller.text == instance.name
                  ? null
                  : () async {
                      try {
                        await state.api.updateInstance(widget.instanceId,
                            name: controller.text);
                        await state.refresh();
                        if (dialogContext.mounted) {
                          Navigator.of(dialogContext).pop();
                        }
                        if (mounted) showToast(context, 'Node renamed');
                      } catch (e) {
                        if (dialogContext.mounted) {
                          showToast(dialogContext, e.toString(), error: true);
                        }
                      }
                    },
              child: const Text('Save'),
            ),
          ],
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Field(
              label: 'Node name',
              child: ShadInput(
                controller: controller,
                placeholder: const Text('edge-tokyo-01'),
                onChanged: (_) => setDialogState(() {}),
              ),
            ),
          ),
        ),
      ),
    );
    controller.dispose();
  }

  Future<void> _delete(InstanceView instance) async {
    final state = AppScope.of(context);
    final confirmed = await showShadDialog<bool>(
      context: context,
      builder: (dialogContext) => ShadDialog.alert(
        title: Text('Delete "${instance.name}"?'),
        description: const Padding(
          padding: EdgeInsets.only(bottom: 8),
          child: Text(
            'This removes the instance and disconnects its agent. The rathole '
            'process on the server is left as-is. This cannot be undone.',
          ),
        ),
        actions: [
          ShadButton.outline(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          ShadButton.destructive(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await state.api.deleteInstance(widget.instanceId);
      await state.refresh();
      if (mounted) {
        showToast(context, 'Deleted "${instance.name}"');
        Navigator.of(context).pop();
      }
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final theme = ShadTheme.of(context);
    final instance = state.instance(widget.instanceId);
    final isAdmin = state.isAdmin;

    if (instance == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Instance')),
        body: Center(
          child: Text(
            state.loading ? 'Loading instance…' : 'Instance not found.',
            style: theme.textTheme.muted,
          ),
        ),
      );
    }

    final online = instance.status == 'online';
    final running = instance.processState == 'running';
    final busy = _pendingCommand != null;

    return Scaffold(
      backgroundColor: theme.colorScheme.background,
      appBar: AppBar(
        backgroundColor: theme.colorScheme.card,
        surfaceTintColor: Colors.transparent,
        shape: Border(bottom: BorderSide(color: theme.colorScheme.border)),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            StatusDot(status: instance.status),
            const SizedBox(width: 8),
            Flexible(
              child:
                  Text(instance.name, style: theme.textTheme.h4, overflow: TextOverflow.ellipsis),
            ),
            if (isAdmin)
              ShadIconButton.ghost(
                icon: const Icon(LucideIcons.pencil, size: 16),
                onPressed: () => _rename(instance),
              ),
          ],
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              ProcessBadge(state: instance.processState),
              Text('seen ${relativeTime(instance.lastSeen)}',
                  style: theme.textTheme.muted),
              if (instance.metrics?.configInSync == false)
                const ShadBadge.destructive(child: Text('config drift')),
            ],
          ),
          if (isAdmin) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                ShadButton.outline(
                  size: ShadButtonSize.sm,
                  onPressed: !online || busy || running
                      ? null
                      : () => _runCommand('start'),
                  leading: const Icon(LucideIcons.play, size: 16),
                  child: const Text('Start'),
                ),
                ShadButton.outline(
                  size: ShadButtonSize.sm,
                  onPressed: !online || busy || !running
                      ? null
                      : () => _runCommand('restart'),
                  leading: const Icon(LucideIcons.rotateCw, size: 16),
                  child: const Text('Restart'),
                ),
                ShadButton.outline(
                  size: ShadButtonSize.sm,
                  onPressed: !online || busy || !running
                      ? null
                      : () => _runCommand('stop'),
                  leading: const Icon(LucideIcons.square, size: 16),
                  child: const Text('Stop'),
                ),
                ShadButton.outline(
                  size: ShadButtonSize.sm,
                  onPressed: () => _delete(instance),
                  foregroundColor: theme.colorScheme.destructive,
                  leading: const Icon(LucideIcons.trash2, size: 16),
                  child: const Text('Delete'),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          _MetricsRow(instance: instance),
          const SizedBox(height: 16),
          ShadTabs<String>(
            value: _tab,
            scrollable: true,
            onChanged: (v) => setState(() => _tab = v),
            tabs: const [
              ShadTab(value: 'config', child: Text('Config')),
              ShadTab(value: 'services', child: Text('Services')),
              ShadTab(value: 'client', child: Text('Client')),
              ShadTab(value: 'traffic', child: Text('Traffic')),
              ShadTab(value: 'logs', child: Text('Logs')),
              ShadTab(value: 'agent', child: Text('Agent')),
            ],
          ),
          const SizedBox(height: 16),
          if (_tab == 'config' || _tab == 'services')
            ConfigEditor(
              key: ValueKey('editor-${widget.instanceId}'),
              instanceId: widget.instanceId,
              instance: instance,
              showServices: _tab == 'services',
              canEdit: isAdmin,
            )
          else if (_tab == 'client')
            _ClientConfigTab(
                config: instance.config, publicIp: instance.publicIp)
          else if (_tab == 'traffic')
            _TrafficTab(
                monthly: instance.monthlyTraffic, live: instance.traffic)
          else if (_tab == 'logs')
            _LogsTab(instanceId: widget.instanceId)
          else
            _AgentTab(
              instanceId: widget.instanceId,
              bindAddr: instance.config.bindAddr,
              canReveal: isAdmin,
            ),
        ],
      ),
    );
  }
}

class _MetricsRow extends StatelessWidget {
  final InstanceView instance;

  const _MetricsRow({required this.instance});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    final m = instance.metrics;
    final items = [
      (
        LucideIcons.cpu,
        'CPU',
        m?.cpuPercent != null ? '${m!.cpuPercent!.toStringAsFixed(0)}%' : '—'
      ),
      (
        LucideIcons.memoryStick,
        'Memory',
        m?.memoryMb != null ? '${m!.memoryMb!.toStringAsFixed(0)} MB' : '—'
      ),
      (
        LucideIcons.clock,
        'Uptime',
        m?.uptimeSeconds != null ? formatUptime(m!.uptimeSeconds!) : '—'
      ),
      (LucideIcons.tag, 'rathole', m?.ratholeVersion ?? '—'),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 2.6,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
      children: [
        for (final (icon, label, value) in items)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: theme.colorScheme.card,
              border: Border.all(color: theme.colorScheme.border),
              borderRadius: theme.radius,
            ),
            child: Row(
              children: [
                Icon(icon, size: 16, color: theme.colorScheme.mutedForeground),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(label,
                          style:
                              theme.textTheme.muted.copyWith(fontSize: 11)),
                      Text(
                        value,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.small
                            .copyWith(fontFamily: 'monospace'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Editable working copy of the instance config, covering the Config and
/// Services tabs, with validation and Save & push — like the web ConfigEditor.
class ConfigEditor extends StatefulWidget {
  final String instanceId;
  final InstanceView instance;
  final bool showServices;
  final bool canEdit;

  const ConfigEditor({
    super.key,
    required this.instanceId,
    required this.instance,
    required this.showServices,
    required this.canEdit,
  });

  @override
  State<ConfigEditor> createState() => _ConfigEditorState();
}

class _ConfigEditorState extends State<ConfigEditor> {
  late RatholeConfig _config;
  late String _initialJson;
  bool _saving = false;

  // Controllers so text fields keep their cursor across rebuilds.
  late TextEditingController _bindAddr;
  late TextEditingController _defaultToken;
  late TextEditingController _domain;
  late TextEditingController _heartbeat;
  late TextEditingController _acmeEmail;
  final List<_ServiceControllers> _serviceControllers = [];

  @override
  void initState() {
    super.initState();
    _reset(widget.instance.config);
  }

  @override
  void didUpdateWidget(covariant ConfigEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Re-sync when the server pushes an update while we're not editing.
    final incoming = jsonEncode(widget.instance.config.toJson());
    if (!_dirty && incoming != _initialJson) {
      _disposeControllers();
      _reset(widget.instance.config);
    }
  }

  void _reset(RatholeConfig source) {
    _config = normalizeConfig(source);
    _initialJson = jsonEncode(source.toJson());
    _bindAddr = TextEditingController(text: _config.bindAddr);
    _defaultToken = TextEditingController(text: _config.defaultToken ?? '');
    _domain = TextEditingController(text: _config.domain ?? '');
    _heartbeat = TextEditingController(
        text: _config.heartbeatInterval?.toString() ?? '');
    _acmeEmail =
        TextEditingController(text: _config.http?.letsEncrypt?.email ?? '');
    _serviceControllers.clear();
    for (final svc in _config.services) {
      _serviceControllers.add(_ServiceControllers.from(svc));
    }
  }

  void _disposeControllers() {
    _bindAddr.dispose();
    _defaultToken.dispose();
    _domain.dispose();
    _heartbeat.dispose();
    _acmeEmail.dispose();
    for (final c in _serviceControllers) {
      c.dispose();
    }
  }

  @override
  void dispose() {
    _disposeControllers();
    super.dispose();
  }

  bool get _dirty => jsonEncode(_config.toJson()) != _initialJson;

  List<ValidationIssue> get _issues => validateConfig(_config);

  Map<String, String> get _issueByPath =>
      {for (final issue in _issues) issue.path: issue.message};

  HttpProxyConfig _ensureHttp() {
    return _config.http ??= HttpProxyConfig(
      enabled: false,
      bindAddr: httpProxyBindAddr,
      httpsBindAddr: httpsProxyBindAddr,
      letsEncrypt: LetsEncryptConfig(),
    );
  }

  void _setHttpEnabled(bool enabled) {
    setState(() {
      final http = _ensureHttp();
      http.enabled = enabled;
      http.bindAddr = httpProxyBindAddr;
      http.httpsBindAddr = httpsProxyBindAddr;
      if (!enabled) {
        // Turn HTTP services back into plain TCP forwards.
        for (var i = 0; i < _config.services.length; i++) {
          final svc = _config.services[i];
          if (isHttpServiceType(svc.type)) {
            svc
              ..type = 'tcp'
              ..bindAddr = restorePublicBindAddr(svc, i)
              ..httpHost = null
              ..httpHosts = null;
            _serviceControllers[i].bindAddr.text = svc.bindAddr;
            _serviceControllers[i].httpHosts.text = '';
          }
        }
      }
    });
  }

  void _setLetsEncryptEnabled(bool enabled) {
    setState(() {
      final http = _ensureHttp();
      http.letsEncrypt ??= LetsEncryptConfig();
      http.letsEncrypt!.enabled = enabled;
      if (enabled) http.enabled = true;
      http.bindAddr = httpProxyBindAddr;
      http.httpsBindAddr = httpsProxyBindAddr;
    });
  }

  void _setServiceType(int i, String type) {
    setState(() {
      final svc = _config.services[i];
      final nextType = (_config.http?.enabled ?? false) ? type : 'tcp';
      final wasHttp = isHttpServiceType(svc.type);
      svc.type = nextType;
      if (!isHttpServiceType(nextType)) {
        svc
          ..httpHost = null
          ..httpHosts = null;
        if (wasHttp) {
          svc.bindAddr = restorePublicBindAddr(svc, i);
          _serviceControllers[i].bindAddr.text = svc.bindAddr;
          _serviceControllers[i].httpHosts.text = '';
        }
      }
      _config = normalizeConfig(_config);
    });
  }

  void _addService() {
    setState(() {
      final svc = RatholeService(
        name: 'service_${_config.services.length + 1}',
        type: 'tcp',
        bindAddr: '0.0.0.0:5000',
      );
      _config.services.add(svc);
      _serviceControllers.add(_ServiceControllers.from(svc));
    });
  }

  void _removeService(int i) {
    setState(() {
      _config.services.removeAt(i);
      _serviceControllers.removeAt(i).dispose();
    });
  }

  Future<void> _save() async {
    if (_issues.isNotEmpty) {
      showToast(context, 'Fix validation issues before saving', error: true);
      return;
    }
    final state = AppScope.of(context);
    setState(() => _saving = true);
    try {
      final saved = await state.api.updateInstance(widget.instanceId,
          config: normalizeConfig(_config));
      await state.refresh();
      if (mounted) {
        setState(() {
          _disposeControllers();
          _reset(saved.config);
        });
        showToast(context, 'Configuration saved & pushed to agent');
      }
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  String _serviceState(String name) {
    final instance = widget.instance;
    if (instance.status != 'online' ||
        instance.serviceStatus == null ||
        !instance.serviceStatus!.containsKey(name)) {
      return 'unknown';
    }
    return instance.serviceStatus![name]! ? 'online' : 'offline';
  }

  @override
  Widget build(BuildContext context) {
    final issues = _issues;
    final issueByPath = _issueByPath;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!widget.showServices) ...[
          _controlChannelCard(issueByPath),
          const SizedBox(height: 12),
          _httpProxyCard(issueByPath),
        ] else
          _servicesCard(issueByPath),
        if (issues.isNotEmpty) ...[
          const SizedBox(height: 12),
          _validationCard(issues),
        ],
        if (widget.canEdit) ...[
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              if (_dirty)
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Text('Unsaved changes',
                      style: ShadTheme.of(context).textTheme.muted),
                ),
              ShadButton(
                onPressed:
                    !_dirty || _saving || issues.isNotEmpty ? null : _save,
                leading: const Icon(LucideIcons.save, size: 16),
                child: Text(_saving ? 'Saving…' : 'Save & push'),
              ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _controlChannelCard(Map<String, String> issueByPath) {
    final canEdit = widget.canEdit;
    return ShadCard(
      title: const Text('Control channel'),
      child: Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Field(
              label: 'Bind address',
              error: issueByPath['bindAddr'],
              child: ShadInput(
                controller: _bindAddr,
                enabled: canEdit,
                autocorrect: false,
                style: const TextStyle(fontFamily: 'monospace'),
                onChanged: (v) => setState(() => _config.bindAddr = v),
              ),
            ),
            const SizedBox(height: 16),
            Field(
              label: 'Default token',
              error: issueByPath['defaultToken'],
              child: ShadInput(
                controller: _defaultToken,
                enabled: canEdit,
                autocorrect: false,
                placeholder: const Text('shared secret'),
                style: const TextStyle(fontFamily: 'monospace'),
                onChanged: (v) => setState(() => _config.defaultToken = v),
              ),
            ),
            const SizedBox(height: 16),
            Field(
              label: 'Domain',
              child: ShadInput(
                controller: _domain,
                enabled: canEdit,
                autocorrect: false,
                placeholder: const Text('node.example.com'),
                style: const TextStyle(fontFamily: 'monospace'),
                onChanged: (v) => setState(() => _config.domain = v),
              ),
            ),
            const SizedBox(height: 16),
            Field(
              label: 'Transport',
              child: ShadSelect<String>(
                initialValue: _config.transport,
                enabled: canEdit,
                options: _transports
                    .map((t) => ShadOption(value: t, child: Text(t)))
                    .toList(),
                selectedOptionBuilder: (context, value) => Text(value),
                onChanged: (v) {
                  if (v != null) setState(() => _config.transport = v);
                },
              ),
            ),
            const SizedBox(height: 16),
            Field(
              label: 'Heartbeat interval (s)',
              child: ShadInput(
                controller: _heartbeat,
                enabled: canEdit,
                placeholder: const Text('30'),
                keyboardType: TextInputType.number,
                onChanged: (v) => setState(
                    () => _config.heartbeatInterval = int.tryParse(v)),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _httpProxyCard(Map<String, String> issueByPath) {
    final theme = ShadTheme.of(context);
    final canEdit = widget.canEdit;
    final http = _config.http;
    return ShadCard(
      title: Row(
        children: [
          Icon(LucideIcons.globe,
              size: 16, color: theme.colorScheme.mutedForeground),
          const SizedBox(width: 8),
          const Text('HTTP service'),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _switchRow(
              label: 'Pingora',
              value: http?.enabled ?? false,
              enabled: canEdit,
              error: issueByPath['http.enabled'],
              onChanged: _setHttpEnabled,
            ),
            const SizedBox(height: 12),
            _switchRow(
              label: "Let's Encrypt",
              icon: LucideIcons.lockKeyhole,
              value: http?.letsEncrypt?.enabled ?? false,
              enabled: canEdit,
              onChanged: _setLetsEncryptEnabled,
            ),
            const SizedBox(height: 16),
            Field(
              label: 'ACME email',
              child: ShadInput(
                controller: _acmeEmail,
                enabled: canEdit && (http?.letsEncrypt?.enabled ?? false),
                autocorrect: false,
                placeholder: const Text('admin@example.com'),
                keyboardType: TextInputType.emailAddress,
                style: const TextStyle(fontFamily: 'monospace'),
                onChanged: (v) => setState(() {
                  final h = _ensureHttp();
                  h.letsEncrypt ??= LetsEncryptConfig();
                  h.letsEncrypt!.email = v;
                }),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _switchRow({
    required String label,
    required bool value,
    required bool enabled,
    required ValueChanged<bool> onChanged,
    IconData? icon,
    String? error,
  }) {
    final theme = ShadTheme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.border),
        borderRadius: theme.radius,
      ),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: theme.colorScheme.mutedForeground),
            const SizedBox(width: 8),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: theme.textTheme.small),
                if (error != null)
                  Text(
                    error,
                    style: theme.textTheme.small.copyWith(
                        color: theme.colorScheme.destructive, fontSize: 12),
                  ),
              ],
            ),
          ),
          ShadSwitch(
            value: value,
            enabled: enabled,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }

  Widget _servicesCard(Map<String, String> issueByPath) {
    final theme = ShadTheme.of(context);
    final canEdit = widget.canEdit;
    final services = _config.services;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Services (${services.length})', style: theme.textTheme.h4),
            if (canEdit)
              ShadButton.outline(
                size: ShadButtonSize.sm,
                onPressed: _addService,
                leading: const Icon(LucideIcons.plus, size: 16),
                child: const Text('Add'),
              ),
          ],
        ),
        const SizedBox(height: 12),
        if (services.isEmpty)
          ShadCard(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text(
                'No services.'
                '${canEdit ? ' Add one to forward a port from behind NAT.' : ''}',
                style: theme.textTheme.muted,
              ),
            ),
          )
        else
          for (var i = 0; i < services.length; i++) ...[
            _serviceCard(i, issueByPath),
            if (i < services.length - 1) const SizedBox(height: 12),
          ],
      ],
    );
  }

  Widget _serviceCard(int i, Map<String, String> issueByPath) {
    final theme = ShadTheme.of(context);
    final canEdit = widget.canEdit;
    final svc = _config.services[i];
    final controllers = _serviceControllers[i];
    final httpEnabled = _config.http?.enabled ?? false;
    final serviceTypes = httpEnabled ? _httpServiceTypes : _basicServiceTypes;
    final isHttp = isHttpServiceType(svc.type);
    final traffic = widget.instance.traffic?[svc.name];
    final httpHostIssue = issueByPath['services[$i].httpHosts'] ??
        issueByPath['services[$i].httpHost'];

    return ShadCard(
      title: Row(
        children: [
          ServiceStatusDot(state: _serviceState(svc.name)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(svc.name.isEmpty ? '(unnamed)' : svc.name,
                overflow: TextOverflow.ellipsis),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text('↓ ${formatBytes(traffic?.bytesOut)}',
                  style: theme.textTheme.small.copyWith(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: successColor)),
              Text('↑ ${formatBytes(traffic?.bytesIn)}',
                  style: theme.textTheme.small.copyWith(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: theme.colorScheme.mutedForeground)),
            ],
          ),
          if (canEdit)
            ShadIconButton.ghost(
              icon: Icon(LucideIcons.trash2,
                  size: 16, color: theme.colorScheme.destructive),
              onPressed: () => _removeService(i),
            ),
        ],
      ),
      child: Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Field(
              label: 'Name',
              error: issueByPath['services[$i].name'],
              child: ShadInput(
                controller: controllers.name,
                enabled: canEdit,
                autocorrect: false,
                style: const TextStyle(fontFamily: 'monospace'),
                onChanged: (v) => setState(() => svc.name = v),
              ),
            ),
            const SizedBox(height: 12),
            Field(
              label: 'Type',
              child: ShadSelect<String>(
                key: ValueKey('type-$i-${svc.type}'),
                initialValue: svc.type,
                enabled: canEdit,
                options: serviceTypes
                    .map((t) => ShadOption(value: t, child: Text(t)))
                    .toList(),
                selectedOptionBuilder: (context, value) => Text(value),
                onChanged: (v) {
                  if (v != null) _setServiceType(i, v);
                },
              ),
            ),
            if (isHttp) ...[
              const SizedBox(height: 12),
              Field(
                label: 'HTTP hosts',
                error: httpHostIssue,
                child: ShadInput(
                  controller: controllers.httpHosts,
                  enabled: canEdit,
                  autocorrect: false,
                  placeholder: const Text('app.example.com, www.example.com'),
                  style: const TextStyle(fontFamily: 'monospace'),
                  onChanged: (v) => setState(() {
                    svc.httpHost = null;
                    svc.httpHosts = parseHttpHostsInput(v);
                  }),
                ),
              ),
            ] else ...[
              const SizedBox(height: 12),
              Field(
                label: 'Public bind (server)',
                error: issueByPath['services[$i].bindAddr'],
                child: ShadInput(
                  controller: controllers.bindAddr,
                  enabled: canEdit,
                  autocorrect: false,
                  style: const TextStyle(fontFamily: 'monospace'),
                  onChanged: (v) => setState(() => svc.bindAddr = v),
                ),
              ),
            ],
            const SizedBox(height: 12),
            Field(
              label: 'Token',
              child: ShadInput(
                controller: controllers.token,
                enabled: canEdit,
                autocorrect: false,
                placeholder: const Text('inherits default'),
                style: const TextStyle(fontFamily: 'monospace'),
                onChanged: (v) =>
                    setState(() => svc.token = v.isEmpty ? null : v),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text('nodelay', style: theme.textTheme.small),
                ShadSwitch(
                  value: svc.nodelay ?? false,
                  enabled: canEdit,
                  onChanged: (v) => setState(() => svc.nodelay = v),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _validationCard(List<ValidationIssue> issues) {
    final theme = ShadTheme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(
            color: theme.colorScheme.destructive.withValues(alpha: 0.4)),
        borderRadius: theme.radius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final issue in issues)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(LucideIcons.triangleAlert,
                      size: 14, color: theme.colorScheme.destructive),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      issue.message,
                      style: theme.textTheme.small
                          .copyWith(color: theme.colorScheme.destructive),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _ServiceControllers {
  final TextEditingController name;
  final TextEditingController httpHosts;
  final TextEditingController bindAddr;
  final TextEditingController token;

  _ServiceControllers.from(RatholeService svc)
      : name = TextEditingController(text: svc.name),
        httpHosts =
            TextEditingController(text: serviceHttpHosts(svc).join(', ')),
        bindAddr = TextEditingController(text: svc.bindAddr),
        token = TextEditingController(text: svc.token ?? '');

  void dispose() {
    name.dispose();
    httpHosts.dispose();
    bindAddr.dispose();
    token.dispose();
  }
}

class _ClientConfigTab extends StatelessWidget {
  final RatholeConfig config;
  final String? publicIp;

  const _ClientConfigTab({required this.config, this.publicIp});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    final noDomain = config.domain?.trim().isNotEmpty != true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Assemble a client.toml and run it with `rathole client.toml` on the '
          'machine behind NAT. Combine the global section with the blocks for '
          'the services you want to expose, and adjust each local_addr to your '
          'local service.'
          '${noDomain && publicIp != null ? " No domain is set, so remote_addr uses the node's public IP ($publicIp)." : ''}',
          style: theme.textTheme.muted,
        ),
        const SizedBox(height: 16),
        ShadCard(
          title: const Text('Global client config'),
          child: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: CodeBlock(
              code: generateClientGlobalToml(config, publicIp),
              filename: 'client.toml',
            ),
          ),
        ),
        const SizedBox(height: 12),
        ShadCard(
          title: Text('Service blocks (${config.services.length})'),
          child: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: config.services.isEmpty
                ? Text(
                    'No services yet. Add services in the Services tab first.',
                    style: theme.textTheme.muted,
                  )
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final svc in config.services) ...[
                        Text(svc.name,
                            style: theme.textTheme.muted.copyWith(
                                fontFamily: 'monospace', fontSize: 12)),
                        const SizedBox(height: 6),
                        CodeBlock(code: generateClientServiceToml(svc)),
                        const SizedBox(height: 12),
                      ],
                    ],
                  ),
          ),
        ),
      ],
    );
  }
}

class _TrafficTab extends StatelessWidget {
  final Map<String, TrafficStat>? monthly;
  final Map<String, TrafficStat>? live;

  const _TrafficTab({this.monthly, this.live});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    final months = (monthly ?? {}).entries.toList()
      ..sort((a, b) => b.key.compareTo(a.key));
    var liveIn = 0;
    var liveOut = 0;
    for (final t in (live ?? {}).values) {
      liveIn += t.bytesIn;
      liveOut += t.bytesOut;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ShadCard(
          title: const Text('Monthly traffic'),
          child: Padding(
            padding: const EdgeInsets.only(top: 12),
            child: months.isEmpty
                ? Text(
                    'No traffic recorded yet. Totals accumulate here per month '
                    'as the node forwards data.',
                    style: theme.textTheme.muted,
                  )
                : Column(
                    children: [
                      for (final entry in months)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(monthLabel(entry.key),
                                    style: theme.textTheme.small),
                              ),
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.end,
                                children: [
                                  Text(
                                    '↓ ${formatBytes(entry.value.bytesOut)} · ↑ ${formatBytes(entry.value.bytesIn)}',
                                    style: theme.textTheme.small.copyWith(
                                        fontFamily: 'monospace', fontSize: 12),
                                  ),
                                  Text(
                                    'total ${formatBytes(entry.value.bytesIn + entry.value.bytesOut)}',
                                    style: theme.textTheme.muted.copyWith(
                                        fontFamily: 'monospace', fontSize: 11),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
          ),
        ),
        const SizedBox(height: 12),
        Text(
          'Live counters (since the agent started): '
          '↓ ${formatBytes(liveOut)} out · ↑ ${formatBytes(liveIn)} in. '
          'Monthly totals are persisted and survive agent restarts.',
          style: theme.textTheme.muted.copyWith(fontSize: 12),
        ),
      ],
    );
  }
}

class _LogsTab extends StatefulWidget {
  final String instanceId;

  const _LogsTab({required this.instanceId});

  @override
  State<_LogsTab> createState() => _LogsTabState();
}

class _LogsTabState extends State<_LogsTab> {
  final _scroll = ScrollController();
  int _lastCount = 0;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final theme = ShadTheme.of(context);
    final logs = state.logs
        .where((l) => l.instanceId == widget.instanceId)
        .toList(growable: false);

    if (logs.length != _lastCount) {
      _lastCount = logs.length;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) {
          _scroll.jumpTo(_scroll.position.maxScrollExtent);
        }
      });
    }

    return Container(
      height: 420,
      decoration: BoxDecoration(
        color: theme.colorScheme.card,
        border: Border.all(color: theme.colorScheme.border),
        borderRadius: theme.radius,
      ),
      padding: const EdgeInsets.all(12),
      child: logs.isEmpty
          ? Text(
              'Waiting for logs… recent agent and rathole output appears here.',
              style: theme.textTheme.muted,
            )
          : ListView.builder(
              controller: _scroll,
              itemCount: logs.length,
              itemBuilder: (context, i) {
                final l = logs[i];
                return Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '${formatTime(l.ts)}  ',
                        style: TextStyle(
                            color: theme.colorScheme.mutedForeground),
                      ),
                      TextSpan(
                        text: l.line,
                        style: TextStyle(
                          color: l.stream == 'stderr'
                              ? theme.colorScheme.destructive
                              : theme.colorScheme.foreground
                                  .withValues(alpha: 0.9),
                        ),
                      ),
                    ],
                  ),
                  style: const TextStyle(
                      fontFamily: 'monospace', fontSize: 11, height: 1.5),
                );
              },
            ),
    );
  }
}

class _AgentTab extends StatefulWidget {
  final String instanceId;
  final String bindAddr;
  final bool canReveal;

  const _AgentTab({
    required this.instanceId,
    required this.bindAddr,
    required this.canReveal,
  });

  @override
  State<_AgentTab> createState() => _AgentTabState();
}

class _AgentTabState extends State<_AgentTab> {
  String? _token;

  Future<void> _reveal() async {
    final state = AppScope.of(context);
    try {
      final token = await state.api.revealToken(widget.instanceId);
      if (mounted) setState(() => _token = token);
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final theme = ShadTheme.of(context);
    final origin = state.api.baseUrl;

    final loginFlow = [
      '# on your rathole server, after installing rathole-agent:',
      'rathole-agent login    # sign in with your panel account at $origin',
      '#   → enrolls the node and connects it automatically',
    ].join('\n');

    final staticFlow = [
      '# alternative: provision this instance statically (no interactive login)',
      'export HUB_URL="$origin"',
      'export INSTANCE_ID="${widget.instanceId}"',
      'export AGENT_TOKEN="${_token ?? '<tap reveal token>'}"',
      'rathole-agent run',
    ].join('\n');

    return ShadCard(
      title: const Text('Connect the Rust agent'),
      child: Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'The agent is a small Rust binary that depends on the rathole '
              'crate, embeds a Pingora HTTP/HTTPS proxy, and runs both '
              'in-process. Nodes enroll themselves via `rathole-agent login`; '
              'this instance was created by that flow.',
              style: theme.textTheme.muted,
            ),
            const SizedBox(height: 12),
            CodeBlock(code: loginFlow, filename: 'enroll.sh'),
            if (widget.canReveal) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  ShadButton.outline(
                    size: ShadButtonSize.sm,
                    onPressed: _token == null ? _reveal : null,
                    child: Text(_token == null
                        ? 'Reveal agent token'
                        : 'Token revealed below'),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Listens on ${widget.bindAddr}',
                      style: theme.textTheme.muted.copyWith(fontSize: 12),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              CodeBlock(code: staticFlow, filename: 'agent.env'),
            ],
          ],
        ),
      ),
    );
  }
}
