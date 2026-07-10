import 'dart:math' as math;

/// Human-readable byte count, e.g. 1536 -> "1.5 KB".
String formatBytes(int? bytes) {
  if (bytes == null || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  final i = math.min(
      (math.log(bytes) / math.log(1024)).floor(), units.length - 1);
  final value = bytes / math.pow(1024, i);
  final text = value >= 100 || i == 0 ? value.round().toString() : value.toStringAsFixed(1);
  return '$text ${units[i]}';
}

String relativeTime(int? ts) {
  if (ts == null || ts == 0) return 'never';
  final diff = DateTime.now().millisecondsSinceEpoch - ts;
  if (diff < 5000) return 'just now';
  if (diff < 60000) return '${diff ~/ 1000}s ago';
  if (diff < 3600000) return '${diff ~/ 60000}m ago';
  if (diff < 86400000) return '${diff ~/ 3600000}h ago';
  return '${diff ~/ 86400000}d ago';
}

String formatUptime(int s) {
  if (s < 60) return '${s}s';
  if (s < 3600) return '${s ~/ 60}m';
  if (s < 86400) return '${s ~/ 3600}h';
  return '${s ~/ 86400}d';
}

const _monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/// "2026-07" -> "July 2026".
String monthLabel(String key) {
  final parts = key.split('-');
  if (parts.length != 2) return key;
  final y = int.tryParse(parts[0]);
  final m = int.tryParse(parts[1]);
  if (y == null || m == null || m < 1 || m > 12) return key;
  return '${_monthNames[m - 1]} $y';
}

String formatTime(int ts) {
  final d = DateTime.fromMillisecondsSinceEpoch(ts);
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(d.hour)}:${two(d.minute)}:${two(d.second)}';
}
