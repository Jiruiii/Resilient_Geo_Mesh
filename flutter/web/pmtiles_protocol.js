(function () {
  var registered = false;
  var protocol = null;
  var preparedArchives = new Map();

  function MemorySource(url, buffer) {
    this.url = url;
    this.buffer = buffer;
  }

  MemorySource.prototype.getKey = function () {
    return this.url;
  };

  MemorySource.prototype.getBytes = function (offset, length) {
    return Promise.resolve({
      data: this.buffer.slice(offset, offset + length),
    });
  };

  function archiveUrlFor(requestUrl) {
    var match = requestUrl.match(/^pmtiles:\/\/(.+)\/\d+\/\d+\/\d+$/);
    return match ? match[1] : null;
  }

  function prepareArchive(url) {
    var existing = preparedArchives.get(url);
    if (existing) return existing;

    // Flutter's web asset server may answer Range requests with a complete
    // 200 response. Load only the archive that is actually requested, then
    // let PMTiles read byte slices from this in-memory source.
    var initialRequest = fetch(url, { headers: { Range: 'bytes=0-16383' } });
    var prepared = initialRequest.then(function (response) {
      var contentRange = response.headers.get('Content-Range') || '';
      var supportsRanges =
        response.status === 206 && /^bytes \d+-\d+\/\d+$/.test(contentRange);
      if (supportsRanges) {
        // Only a small probe was requested; the PMTiles reader now fetches
        // the directory and tile ranges it needs, never the complete archive.
        if (response.body) return response.body.cancel();
        return;
      }
      if (!response.ok) {
        throw new Error('Unable to load PMTiles asset: ' + response.status);
      }
      return response.arrayBuffer().then(function (buffer) {
        protocol.add(
          new globalThis.pmtiles.PMTiles(new MemorySource(url, buffer)),
        );
      });
    });
    preparedArchives.set(url, prepared);
    prepared.catch(function () {
      preparedArchives.delete(url);
    });
    return prepared;
  }

  function tileWithFlutterAssetFallback(request, abortController) {
    var url = archiveUrlFor(request.url);
    if (!url) {
      return protocol.tile(request, abortController);
    }
    return prepareArchive(url).then(function () {
      return protocol.tile(request, abortController);
    });
  }

  window.registerProtomapsProtocol = function () {
    if (registered) {
      return true;
    }

    var maplibre = globalThis.maplibregl;
    var pmtilesNamespace = globalThis.pmtiles;
    if (!maplibre || !pmtilesNamespace || !pmtilesNamespace.Protocol) {
      return false;
    }

    protocol = new pmtilesNamespace.Protocol();
    maplibre.addProtocol('pmtiles', tileWithFlutterAssetFallback);
    registered = true;
    return true;
  };
})();
