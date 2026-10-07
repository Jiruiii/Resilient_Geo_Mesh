import 'dart:async';
import 'dart:convert';
import 'dart:isolate';

import 'map_administrative.dart';
import 'map_models.dart';
import 'map_search.dart';
import 'map_search_asset.dart';

/// Keeps the nationwide road index and searches off Flutter's UI isolate.
/// Only the small result list crosses back; camera frames never repeat a query.
class OfflineSearchWorker {
  OfflineSearchWorker._();

  final ReceivePort _replies = ReceivePort();
  final Completer<SendPort> _ready = Completer<SendPort>();
  final Map<int, Completer<MapSearchQuery>> _pending = {};
  Isolate? _isolate;
  int _sequence = 0;
  bool _closed = false;

  static Future<OfflineSearchWorker> start(String roadJson) async {
    final worker = OfflineSearchWorker._();
    worker._replies.listen((dynamic message) {
      final response = message as List;
      final id = response[0] as int;
      if (id == 0) {
        if (response[1] is SendPort) {
          worker._ready.complete(response[1] as SendPort);
        } else {
          worker._ready.completeError(FormatException(response[1].toString()));
        }
        return;
      }
      final request = worker._pending.remove(id);
      if (request == null) return;
      if (response[1] is MapSearchQuery) {
        request.complete(response[1] as MapSearchQuery);
      } else {
        request.completeError(StateError(response[1].toString()));
      }
    });
    try {
      worker._isolate = await Isolate.spawn(_serveSearch, [
        roadJson,
        worker._replies.sendPort,
      ]);
      await worker._ready.future;
      return worker;
    } catch (_) {
      worker.close();
      rethrow;
    }
  }

  void update(
    List<StaticFeature> features,
    List<MapAdministrativeArea> areas, [
    List<TaiwanSearchEntry> addressEntries = const <TaiwanSearchEntry>[],
  ]) {
    if (!_closed) {
      _ready.future.then(
        (port) => port.send(['data', features, areas, addressEntries]),
      );
    }
  }

  Future<MapSearchQuery> search(String text) async {
    if (_closed) throw StateError('Search worker is closed');
    final port = await _ready.future;
    if (_closed) throw StateError('Search worker is closed');
    final id = ++_sequence;
    final result = Completer<MapSearchQuery>();
    _pending[id] = result;
    port.send(['query', id, text]);
    return result.future;
  }

  void close() {
    if (_closed) return;
    _closed = true;
    _isolate?.kill(priority: Isolate.immediate);
    _replies.close();
    for (final request in _pending.values) {
      request.completeError(StateError('Search worker is closed'));
    }
    _pending.clear();
  }
}

void _serveSearch(List<dynamic> arguments) {
  final replies = arguments[1] as SendPort;
  try {
    final decoded = jsonDecode(arguments[0] as String);
    final asset = TaiwanSearchAsset.fromJson(
      Map<String, dynamic>.from(decoded as Map),
    );
    var index = MapSearchIndex(const [], roadEntries: asset.entries);
    index.prepare();
    final requests = ReceivePort();
    requests.listen((dynamic message) {
      final request = message as List;
      if (request[0] == 'data') {
        index = MapSearchIndex(
          (request[1] as List).cast<StaticFeature>(),
          roadEntries: asset.entries,
          administrativeAreas:
              (request[2] as List).cast<MapAdministrativeArea>(),
          addressEntries:
              (request[3] as List).cast<TaiwanSearchEntry>(),
        );
        index.prepare();
      } else {
        try {
          replies.send([request[1], index.search(request[2] as String)]);
        } catch (error) {
          replies.send([request[1], error.toString()]);
        }
      }
    });
    replies.send([0, requests.sendPort]);
  } catch (error) {
    replies.send([0, error.toString()]);
  }
}
