import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import '../../main.dart';
import '../widgets/common.dart';

/// Sign-in screen: panel URL + username/password, mirroring the web login
/// (plus the server URL, which a browser gets for free from location.origin).
class LoginPage extends StatefulWidget {
  final VoidCallback onAuthed;

  const LoginPage({super.key, required this.onAuthed});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _server = TextEditingController();
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _prefill();
  }

  Future<void> _prefill() async {
    final saved = await AppScope.of(context).savedServerUrl();
    if (saved != null && saved.isNotEmpty && mounted) {
      _server.text = saved;
    }
  }

  @override
  void dispose() {
    _server.dispose();
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      !_busy &&
      _server.text.trim().isNotEmpty &&
      _username.text.trim().isNotEmpty &&
      _password.text.isNotEmpty;

  Future<void> _submit() async {
    var server = _server.text.trim();
    if (!server.startsWith('http://') && !server.startsWith('https://')) {
      server = 'https://$server';
    }
    setState(() => _busy = true);
    try {
      final ok = await AppScope.of(context)
          .login(server, _username.text, _password.text);
      if (!mounted) return;
      if (!ok) {
        showToast(context, 'Invalid username or password', error: true);
        return;
      }
      widget.onAuthed();
    } catch (_) {
      if (mounted) showToast(context, 'Unable to sign in', error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return Scaffold(
      backgroundColor: theme.colorScheme.background,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: ShadCard(
                title: Column(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      margin: const EdgeInsets.only(bottom: 8),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.primary,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Icon(
                        LucideIcons.waypoints,
                        size: 24,
                        color: theme.colorScheme.primaryForeground,
                      ),
                    ),
                    const Text('rathole-manage', textAlign: TextAlign.center),
                  ],
                ),
                description: const Text(
                  'Sign in to manage rathole instances.',
                  textAlign: TextAlign.center,
                ),
                child: Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Field(
                        label: 'Panel URL',
                        child: ShadInput(
                          controller: _server,
                          placeholder: const Text('https://panel.example.com'),
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Field(
                        label: 'Username',
                        child: ShadInput(
                          controller: _username,
                          autocorrect: false,
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Field(
                        label: 'Password',
                        child: ShadInput(
                          controller: _password,
                          obscureText: true,
                          onChanged: (_) => setState(() {}),
                          onSubmitted: (_) {
                            if (_canSubmit) _submit();
                          },
                        ),
                      ),
                      const SizedBox(height: 20),
                      ShadButton(
                        onPressed: _canSubmit ? _submit : null,
                        child: Text(_busy ? 'Checking…' : 'Sign in'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
