String formatUpdateTime(String? value) {
  if (value == null || value.trim().isEmpty) return '無資料';

  final parsed = DateTime.tryParse(value);
  if (parsed == null) return value;

  final display = parsed.isUtc ? parsed.toUtc() : parsed;
  final hour = display.hour.toString().padLeft(2, '0');
  final minute = display.minute.toString().padLeft(2, '0');
  final second = display.second.toString().padLeft(2, '0');
  return '${display.year}-${display.month}-${display.day} '
      '$hour:$minute:$second';
}

/// Formats a signed static-data manifest timestamp in Taiwan time.
///
/// Manifest values are RFC 3339 instants, so this deliberately requires an
/// explicit UTC marker or offset and does not depend on the device timezone.
String formatStaticDataUpdateTime(String? value) {
  if (value == null || value.trim().isEmpty) return '無資料';

  final match = RegExp(
    r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$',
    caseSensitive: false,
  ).firstMatch(value.trim());
  if (match == null) return '無資料';

  final year = int.parse(match[1]!);
  final month = int.parse(match[2]!);
  final day = int.parse(match[3]!);
  final hour = int.parse(match[4]!);
  final minute = int.parse(match[5]!);
  final second = int.parse(match[6]!);
  final zone = match[7]!.toUpperCase();
  if (hour > 23 || minute > 59 || second > 59) return '無資料';

  var offsetMinutes = 0;
  if (zone != 'Z') {
    final offsetHour = int.parse(zone.substring(1, 3));
    final offsetMinute = int.parse(zone.substring(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return '無資料';
    offsetMinutes = offsetHour * 60 + offsetMinute;
    if (zone.startsWith('-')) offsetMinutes = -offsetMinutes;
  }

  final wallTime = DateTime.utc(year, month, day, hour, minute, second);
  if (wallTime.year != year || wallTime.month != month || wallTime.day != day) {
    return '無資料';
  }
  final taiwanTime = wallTime
      .subtract(Duration(minutes: offsetMinutes))
      .add(const Duration(hours: 8));
  final formattedMonth = taiwanTime.month.toString().padLeft(2, '0');
  final formattedHour = taiwanTime.hour.toString().padLeft(2, '0');
  final formattedMinute = taiwanTime.minute.toString().padLeft(2, '0');
  final formattedSecond = taiwanTime.second.toString().padLeft(2, '0');
  return '${taiwanTime.year}/$formattedMonth/${taiwanTime.day} '
      '$formattedHour:$formattedMinute:$formattedSecond';
}
