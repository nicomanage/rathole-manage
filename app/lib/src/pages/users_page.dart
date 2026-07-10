import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import '../../main.dart';
import '../models.dart';
import '../utils.dart';
import '../widgets/common.dart';

/// Panel accounts (admin): create users, change roles, reset passwords,
/// delete accounts.
class UsersPage extends StatefulWidget {
  const UsersPage({super.key});

  @override
  State<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends State<UsersPage> {
  List<UserView> _users = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final state = AppScope.of(context);
    setState(() => _loading = true);
    try {
      final users = await state.api.listUsers();
      if (!mounted) return;
      setState(() {
        _users = users;
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _changeRole(UserView user, String role) async {
    final state = AppScope.of(context);
    try {
      await state.api.updateUser(user.id, role: role);
      if (mounted) showToast(context, '${user.username} is now $role');
      await _load();
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    }
  }

  Future<void> _createUser() async {
    final state = AppScope.of(context);
    final username = TextEditingController();
    final password = TextEditingController();
    var role = 'viewer';

    await showShadDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => ShadDialog(
          title: const Text('New user'),
          description: const Text('Create a panel account with a role.'),
          actions: [
            ShadButton.outline(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            ShadButton(
              onPressed: username.text.trim().isEmpty ||
                      password.text.length < 8
                  ? null
                  : () async {
                      try {
                        await state.api.createUser(
                            username.text, password.text, role);
                        if (dialogContext.mounted) {
                          Navigator.of(dialogContext).pop();
                        }
                        if (mounted) {
                          showToast(context, 'Created ${username.text}');
                        }
                        await _load();
                      } catch (e) {
                        if (dialogContext.mounted) {
                          showToast(dialogContext, e.toString(), error: true);
                        }
                      }
                    },
              child: const Text('Create'),
            ),
          ],
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Field(
                  label: 'Username',
                  child: ShadInput(
                    controller: username,
                    autocorrect: false,
                    placeholder: const Text('teammate'),
                    onChanged: (_) => setDialogState(() {}),
                  ),
                ),
                const SizedBox(height: 16),
                Field(
                  label: 'Password',
                  child: ShadInput(
                    controller: password,
                    obscureText: true,
                    placeholder: const Text('at least 8 characters'),
                    onChanged: (_) => setDialogState(() {}),
                  ),
                ),
                const SizedBox(height: 16),
                Field(
                  label: 'Role',
                  child: ShadSelect<String>(
                    initialValue: role,
                    options: roles
                        .map((r) => ShadOption(value: r, child: Text(r)))
                        .toList(),
                    selectedOptionBuilder: (context, value) => Text(value),
                    onChanged: (v) {
                      if (v != null) setDialogState(() => role = v);
                    },
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    username.dispose();
    password.dispose();
  }

  Future<void> _resetPassword(UserView user) async {
    final state = AppScope.of(context);
    final password = TextEditingController();

    await showShadDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setDialogState) => ShadDialog(
          title: const Text('Reset password'),
          description: Text('Set a new password for ${user.username}.'),
          actions: [
            ShadButton.outline(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            ShadButton(
              onPressed: password.text.length < 8
                  ? null
                  : () async {
                      try {
                        await state.api
                            .updateUser(user.id, password: password.text);
                        if (dialogContext.mounted) {
                          Navigator.of(dialogContext).pop();
                        }
                        if (mounted) {
                          showToast(
                              context, 'Password reset for ${user.username}');
                        }
                      } catch (e) {
                        if (dialogContext.mounted) {
                          showToast(dialogContext, e.toString(), error: true);
                        }
                      }
                    },
              child: const Text('Reset password'),
            ),
          ],
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Field(
              label: 'New password',
              child: ShadInput(
                controller: password,
                obscureText: true,
                placeholder: const Text('at least 8 characters'),
                onChanged: (_) => setDialogState(() {}),
              ),
            ),
          ),
        ),
      ),
    );
    password.dispose();
  }

  Future<void> _deleteUser(UserView user) async {
    final state = AppScope.of(context);
    final confirmed = await showShadDialog<bool>(
      context: context,
      builder: (dialogContext) => ShadDialog.alert(
        title: Text('Delete ${user.username}?'),
        description: const Padding(
          padding: EdgeInsets.only(bottom: 8),
          child: Text(
            'This removes the account and revokes its access. '
            'This cannot be undone.',
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
      await state.api.deleteUser(user.id);
      if (mounted) showToast(context, 'Deleted ${user.username}');
      await _load();
    } catch (e) {
      if (mounted) showToast(context, e.toString(), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    final theme = ShadTheme.of(context);
    final currentUsername = state.session.username;

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Panel accounts. Admins manage everything; viewers have '
                'read-only access.',
                style: theme.textTheme.muted,
              ),
            ),
            ShadButton(
              size: ShadButtonSize.sm,
              onPressed: _createUser,
              leading: const Icon(LucideIcons.plus, size: 16),
              child: const Text('New user'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 48),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_error != null)
          ShadCard(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 32),
              child: Column(
                children: [
                  Icon(LucideIcons.triangleAlert,
                      size: 24, color: theme.colorScheme.destructive),
                  const SizedBox(height: 12),
                  Text(_error!,
                      style: theme.textTheme.muted,
                      textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  ShadButton.outline(
                    onPressed: _load,
                    leading: const Icon(LucideIcons.refreshCw, size: 16),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          )
        else
          ..._users.map((user) {
            final isSelf = user.username == currentUsername;
            return Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: ShadCard(
                title: Row(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(user.username,
                                overflow: TextOverflow.ellipsis),
                          ),
                          if (isSelf) ...[
                            const SizedBox(width: 8),
                            const ShadBadge.secondary(child: Text('you')),
                          ],
                        ],
                      ),
                    ),
                    ShadIconButton.ghost(
                      icon: const Icon(LucideIcons.keyRound, size: 16),
                      onPressed: () => _resetPassword(user),
                    ),
                    if (!isSelf)
                      ShadIconButton.ghost(
                        icon: Icon(LucideIcons.trash2,
                            size: 16, color: theme.colorScheme.destructive),
                        onPressed: () => _deleteUser(user),
                      ),
                  ],
                ),
                child: Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Column(
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Role', style: theme.textTheme.muted),
                          ShadSelect<String>(
                            key: ValueKey('role-${user.id}-${user.role}'),
                            initialValue: user.role,
                            options: roles
                                .map((r) =>
                                    ShadOption(value: r, child: Text(r)))
                                .toList(),
                            selectedOptionBuilder: (context, value) =>
                                Text(value),
                            onChanged: (v) {
                              if (v != null && v != user.role) {
                                _changeRole(user, v);
                              }
                            },
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      KVRow(
                        label: 'Created',
                        value: Text(relativeTime(user.createdAt),
                            style: theme.textTheme.small),
                      ),
                    ],
                  ),
                ),
              ),
            );
          }),
      ],
    );
  }
}
