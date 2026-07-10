import 'package:flutter/material.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

import 'src/app_state.dart';
import 'src/pages/home_shell.dart';
import 'src/pages/login_page.dart';

void main() {
  runApp(RatholeManageApp(state: AppState()));
}

class RatholeManageApp extends StatelessWidget {
  final AppState state;

  const RatholeManageApp({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: ShadApp.custom(
        theme: ShadThemeData(
          brightness: Brightness.light,
          colorScheme: const ShadZincColorScheme.light(),
        ),
        darkTheme: ShadThemeData(
          brightness: Brightness.dark,
          colorScheme: const ShadZincColorScheme.dark(),
        ),
        themeMode: ThemeMode.system,
        appBuilder: (context) {
          return MaterialApp(
            title: 'rathole-manage',
            debugShowCheckedModeBanner: false,
            theme: Theme.of(context),
            builder: (context, child) => ShadAppBuilder(
              child: ShadSonner(child: child!),
            ),
            home: const RootGate(),
          );
        },
      ),
    );
  }
}

/// Exposes the single [AppState] to the widget tree.
class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child})
      : super(notifier: state);

  static AppState of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

/// Boot flow: restore saved session -> home, otherwise login.
class RootGate extends StatefulWidget {
  const RootGate({super.key});

  @override
  State<RootGate> createState() => _RootGateState();
}

class _RootGateState extends State<RootGate> {
  bool _checking = true;
  bool _authed = false;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final state = AppScope.of(context);
    final ok = await state.restore();
    if (!mounted) return;
    setState(() {
      _checking = false;
      _authed = ok;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_checking) {
      final theme = ShadTheme.of(context);
      return Scaffold(
        body: Center(
          child: Text('Loading…', style: theme.textTheme.muted),
        ),
      );
    }
    if (!_authed) {
      return LoginPage(onAuthed: () => setState(() => _authed = true));
    }
    return HomeShell(onLoggedOut: () => setState(() => _authed = false));
  }
}
