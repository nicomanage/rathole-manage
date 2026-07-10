import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import '../../main.dart';
import '../app_state.dart';
import '../models.dart';
import '../utils.dart';
import '../widgets/common.dart';
import 'instance_page.dart';

/// Instance list, mirroring the web Dashboard: live connection indicator and
/// one card per managed instance.
class DashboardPage extends StatelessWidget {
  const DashboardPage({super.key});

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final theme = ShadTheme.of(context);
    final instances = state.instances;

    return RefreshIndicator(
      onRefresh: state.refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Icon(
                state.conn == ConnState.open
                    ? LucideIcons.wifi
                    : LucideIcons.wifiOff,
                size: 14,
                color: state.conn == ConnState.open
                    ? successColor
                    : theme.colorScheme.mutedForeground,
              ),
              const SizedBox(width: 6),
              Text(
                state.conn == ConnState.open ? 'Live' : 'Reconnecting…',
                style: theme.textTheme.muted,
              ),
              Text(
                ' · ${state.loading ? 'Loading instances…' : '${instances.length} managed'}',
                style: theme.textTheme.muted,
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (state.loading)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 48),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (state.loadError != null)
            _ErrorCard(message: state.loadError!, onRetry: state.refresh)
          else if (instances.isEmpty)
            const _EmptyCard()
          else
            ...instances.map((inst) => Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: _InstanceCard(instance: inst),
                )),
        ],
      ),
    );
  }
}

class _InstanceCard extends StatelessWidget {
  final InstanceView instance;

  const _InstanceCard({required this.instance});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    final domain = instance.config.domain?.trim();
    final endpoint =
        (domain != null && domain.isNotEmpty) ? domain : instance.config.bindAddr;

    return GestureDetector(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => InstancePage(instanceId: instance.id),
        ),
      ),
      child: ShadCard(
        title: Row(
          children: [
            StatusDot(status: instance.status),
            const SizedBox(width: 8),
            Expanded(
              child: Text(instance.name, overflow: TextOverflow.ellipsis),
            ),
            Icon(
              LucideIcons.chevronRight,
              size: 16,
              color: theme.colorScheme.mutedForeground,
            ),
          ],
        ),
        child: Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Column(
            children: [
              KVRow(
                label: 'Process',
                value: ProcessBadge(state: instance.processState),
              ),
              const SizedBox(height: 10),
              KVRow(
                label: 'Services',
                value: ShadBadge.secondary(
                  child: Text('${instance.config.services.length}'),
                ),
              ),
              const SizedBox(height: 10),
              KVRow(
                label: (domain != null && domain.isNotEmpty) ? 'Domain' : 'Bind',
                value: Text(
                  endpoint,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.small
                      .copyWith(fontFamily: 'monospace', fontSize: 12),
                ),
              ),
              const SizedBox(height: 10),
              KVRow(
                label: 'Last seen',
                value: Text(
                  relativeTime(instance.lastSeen),
                  style: theme.textTheme.small,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ErrorCard extends StatelessWidget {
  final String message;
  final Future<void> Function() onRetry;

  const _ErrorCard({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return ShadCard(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Column(
          children: [
            Icon(LucideIcons.triangleAlert,
                size: 32, color: theme.colorScheme.destructive),
            const SizedBox(height: 12),
            Text('Failed to load instances', style: theme.textTheme.p),
            const SizedBox(height: 4),
            Text(
              message,
              style: theme.textTheme.muted,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 16),
            ShadButton.outline(
              onPressed: onRetry,
              leading: const Icon(LucideIcons.refreshCw, size: 16),
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyCard extends StatelessWidget {
  const _EmptyCard();

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return ShadCard(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 32),
        child: Column(
          children: [
            Icon(LucideIcons.server,
                size: 32, color: theme.colorScheme.mutedForeground),
            const SizedBox(height: 12),
            Text('No instances yet', style: theme.textTheme.p),
            const SizedBox(height: 4),
            Text(
              'Instances register themselves. On your rathole server run '
              '`rathole-agent login`, sign in with your panel account, and the '
              'node self-enrolls and appears here automatically.',
              style: theme.textTheme.muted,
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}
