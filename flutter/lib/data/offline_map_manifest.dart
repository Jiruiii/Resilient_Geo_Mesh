/// Geographic extent covered by one bundled vector map package.
class MapBounds {
  const MapBounds({
    required this.minLongitude,
    required this.minLatitude,
    required this.maxLongitude,
    required this.maxLatitude,
  });

  final double minLongitude;
  final double minLatitude;
  final double maxLongitude;
  final double maxLatitude;

  bool contains({required double longitude, required double latitude}) =>
      longitude >= minLongitude &&
      longitude <= maxLongitude &&
      latitude >= minLatitude &&
      latitude <= maxLatitude;

  Map<String, double> toJson() => <String, double>{
    'min_longitude': minLongitude,
    'min_latitude': minLatitude,
    'max_longitude': maxLongitude,
    'max_latitude': maxLatitude,
  };

  factory MapBounds.fromJson(Map<String, dynamic> json) => MapBounds(
    minLongitude: _requiredDouble(json['min_longitude'], 'min_longitude'),
    minLatitude: _requiredDouble(json['min_latitude'], 'min_latitude'),
    maxLongitude: _requiredDouble(json['max_longitude'], 'max_longitude'),
    maxLatitude: _requiredDouble(json['max_latitude'], 'max_latitude'),
  );

  @override
  bool operator ==(Object other) =>
      other is MapBounds &&
      other.minLongitude == minLongitude &&
      other.minLatitude == minLatitude &&
      other.maxLongitude == maxLongitude &&
      other.maxLatitude == maxLatitude;

  @override
  int get hashCode => Object.hash(
    minLongitude,
    minLatitude,
    maxLongitude,
    maxLatitude,
  );
}

/// Versioned metadata for one PMTiles archive bundled with the application.
class OfflineMapPackageManifest {
  const OfflineMapPackageManifest({
    required this.id,
    required this.assetPath,
    required this.fileName,
    required this.minZoom,
    required this.maxZoom,
    required this.minLongitude,
    required this.minLatitude,
    required this.maxLongitude,
    required this.maxLatitude,
    required this.sourceDate,
    required this.sha256,
  });

  final String id;
  final String assetPath;
  final String fileName;
  final int minZoom;
  final int maxZoom;
  final double minLongitude;
  final double minLatitude;
  final double maxLongitude;
  final double maxLatitude;
  final String sourceDate;
  final String sha256;

  MapBounds get bounds => MapBounds(
    minLongitude: minLongitude,
    minLatitude: minLatitude,
    maxLongitude: maxLongitude,
    maxLatitude: maxLatitude,
  );

  Map<String, dynamic> toJson() => <String, dynamic>{
    'id': id,
    'asset_path': assetPath,
    'file_name': fileName,
    'min_zoom': minZoom,
    'max_zoom': maxZoom,
    'bounds': bounds.toJson(),
    'source_date': sourceDate,
    'sha256': sha256,
  };

  factory OfflineMapPackageManifest.fromJson(Map<String, dynamic> json) {
    final boundsJson = json['bounds'];
    if (boundsJson is! Map) {
      throw const FormatException('Map package bounds are required');
    }
    final bounds = MapBounds.fromJson(
      Map<String, dynamic>.from(boundsJson),
    );

    return OfflineMapPackageManifest(
      id: _requiredString(json['id'], 'id'),
      assetPath: _requiredString(json['asset_path'], 'asset_path'),
      fileName: _requiredString(json['file_name'], 'file_name'),
      minZoom: _requiredInt(json['min_zoom'], 'min_zoom'),
      maxZoom: _requiredInt(json['max_zoom'], 'max_zoom'),
      minLongitude: bounds.minLongitude,
      minLatitude: bounds.minLatitude,
      maxLongitude: bounds.maxLongitude,
      maxLatitude: bounds.maxLatitude,
      sourceDate: _requiredString(json['source_date'], 'source_date'),
      sha256: _requiredString(json['sha256'], 'sha256'),
    );
  }
}

