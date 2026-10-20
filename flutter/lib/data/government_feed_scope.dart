import 'package:shared_preferences/shared_preferences.dart';

const String governmentFeedAreaPreferenceKey = 'government_feed.area';
const String governmentFeedAreaTaipei = 'taipei';
const String governmentFeedAreaAll = 'all';

Future<String> loadGovernmentFeedAreaScope() async {
  final preferences = await SharedPreferences.getInstance();
  final value = preferences.getString(governmentFeedAreaPreferenceKey);
  return value == governmentFeedAreaTaipei
      ? governmentFeedAreaTaipei
      : governmentFeedAreaAll;
}

Future<void> saveGovernmentFeedAreaScope(String value) async {
  if (value != governmentFeedAreaTaipei && value != governmentFeedAreaAll) {
    throw ArgumentError.value(
      value,
      'value',
      'Unsupported government feed area',
    );
  }
  final preferences = await SharedPreferences.getInstance();
  await preferences.setString(governmentFeedAreaPreferenceKey, value);
}
