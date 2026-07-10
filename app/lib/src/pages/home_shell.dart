import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import '../../main.dart';
import '../widgets/common.dart';
import 'dashboard_page.dart';
import 'settings_page.dart';
import 'users_page.dart';

/// Signed-in shell: bottom navigation between Instances / Global settings /
/// Users (admin only), with change-password and sign-out in the app bar.
class HomeShell extends StatefulWidget {
  final VoidCallback onLoggedOut;

  const HomeShell({super.key, required this.onLoggedOut});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    AppScope.of(context).connect();
  }

  @override
  void dispose() {
    AppScope.of(context).disconnect();
    super.dispose();
  }

  Future<void> _signOut() async {
    await AppScope.of(context).logout();
    if (mounted) widget.onLoggedOut();
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final theme = ShadTheme.of(context);
    final isAdmin = state.isAdmin;
    final tab = isAdmin ? _tab : 0;

    final pages = [
      const DashboardPage(),
      if (isAdmin) const SettingsPage(),
      if (isAdmin) const UsersPage(),
    ];
    final titles = ['Instances', if (isAdmin) 'Global settings', if (isAdmin) 'Users'];

    return Scaffold(
      backgroundColor: theme.colorScheme.background,
      appBar: AppBar(
        backgroundColor: theme.colorScheme.card,
        surfaceTintColor: Colors.transparent,
        shape: Border(bottom: BorderSide(color: theme.colorScheme.border)),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: theme.colorScheme.primary,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Icon(
                LucideIcons.waypoints,
                size: 16,
                color: theme.colorScheme.primaryForeground,
              ),
            ),
            const SizedBox(width: 10),
            Text(titles[tab], style: theme.textTheme.h4),
          ],
        ),
        actions: [
          ShadIconButton.ghost(
            icon: const Icon(LucideIcons.keyRound, size: 18),
            onPressed: () => showChangePasswordDialog(context),
          ),
          ShadIconButton.ghost(
            icon: const Icon(LucideIcons.logOut, size: 18),
            onPressed: _signOut,
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: IndexedStack(index: tab, children: pages),
      bottomNavigationBar: !isAdmin
          ? null
          : NavigationBar(
              selectedIndex: tab,
              backgroundColor: theme.colorScheme.card,
              indicatorColor: theme.colorScheme.primary.withValues(alpha: 0.12),
              onDestinationSelected: (i) => setState(() => _tab = i),
              destinations: const [
                NavigationDestination(
                  icon: Icon(LucideIcons.server),
                  label: 'Instances',
                ),
                NavigationDestination(
                  icon: Icon(LucideIcons.settings2),
                  label: 'Settings',
                ),
                NavigationDestination(
                  icon: Icon(LucideIcons.users),
                  label: 'Users',
                ),
              ],
            ),
    );
  }
}

Future<void> showChangePasswordDialog(BuildContext context) async {
  final state = AppScope.of(context);
  final current = TextEditingController();
  final next = TextEditingController();
  var busy = false;

  await showShadDialog<void>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (dialogContext, setState) => ShadDialog(
        title: const Text('Change password'),
        description: const Text('Update the password for your account.'),
        actions: [
          ShadButton.outline(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          ShadButton(
            onPressed: busy || current.text.isEmpty || next.text.length < 8
                ? null
                : () async {
                    setState(() => busy = true);
                    try {
                      await state.api
                          .changePassword(current.text, next.text);
                      if (dialogContext.mounted) {
                        Navigator.of(dialogContext).pop();
                        showToast(context, 'Password changed');
                      }
                    } catch (e) {
                      if (dialogContext.mounted) {
                        showToast(dialogContext, e.toString(), error: true);
                      }
                    } finally {
                      if (dialogContext.mounted) {
                        setState(() => busy = false);
                      }
                    }
                  },
            child: Text(busy ? 'Saving…' : 'Change password'),
          ),
        ],
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Field(
                label: 'Current password',
                child: ShadInput(
                  controller: current,
                  obscureText: true,
                  onChanged: (_) => setState(() {}),
                ),
              ),
              const SizedBox(height: 16),
              Field(
                label: 'New password',
                child: ShadInput(
                  controller: next,
                  obscureText: true,
                  placeholder: const Text('at least 8 characters'),
                  onChanged: (_) => setState(() {}),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
  current.dispose();
  next.dispose();
}
