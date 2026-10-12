/// Converts announcement expiry values between Taiwan wall-clock time and UTC.
///
/// Official announcement deadlines are entered and displayed in Taiwan time,
/// while the signed event contract continues to store ISO 8601 UTC timestamps.
abstract final class GovernmentAnnouncementTime {
  static const Duration taiwanUtcOffset = Duration(hours: 8);

  /// Returns a UTC [DateTime] whose fields represent Taiwan local time.
  static DateTime taiwanWallClockFromUtc(DateTime value) =>
      value.toUtc().add(taiwanUtcOffset);

  /// Converts a wall-clock date/time selected in Taiwan into a UTC instant.
  static DateTime toUtcFromTaiwanWallClock(DateTime wallClock) => DateTime.utc(
    wallClock.year,
    wallClock.month,
    wallClock.day,
    wallClock.hour,
    wallClock.minute,
    wallClock.second,
    wallClock.millisecond,
    wallClock.microsecond,
  ).subtract(taiwanUtcOffset);

  /// Formats a UTC instant as `yyyy/MM/dd HH:mm:ss` in Taiwan time.
  static String formatTaiwan(DateTime value) {
    final local = taiwanWallClockFromUtc(value);
    String twoDigits(int number) => number.toString().padLeft(2, '0');

    return '${local.year}/${twoDigits(local.month)}/${twoDigits(local.day)} '
        '${twoDigits(local.hour)}:${twoDigits(local.minute)}:${twoDigits(local.second)}';
  }
}
