import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import '../data/government_feed_scope.dart';
import '../data/map_bridge.dart';

class GovernmentSyncScreen extends StatefulWidget {
  const GovernmentSyncScreen({
    super.key,
    required this.bridge,
    this.onWebAreaChanged,
  });
  final MapBridge bridge;
  final Future<void> Function()? onWebAreaChanged;
  @override
  State<GovernmentSyncScreen> createState() => _GovernmentSyncScreenState();
}

class _GovernmentSyncScreenState extends State<GovernmentSyncScreen> {
  final _url = TextEditingController();
  Map<String, dynamic>? _status;
  String? _error;
  bool _busy = false;
  String _area = 'all';
  Timer? _timer;
  @override
  void initState() {
    super.initState();
    _refresh(initial: true);
    if (!kIsWeb) {
      _timer = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
    }
  }

  Future<void> _refresh({bool initial = false}) async {
    try {
      if (kIsWeb) {
        final area = await loadGovernmentFeedAreaScope();
        if (mounted) setState(() => _area = area);
        return;
      }
      final status = await widget.bridge.getGovernmentSyncStatus();
      if (!mounted) return;
      setState(() {
        _status = status;
        if (initial) {
          _url.text = status['url'] as String? ?? '';
          _area = status['area'] as String? ?? 'all';
        }
      });
    } catch (_) {
      if (mounted) setState(() => _error = '暫時無法讀取更新狀態');
    }
  }

  Future<void> _saveAndSync({bool? enabled, bool sync = false}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (kIsWeb) {
        await saveGovernmentFeedAreaScope(_area);
        await widget.onWebAreaChanged?.call();
        return;
      }
      var status = await widget.bridge.configureGovernmentSync(
        url: _url.text.trim(),
        enabled: enabled ?? (_status?['enabled'] as bool? ?? true),
        area: _area,
      );
      if (sync) status = await widget.bridge.syncGovernmentNow();
      if (mounted) setState(() => _status = status);
    } catch (_) {
      if (mounted) setState(() => _error = '無法儲存或更新，請確認網址及更新服務狀態');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _url.dispose();
    super.dispose();
  }

  static const names = <String, String>{'ncdr': 'NCDR 災害警報'};
  String _time(Object? value) {
    final time = DateTime.tryParse(value?.toString() ?? '')?.toLocal();
    if (time == null) return '尚未更新';
    return '${time.year}/${time.month}/${time.day} ${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final sources = (_status?['sources'] as List?) ?? const [];
    final working = _busy || _status?['syncing'] == true;
    return Scaffold(
      appBar: AppBar(title: const Text('政府資料更新')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          if (kIsWeb)
            const Text('Web 會從目前網站的簽章 feed 下載符合警示類型與區域的資料，並保留已驗證快取供離線使用。')
          else
            const Text('此網址提供告警、醫療院所、避難所及門牌包。已驗證資料會儲存在本機，離線時繼續使用。'),
          const SizedBox(height: 16),
          if (!kIsWeb)
            TextField(
              controller: _url,
              enabled: !working,
              keyboardType: TextInputType.url,
              autocorrect: false,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: '更新服務網址',
                hintText:
                    !kIsWeb &&
                            kDebugMode &&
                            defaultTargetPlatform == TargetPlatform.android
                        ? 'http://10.0.2.2:8787/（Android 模擬器）'
                        : 'https://你的專案.pages.dev/',
                border: const OutlineInputBorder(),
              ),
            ),
          if (!kIsWeb)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('有網路時自動更新'),
              subtitle: const Text('開啟 App 時檢查；背景更新時間由手機系統安排'),
              value: _status?['enabled'] as bool? ?? true,
              onChanged:
                  working ? null : (enabled) => _saveAndSync(enabled: enabled),
            ),
          DropdownButtonFormField<String>(
            key: ValueKey<String>(_area),
            value: _area,
            decoration: InputDecoration(
              labelText: kIsWeb ? 'Web 下載範圍' : '手機下載範圍',
            ),
            items: [
              DropdownMenuItem(value: 'taipei', child: Text('雙北及全臺警報')),
              DropdownMenuItem(
                value: 'all',
                child: Text(kIsWeb ? '全臺（資料較多）' : '全臺（下載與轉傳較久）'),
              ),
            ],
            onChanged:
                working
                    ? null
                    : (value) {
                      setState(() => _area = value ?? 'all');
                      if (kIsWeb) unawaited(_saveAndSync(sync: true));
                    },
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed:
                working || !kIsWeb && _url.text.trim().isEmpty
                    ? null
                    : () => _saveAndSync(sync: true),
            icon: const Icon(Icons.cloud_download_outlined),
            label: Text(
              working
                  ? '更新中…'
                  : kIsWeb
                  ? '重新下載目前範圍'
                  : '儲存並立即更新',
            ),
          ),
          if (!kIsWeb)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                '立即更新會同步告警；首次下載或更新院所、避難所資料，請完整關閉後重新開啟 App。切換網址後，原有離線告警仍保留至到期。',
              ),
            ),
          if (working)
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: LinearProgressIndicator(),
            ),
          const SizedBox(height: 16),
          if (!kIsWeb) Text('手機最近同步：${_time(_status?['last_success'])}'),
          if (!kIsWeb && (_status?['revision'] as num? ?? 0) > 0)
            Text('資料版本：${_status!['revision']}'),
          if (_error != null || !kIsWeb && _status?['error'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _error ?? _status!['error'].toString(),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 16),
          if (!kIsWeb)
            for (final source in sources.whereType<Map>())
              Card(
                child: ListTile(
                  title: Text(names[source['id']] ?? source['id'].toString()),
                  subtitle: Text(
                    '來源最近取得：${_time(source['last_success_at'])}\n來源全臺 ${source['event_count']} 筆事件',
                  ),
                  trailing: Text(switch (source['status']) {
                    'ok' => '正常',
                    'partial' => '部分資料',
                    'stale' => '資料較舊',
                    'blocked_by_auth' => '憑證待設定',
                    _ => '暫時無法取得',
                  }),
                ),
              ),
          const SizedBox(height: 12),
          if (!kIsWeb)
            const Text('政府發布、服務收集與手機下載各有時間差；這裡顯示的是最近成功取得的資料。警報會依來源的有效期限標示過期。'),
        ],
      ),
    );
  }
}
