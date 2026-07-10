import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import '../../main.dart';
import '../models.dart';
import '../widgets/common.dart';

/// Global settings (admin): defaults applied to newly created instances.
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  GlobalSettings _settings = GlobalSettings();
  bool _loading = true;
  bool _saving = false;

  final _bindAddr = TextEditingController();
  final _heartbeat = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _bindAddr.dispose();
    _heartbeat.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final state = AppScope.of(context);
    try {
      final settings = await state.api.getSettings();
      if (!mounted) return;
      setState(() {
        _settings = settings;
        _bindAddr.text = settings.defaultBindAddr;
        _heartbeat.text = settings.defaultHeartbeatInterval?.toString() ?? '';
        _loading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() => _loading = false);
        showToast(context, e.toString(), error: true);
      }
    }
  }

  Future<void> _save() async {
    final state = AppScope.of(context);
    setState(() => _saving = true);
    try {
      final saved = await state.api.updateSettings(_settings);
      if (!mounted) return;
      setState(() {
        _settings = saved;
        _bindAddr.text = saved.defaultBindAddr;
        _heartbeat.text = saved.defaultHeartbeatInterval?.toString() ?? '';
      });
      showToast(context, 'Global settings saved');
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          'Defaults applied when a new rathole instance is created.',
          style: theme.textTheme.muted,
        ),
        const SizedBox(height: 16),
        ShadCard(
          title: Row(
            children: [
              Icon(LucideIcons.settings2,
                  size: 16, color: theme.colorScheme.mutedForeground),
              const SizedBox(width: 8),
              const Text('Instance defaults'),
            ],
          ),
          description: const Text(
            'Existing instances are not changed. Their server configuration '
            'remains managed and distributed by the Worker. Each new instance '
            'gets an auto-generated default service token.',
          ),
          child: Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Field(
                  label: 'Control bind address',
                  child: ShadInput(
                    controller: _bindAddr,
                    enabled: !_loading,
                    autocorrect: false,
                    style: const TextStyle(fontFamily: 'monospace'),
                    onChanged: (v) => _settings.defaultBindAddr = v,
                  ),
                ),
                const SizedBox(height: 16),
                Field(
                  label: 'Transport',
                  child: ShadSelect<String>(
                    key: ValueKey('transport-${_settings.defaultTransport}'),
                    initialValue: _settings.defaultTransport,
                    enabled: !_loading,
                    options: transportTypes
                        .map((t) => ShadOption(value: t, child: Text(t)))
                        .toList(),
                    selectedOptionBuilder: (context, value) => Text(value),
                    onChanged: (v) {
                      if (v != null) {
                        setState(() => _settings.defaultTransport = v);
                      }
                    },
                  ),
                ),
                const SizedBox(height: 16),
                Field(
                  label: 'Heartbeat interval (seconds)',
                  child: ShadInput(
                    controller: _heartbeat,
                    enabled: !_loading,
                    placeholder: const Text('30'),
                    keyboardType: TextInputType.number,
                    onChanged: (v) =>
                        _settings.defaultHeartbeatInterval = int.tryParse(v),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        Align(
          alignment: Alignment.centerRight,
          child: ShadButton(
            onPressed: _loading || _saving ? null : _save,
            leading: const Icon(LucideIcons.save, size: 16),
            child: Text(_saving ? 'Saving…' : 'Save settings'),
          ),
        ),
      ],
    );
  }
}