/// The first release ships one overview archive and four regional archives.
class OfflineMapPackageCatalog {
  const OfflineMapPackageCatalog._();

  static const _sourceDate = '2026-09-21';

  static const overview = OfflineMapPackageManifest(
    id: 'taiwan',
    assetPath: 'assets/map/pmtiles/taiwan.pmtiles',
    fileName: 'taiwan.pmtiles',
    minZoom: 0,
    maxZoom: 12,
    minLongitude: 118.0,
    minLatitude: 21.8,
    maxLongitude: 122.2,
    maxLatitude: 26.5,
    sourceDate: _sourceDate,
    sha256:
        '02fb9e86b8b4af8c9c11471510d27c65374b2f4a6f40f4900ad030603863bff5',
  );

  static const north = OfflineMapPackageManifest(
    id: 'taiwan-north',
    assetPath: 'assets/map/pmtiles/taiwan-north.pmtiles',
    fileName: 'taiwan-north.pmtiles',
    minZoom: 13,
    maxZoom: 15,
    minLongitude: 118.0,
    minLatitude: 24.0,
    maxLongitude: 122.2,
    maxLatitude: 26.5,
    sourceDate: _sourceDate,
    sha256:
        'd0a36272b6e8dd22f61fe6aa6e66589c1994c607ed8d3eac5d2d3784b372243f',
  );

  static const central = OfflineMapPackageManifest(
    id: 'taiwan-central',
    assetPath: 'assets/map/pmtiles/taiwan-central.pmtiles',
    fileName: 'taiwan-central.pmtiles',
    minZoom: 13,
    maxZoom: 15,
    minLongitude: 118.0,
    minLatitude: 23.0,
    maxLongitude: 121.6,
    maxLatitude: 24.1,
    sourceDate: _sourceDate,
    sha256:
        '25d0a1521011783e6dd981e11087eaac5c03b8e56ab5dbecd2972a2463611a9e',
  );

  static const south = OfflineMapPackageManifest(
    id: 'taiwan-south',
    assetPath: 'assets/map/pmtiles/taiwan-south.pmtiles',
    fileName: 'taiwan-south.pmtiles',
    minZoom: 13,
    maxZoom: 15,
    minLongitude: 118.0,
    minLatitude: 21.8,
    maxLongitude: 121.6,
    maxLatitude: 23.8,
    sourceDate: _sourceDate,
    sha256:
        '75f23a64c0dc97ab44c754e74353be5e08ffafa8e3957672210fc7aa1e0ac5cf',
  );

  static const east = OfflineMapPackageManifest(
    id: 'taiwan-east',
    assetPath: 'assets/map/pmtiles/taiwan-east.pmtiles',
    fileName: 'taiwan-east.pmtiles',
    minZoom: 13,
    maxZoom: 15,
    minLongitude: 120.8,
    minLatitude: 21.8,
    maxLongitude: 122.2,
    maxLatitude: 25.5,
    sourceDate: _sourceDate,
    sha256:
        'b7394239eb2df966a4dbd868b85dee0fb806562339aa61e0e6f572a61efbecc9',
  );

  static const regions = <OfflineMapPackageManifest>[north, central, south, east];

  static const all = <OfflineMapPackageManifest>[overview, ...regions];

  static OfflineMapPackageManifest byId(String id) => all.firstWhere(
    (package) => package.id == id,
    orElse: () => throw ArgumentError.value(id, 'id', 'Unknown map package'),
  );
}

String _requiredString(Object? value, String field) {
  if (value is String && value.trim().isNotEmpty) return value;
  throw FormatException('Map package $field is required');
}

int _requiredInt(Object? value, String field) {
  if (value is int) return value;
  throw FormatException('Map package $field must be an integer');
}

double _requiredDouble(Object? value, String field) {
  if (value is num) return value.toDouble();
  throw FormatException('Map package $field must be numeric');
}
