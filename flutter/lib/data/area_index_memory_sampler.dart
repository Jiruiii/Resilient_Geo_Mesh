import 'area_index_memory_sampler_stub.dart'
    if (dart.library.io) 'area_index_memory_sampler_io.dart'
    if (dart.library.html) 'area_index_memory_sampler_web.dart'
    as platform;

typedef AreaIndexMemorySampler = platform.AreaIndexMemorySampler;

AreaIndexMemorySampler createAreaIndexMemorySampler() =>
    platform.createAreaIndexMemorySampler();

String get areaIndexBenchmarkPlatform => platform.platformName;
