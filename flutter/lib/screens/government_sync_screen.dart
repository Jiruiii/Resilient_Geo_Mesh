import 'dart:async';
import 'package:flutter/material.dart';
import '../data/map_bridge.dart';

class GovernmentSyncScreen extends StatefulWidget {
  const GovernmentSyncScreen({super.key, required this.bridge});
  final MapBridge bridge;
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
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
  }

  Future<void> _refresh({bool initial = false}) async {
    try {
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
      var status = await widget.bridge.configureGovernmentSync(
        url: _url.text.trim(),
        enabled: enabled ?? (_status?['enabled'] as bool? ?? true),
        area: _area,
      );
      if (sync) status = await widget.bridge.syncGovernmentNow();
      if (mounted) setState(() => _status = status);
    } catch (_) {
      if (mounted) setState(() => _error = '請確認更新網址是有效的 HTTPS 網址');
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

  static const names = <String, String>{
    'ncdr': 'NCDR 災害警報',
  };
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
          const Text('有網路時下載已簽章的政府資料。下載後可離線使用，並透過附近手機繼續轉傳。'),
          const SizedBox(height: 16),
          TextField(
            controller: _url,
            enabled: !working,
            keyboardType: TextInputType.url,
            autocorrect: false,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: '更新服務網址',
              hintText: 'https://你的專案.pages.dev/',
              border: OutlineInputBorder(),
            ),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('有網路時自動更新'),
            subtitle: const Text('開啟 App 時檢查；背景更新時間由手機系統安排'),
            value: _status?['enabled'] as bool? ?? true,
            onChanged:
                working ? null : (enabled) => _saveAndSync(enabled: enabled),
          ),
          DropdownButtonFormField<String>(
            value: _area,
            decoration: const InputDecoration(labelText: '手機下載範圍'),
            items: const [
              DropdownMenuItem(value: 'taipei', child: Text('雙北及全臺警報')),
              DropdownMenuItem(value: 'all', child: Text('全臺（下載與轉傳較久）')),
            ],
            onChanged:
                working
                    ? null
                    : (value) => setState(() => _area = value ?? 'all'),
          ),
          const SizedBox(height: 12),
          FilledButton.icon(
            onPressed:
                working || _url.text.trim().isEmpty
                    ? null
                    : () => _saveAndSync(sync: true),
            icon: const Icon(Icons.cloud_download_outlined),
            label: Text(working ? '更新中…' : '儲存並立即更新'),
          ),
          if (working)
            const Padding(
              padding: EdgeInsets.only(top: 12),
              child: LinearProgressIndicator(),
            ),
          const SizedBox(height: 16),
          Text('手機最近同步：${_time(_status?['last_success'])}'),
          if ((_status?['revision'] as num? ?? 0) > 0)
            Text('資料版本：${_status!['revision']}'),
          if (_error != null || _status?['error'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _error ?? _status!['error'].toString(),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          const SizedBox(height: 16),
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
          const Text('政府發布、服務收集與手機下載各有時間差；這裡顯示的是最近成功取得的資料。警報會依來源的有效期限標示過期。'),
        ],
      ),
    );
  }
}
