// Small shared widgets mirroring the web panel's StatusBadge/CodeBlock.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shadcn_ui/shadcn_ui.dart';

const successColor = Color(0xFF22C55E);
const warningColor = Color(0xFFEAB308);

/// Instance status dot: green = online, gray = offline/unknown.
class StatusDot extends StatelessWidget {
  final String status;

  const StatusDot({super.key, required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    final color = switch (status) {
      'online' => successColor,
      'offline' => theme.colorScheme.destructive,
      _ => theme.colorScheme.mutedForeground.withValues(alpha: 0.4),
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// rathole process state badge.
class ProcessBadge extends StatelessWidget {
  final String state;

  const ProcessBadge({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    final text = Text(state);
    return switch (state) {
      'running' => ShadBadge(
          backgroundColor: successColor,
          child: text,
        ),
      'errored' => ShadBadge.destructive(child: text),
      'stopped' => ShadBadge.secondary(child: text),
      _ => ShadBadge.outline(child: text),
    };
  }
}

/// Per-service reachability dot: green = client connected, yellow = waiting,
/// gray = unknown.
class ServiceStatusDot extends StatelessWidget {
  final String state; // online | offline | unknown

  const ServiceStatusDot({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    final color = switch (state) {
      'online' => successColor,
      'offline' => warningColor,
      _ => theme.colorScheme.mutedForeground.withValues(alpha: 0.25),
    };
    return Container(
      width: 10,
      height: 10,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}

/// Monospace code block with a copy button, like the web CodeBlock.
class CodeBlock extends StatelessWidget {
  final String code;
  final String? filename;

  const CodeBlock({super.key, required this.code, this.filename});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: theme.colorScheme.muted.withValues(alpha: 0.5),
        border: Border.all(color: theme.colorScheme.border),
        borderRadius: theme.radius,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              if (filename != null)
                Padding(
                  padding: const EdgeInsets.only(left: 12),
                  child: Text(filename!, style: theme.textTheme.muted),
                ),
              const Spacer(),
              ShadIconButton.ghost(
                icon: const Icon(LucideIcons.copy, size: 16),
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: code));
                  showToast(context, 'Copied to clipboard');
                },
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Text(
                code.trimRight(),
                style: theme.textTheme.small.copyWith(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  height: 1.5,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

int _toastId = 0;

void showToast(BuildContext context, String message, {bool error = false}) {
  final sonner = ShadSonner.of(context);
  final id = _toastId++;
  sonner.show(
    error
        ? ShadToast.destructive(id: id, title: Text(message))
        : ShadToast(id: id, title: Text(message)),
  );
}

/// A labeled field: shadcn-style label above the input.
class Field extends StatelessWidget {
  final String label;
  final Widget child;
  final String? error;

  const Field({super.key, required this.label, required this.child, this.error});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: theme.textTheme.small),
        const SizedBox(height: 6),
        child,
        if (error != null) ...[
          const SizedBox(height: 4),
          Text(
            error!,
            style: theme.textTheme.small
                .copyWith(color: theme.colorScheme.destructive, fontSize: 12),
          ),
        ],
      ],
    );
  }
}

/// Key/value row used inside instance cards.
class KVRow extends StatelessWidget {
  final String label;
  final Widget value;

  const KVRow({super.key, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = ShadTheme.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: theme.textTheme.muted),
        Flexible(child: value),
      ],
    );
  }
}
